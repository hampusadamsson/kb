// kb's ticket operations as MCP tools.
//
// Every tool is a thin translation layer over `handleApi`: the same request objects the web server
// builds become tool arguments, and the same `ApiResponse` becomes a tool result. No ticket logic
// lives here — only argument shaping, result rendering and error text.
import path from "node:path";
import { type ApiContext, type ApiResponse, handleApi } from "../api/api.js";
import { createKanban, type Kanban, type KbEventSource } from "../core/index.js";
import { createEventLog } from "../eventLog.js";
import { LiveRuns } from "../liveRuns.js";
import { createShellRunner } from "../runner.js";
import { runServer, type ToolCallResult, type ToolDefinition } from "./protocol.js";

const WARN = "⚠ ";
const DEFAULT_SEARCH_LIMIT = 20;

const INSTRUCTIONS = [
  "A kb board is a directory of markdown tickets: YAML frontmatter holds id, status, labels and properties, the markdown body holds the description.",
  "`status` is the column; moving a ticket between columns is kb_move. Ids look like 001 and a short id such as 7 matches 007.",
  "Search first (kb_search) to find ids, then kb_read before kb_update/kb_move; pass the mtime from kb_read to detect concurrent edits.",
  "Automations run in the background after writes, so kb_create/kb_update/kb_move return before they finish — poll kb_read or kb_automations.",
].join("\n");

// ---- context ----

export interface ToolContext {
  /**
   * A fresh Kanban view, built per tool call. Cheap (re-reads kanban.yaml and the ticket files) and it
   * keeps tools consistent with the web server, which also builds one per request.
   */
  kanban(): Kanban;
  /** handed to `handleApi` as-is (runner, event log, dir, ...) */
  api?: ApiContext;
}

// ---- small helpers ----

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const strList = (v: unknown): unknown => {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
  return undefined;
};

/** Core warnings are objects ({kind, path, message}); tools advertise them as plain strings. */
function warningsOf(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.warnings)) return [];
  return body.warnings.map((w) => {
    if (typeof w === "string") return w;
    if (isRecord(w)) {
      const message = str(w.message) ?? JSON.stringify(w);
      const p = str(w.path);
      return p ? `${p}: ${message}` : message;
    }
    return String(w);
  });
}

function success(body: unknown, text: string, warnings: string[] = warningsOf(body)): ToolCallResult {
  const structuredContent = isRecord(body) ? { ...body, warnings } : { value: body, warnings };
  const text_ = [text, ...warnings.map((w) => WARN + w)].filter((l) => l !== "").join("\n");
  return { content: [{ type: "text", text: text_ }], structuredContent };
}

/** Maps an ApiResponse failure onto actionable text. Never throws, never sets isError on warnings. */
function failureText(code: string, message: string): string {
  switch (code) {
    case "not-found":
      return `${message}\nNo ticket has that id. Use kb_search (text/label/board) to find the right id, then kb_read.`;
    case "ambiguous":
      return `${message}\nmultiple tickets match, pass board`;
    case "invalid":
      return message;
    case "exists":
      return `${message}\nThat id or file is already taken; use kb_update to change the existing ticket, or create with another id.`;
    case "parse":
      return `${message}\nThe ticket file or its frontmatter is unparsable; fix the YAML, then re-check with kb_validate.`;
    case "config":
      return `${message}\nkanban.yaml is not usable; fix it, then run kb_validate for the full list of problems.`;
    case "stale":
      return `${message}\nThe ticket changed on disk since you read it; re-read it with kb_read and retry with the current mtime.`;
    default:
      return message;
  }
}

function failure(status: number, body: unknown): ToolCallResult {
  const rec = isRecord(body) ? body : {};
  const error = str(rec.error) ?? `request failed with status ${status}`;
  const code = str(rec.code) ?? "internal";
  return {
    isError: true,
    content: [{ type: "text", text: failureText(code, error) }],
    structuredContent: { error, code },
  };
}

const isOk = (status: number): boolean => status >= 200 && status < 300;

interface TicketViewLike {
  id?: unknown;
  name?: string;
  status?: string | null;
  board?: string | null;
  column?: string;
  labels?: string[];
  path?: string;
  mtime?: number;
}

function ticketLine(t: TicketViewLike): string {
  const id = t.id === undefined || t.id === null ? "?" : String(t.id);
  const labels = t.labels?.length ? ` · ${t.labels.join(",")}` : "";
  return `#${id} [${t.status ?? "?"}] ${t.name ?? ""} · ${t.board ?? "?"}${labels}`;
}

/** Flattens the `GET /api/board` payload into per-ticket views, in column order. */
function boardTickets(body: unknown): TicketViewLike[] {
  const out: TicketViewLike[] = [];
  const boards = isRecord(body) && Array.isArray(body.boards) ? body.boards : [];
  for (const b of boards) {
    if (!isRecord(b)) continue;
    for (const c of Array.isArray(b.columns) ? b.columns : []) {
      if (isRecord(c) && Array.isArray(c.tickets)) out.push(...(c.tickets as TicketViewLike[]));
    }
    if (Array.isArray(b.unsorted)) out.push(...(b.unsorted as TicketViewLike[]));
  }
  return out;
}

const annotations = (
  readOnlyHint: boolean,
  destructiveHint: boolean,
  idempotentHint: boolean,
): { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean } => ({
  readOnlyHint,
  destructiveHint,
  idempotentHint,
});

const OPEN = { type: "object", properties: {}, additionalProperties: false } as const;

const ID_SCHEMA = {
  type: "string",
  description: 'Ticket id, e.g. "7" or "007" (a short id matches its zero-padded form)',
} as const;

// ---- tools ----

export function createTools(ctx: ToolContext): ToolDefinition[] {
  const call = (
    method: string,
    reqPath: string,
    opts: { query?: URLSearchParams; body?: Record<string, unknown> } = {},
  ): Promise<ApiResponse> =>
    handleApi(ctx.kanban(), { method, path: reqPath, query: opts.query ?? new URLSearchParams(), body: opts.body ?? {} }, ctx.api ?? {});

  const ticketPath = (args: Record<string, unknown>, suffix = ""): string | undefined => {
    const id = str(args.id);
    return id === undefined || id === "" ? undefined : `/api/tickets/${encodeURIComponent(id)}${suffix}`;
  };

  const missingId = (): ToolCallResult => failure(400, { error: "id is required", code: "invalid" });

  return [
    {
      name: "kb_boards",
      description: "List boards and their columns (no tickets).",
      inputSchema: OPEN,
      annotations: annotations(true, false, true),
      handler: async () => {
        const r = await call("GET", "/api/board");
        if (!isOk(r.status)) return failure(r.status, r.body);
        const body = isRecord(r.body) ? r.body : {};
        const columns = isRecord(body.columns) ? body.columns : {};
        const names = Array.isArray(body.boardNames) ? body.boardNames.filter((n): n is string => typeof n === "string") : [];
        const boards = names.map((name) => ({
          name,
          columns: Array.isArray(columns[name]) ? (columns[name] as string[]) : [],
        }));
        const text = [`kb ${str(body.name) ?? ""}`.trim(), ...boards.map((b) => `- ${b.name}: ${b.columns.join(", ")}`)].join("\n");
        return success({ name: body.name ?? null, boards }, text, warningsOf(r.body));
      },
    },
    {
      name: "kb_search",
      description: "Search tickets by text, board, label or property; returns compact summaries (no bodies).",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "case-insensitive text match over name/body/labels" },
          board: { type: "string", description: "restrict to one board" },
          label: {
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
            description: "require this label (or all of these labels)",
          },
          property: {
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
            description: 'frontmatter property filter, e.g. "priority" or "priority=high"',
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            default: DEFAULT_SEARCH_LIMIT,
            description: "maximum summaries to return",
          },
        },
        additionalProperties: false,
      },
      annotations: annotations(true, false, true),
      handler: async (args) => {
        const query = new URLSearchParams();
        if (str(args.text)) query.set("text", str(args.text) as string);
        if (str(args.board)) query.set("board", str(args.board) as string);
        for (const l of (strList(args.label) as string[] | undefined) ?? []) query.append("label", l);
        for (const p of (strList(args.property) as string[] | undefined) ?? []) query.append("property", p);
        const limit =
          typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.max(1, Math.trunc(args.limit)) : DEFAULT_SEARCH_LIMIT;
        const r = await call("GET", "/api/board", { query });
        if (!isOk(r.status)) return failure(r.status, r.body);
        const all = boardTickets(r.body).map((t) => ({
          id: t.id ?? null,
          name: t.name ?? "",
          status: t.status ?? null,
          board: t.board ?? null,
          labels: t.labels ?? [],
        }));
        const shown = all.slice(0, limit);
        const head =
          all.length === 0
            ? "no tickets matched"
            : `${shown.length} of ${all.length} match${all.length === 1 ? "" : "es"}${
                all.length > limit ? ` (limit ${limit}; narrow the query or raise limit)` : ""
              }`;
        const text = [head, ...shown.map((t) => ticketLine(t))].join("\n");
        return success({ tickets: shown, total: all.length, limit, truncated: all.length > limit }, text, warningsOf(r.body));
      },
    },
    {
      name: "kb_read",
      description: "Read one ticket: frontmatter, body, comments and automation status.",
      inputSchema: { type: "object", properties: { id: ID_SCHEMA }, required: ["id"], additionalProperties: false },
      annotations: annotations(true, false, true),
      handler: async (args) => {
        const p = ticketPath(args);
        if (!p) return missingId();
        const r = await call("GET", p);
        if (!isOk(r.status)) return failure(r.status, r.body);
        const t = (isRecord(r.body) ? r.body : {}) as TicketViewLike & {
          body?: unknown;
          comments?: unknown;
          autos?: unknown;
        };
        const labels = t.labels?.length ? ` · labels: ${t.labels.join(", ")}` : "";
        const autos = Array.isArray(t.autos) ? t.autos.filter(isRecord).map((a) => `${str(a.name) ?? "?"}=${str(a.status) ?? "?"}`) : [];
        const lines = [
          ticketLine(t),
          `column: ${t.column ?? "?"} · mtime: ${t.mtime ?? "?"}${labels}`,
          ...(autos.length ? [`automations: ${autos.join(", ")}`] : []),
          "",
          typeof t.body === "string" && t.body.trim() !== "" ? t.body.trim() : "(no body)",
        ];
        if (isRecord(t.comments)) {
          const entries = Object.entries(t.comments).filter((e): e is [string, string] => typeof e[1] === "string");
          if (entries.length) {
            lines.push("", `comments (${entries.length}):`);
            for (const [key, value] of entries) lines.push(`-- ${key}: ${value.trim()}`);
          }
        }
        return success(r.body, lines.join("\n"));
      },
    },
    {
      name: "kb_create",
      description: "Create a ticket.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "ticket title" },
          status: { type: "string", description: "column to place it in (default: the board's first column)" },
          board: { type: "string", description: "board name (default: the primary board)" },
          labels: { type: "array", items: { type: "string" } },
          properties: { type: "object", additionalProperties: true, description: "frontmatter properties" },
          body: { type: "string", description: "markdown body" },
          comment: { type: "string", description: "initial comment" },
          file: { type: "string", description: "relative path for the new file (default: <id>-<slug>.md)" },
          id: { type: "string", description: "explicit id (default: next free number)" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      annotations: annotations(false, false, false),
      handler: async (args) => {
        const body: Record<string, unknown> = { name: args.name };
        for (const k of ["status", "board", "properties", "body", "comment", "file", "id"] as const) {
          if (args[k] !== undefined) body[k] = args[k];
        }
        const labels = strList(args.labels);
        if (labels !== undefined) body.labels = labels;
        const r = await call("POST", "/api/tickets", { body });
        if (!isOk(r.status)) return failure(r.status, r.body);
        const rec = isRecord(r.body) ? r.body : {};
        return success(r.body, `created #${str(rec.id) ?? "?"} (${str(rec.path) ?? "?"})`);
      },
    },
    {
      name: "kb_update",
      description: "Update a ticket's name, status, board, labels, properties, body or add a comment.",
      inputSchema: {
        type: "object",
        properties: {
          id: ID_SCHEMA,
          name: { type: "string" },
          status: { type: "string", description: "move to this column" },
          board: { type: "string" },
          addLabels: { type: "array", items: { type: "string" } },
          removeLabels: { type: "array", items: { type: "string" } },
          setProps: { type: "object", additionalProperties: true },
          unsetProps: { type: "array", items: { type: "string" } },
          body: { type: "string", description: "replaces the whole body" },
          comment: { type: "string", description: "appends a comment" },
          mtime: { type: "number", description: "mtime from kb_read; rejects the write if the file changed since" },
          resetAutomations: { type: "boolean", description: "clear the automation run history (loop guard counter)" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      annotations: annotations(false, true, true),
      handler: async (args) => {
        const p = ticketPath(args);
        if (!p) return missingId();
        const body: Record<string, unknown> = {};
        for (const k of ["name", "status", "board", "setProps", "unsetProps", "body", "comment", "mtime", "resetAutomations"] as const) {
          if (args[k] !== undefined) body[k] = args[k];
        }
        for (const k of ["addLabels", "removeLabels"] as const) {
          const v = strList(args[k]);
          if (v !== undefined) body[k] = v;
        }
        const r = await call("PATCH", p, { body });
        if (!isOk(r.status)) return failure(r.status, r.body);
        const rec = isRecord(r.body) ? r.body : {};
        return success(r.body, `updated #${str(args.id) ?? "?"} (mtime ${String(rec.mtime ?? "?")})`);
      },
    },
    {
      name: "kb_move",
      description: "Move a ticket to another column (sets status only).",
      inputSchema: {
        type: "object",
        properties: {
          id: ID_SCHEMA,
          status: { type: "string", description: "target column" },
          mtime: { type: "number", description: "mtime from kb_read; rejects the write if the file changed since" },
        },
        required: ["id", "status"],
        additionalProperties: false,
      },
      annotations: annotations(false, true, true),
      handler: async (args) => {
        const p = ticketPath(args);
        if (!p) return missingId();
        if (str(args.status) === undefined) return failure(400, { error: "status is required", code: "invalid" });
        const body: Record<string, unknown> = { status: args.status };
        if (args.mtime !== undefined) body.mtime = args.mtime;
        const r = await call("PATCH", p, { body });
        if (!isOk(r.status)) return failure(r.status, r.body);
        const rec = isRecord(r.body) ? r.body : {};
        return success(r.body, `moved #${str(args.id) ?? "?"} to ${str(args.status)} (mtime ${String(rec.mtime ?? "?")})`);
      },
    },
    {
      name: "kb_comment",
      description: "Append a comment to a ticket.",
      inputSchema: {
        type: "object",
        properties: {
          id: ID_SCHEMA,
          text: { type: "string", description: "comment text (markdown)" },
          mtime: { type: "number", description: "mtime from kb_read; rejects the write if the file changed since" },
        },
        required: ["id", "text"],
        additionalProperties: false,
      },
      annotations: annotations(false, false, false),
      handler: async (args) => {
        const p = ticketPath(args, "/comments");
        if (!p) return missingId();
        const text = str(args.text);
        if (text === undefined || text === "") return failure(400, { error: "text required", code: "invalid" });
        const body: Record<string, unknown> = { text };
        if (args.mtime !== undefined) body.mtime = args.mtime;
        const r = await call("POST", p, { body });
        if (!isOk(r.status)) return failure(r.status, r.body);
        const rec = isRecord(r.body) ? r.body : {};
        return success(r.body, `commented #${str(args.id) ?? "?"} (key ${str(rec.key) ?? "?"})`);
      },
    },
    {
      name: "kb_validate",
      description: "Check kanban.yaml and every ticket; reports errors and warnings.",
      inputSchema: OPEN,
      annotations: annotations(true, false, true),
      handler: async () => {
        const r = await call("GET", "/api/validate");
        if (!isOk(r.status)) return failure(r.status, r.body);
        const body = isRecord(r.body) ? r.body : {};
        const issues = Array.isArray(body.issues) ? body.issues.filter(isRecord) : [];
        const lines = issues.map((i) => {
          const where = str(i.path) ? `${str(i.path)}: ` : "";
          return `${str(i.severity) ?? "issue"}: ${where}${str(i.message) ?? ""}`;
        });
        const head =
          issues.length === 0
            ? "ok: no issues"
            : `${Array.isArray(body.errors) ? body.errors.length : 0} error(s), ${
                Array.isArray(body.warnings) ? body.warnings.length : 0
              } warning(s)`;
        return success(r.body, [head, ...lines].join("\n"));
      },
    },
    {
      name: "kb_fix",
      description: "Repair missing or duplicate ticket ids. Dry-run by default (nothing is written).",
      inputSchema: {
        type: "object",
        properties: {
          dryRun: { type: "boolean", default: true, description: "report only; set false to write the ids" },
        },
        additionalProperties: false,
      },
      annotations: annotations(false, true, false),
      handler: async (args) => {
        const dryRun = args.dryRun !== false;
        const r = await call("POST", "/api/fix", { body: { dryRun } });
        if (!isOk(r.status)) return failure(r.status, r.body);
        const changes = isRecord(r.body) && Array.isArray(r.body.changes) ? r.body.changes.filter(isRecord) : [];
        const lines = changes.map((c) => {
          const from = c.from === undefined || c.from === null ? "(none)" : String(c.from);
          const to = String(c.to ?? "?");
          return `${str(c.path) ?? "?"}: ${from} → ${to}`;
        });
        const head =
          changes.length === 0
            ? "ok: nothing to fix"
            : `${dryRun ? "dry run: " : ""}${changes.length} id change(s)${dryRun ? " — pass dryRun: false to apply" : ""}`;
        return success(r.body, [head, ...lines].join("\n"));
      },
    },
    {
      name: "kb_automations",
      description: "List automation runs currently in progress.",
      inputSchema: OPEN,
      annotations: annotations(true, false, true),
      handler: async () => {
        const r = await call("GET", "/api/automation/runs");
        if (!isOk(r.status)) return failure(r.status, r.body);
        const body = isRecord(r.body) ? r.body : {};
        const runs = Array.isArray(body.runs) ? body.runs.filter(isRecord) : [];
        const lines = runs.map((run) => {
          const rule = str(run.rule) ?? str(run.kind) ?? "?";
          const ticket = run.ticketId === undefined ? "" : ` #${String(run.ticketId)}`;
          const elapsed = typeof run.elapsedMs === "number" ? ` ${Math.round(run.elapsedMs / 1000)}s` : "";
          return `${rule}${ticket}${elapsed}${str(run.command) ? `: ${str(run.command)}` : ""}`;
        });
        const head =
          runs.length > 0 ? `${runs.length} run(s)` : body.disabled === true ? "automations are disabled" : "no runs in progress";
        return success(r.body, [head, ...lines].join("\n"));
      },
    },
  ];
}

// ---- server ----

export interface McpServerOptions {
  /** board directory (contains kanban.yaml) */
  dir: string;
  /** false disables automations (no runner); default: enabled */
  automation?: boolean;
}

/**
 * Stdio MCP server over `dir`. Automations are fire-and-forget: a write tool answers as soon as the
 * ticket is on disk, and any rule it triggered keeps running in the background.
 */
export async function startMcpServer(opts: McpServerOptions): Promise<void> {
  const dir = path.resolve(opts.dir);
  const events = createEventLog(dir);
  // `GET /api/automation/runs` reports only runs an owner registered, so the runner needs a registry
  // (same wiring as `kb web`); without it kb_automations would always answer "disabled".
  const live = new LiveRuns();
  const runner = opts.automation === false ? undefined : createShellRunner({ registry: live });
  const source: KbEventSource = "mcp";
  const kanban = (): Kanban => createKanban({ dir, runner, events, source });

  const ctx: ToolContext = { kanban, api: { runner, events, live, dir } };
  await runServer({ tools: createTools(ctx), instructions: INSTRUCTIONS });
}
