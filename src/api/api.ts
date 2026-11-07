import path from "node:path";
import type { AutomationLog } from "../automationLog.js";
import type { EventLog } from "../eventLog.js";
import type { AutomationRunner, RunResult } from "../core/automation.js";
import { automationSchema } from "../core/config.js";
import { renderCommand } from "../core/automation.js";
import { KanbanError, type Kanban, type Patch, type Ticket } from "../core/index.js";
import { killRun, pidAlive } from "../killRun.js";
import type { LiveRuns } from "../liveRuns.js";
import { duplicateKeys, toDetail, toView } from "./view.js";

export interface ApiRequest {
  method: string;
  /** path without query, e.g. /api/board */
  path: string;
  query: URLSearchParams;
  /** parsed JSON body ({} when none) */
  body: Record<string, unknown>;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

const STATUS: Record<string, number> = {
  "not-found": 404,
  ambiguous: 409,
  invalid: 400,
  exists: 409,
  config: 500,
  parse: 400,
  stale: 409,
};

export function errorResponse(e: unknown): ApiResponse {
  if (e instanceof KanbanError) return { status: STATUS[e.code] ?? 500, body: { error: e.message, code: e.code } };
  // Unexpected throws (fs errors, paths, ENOENT text) stay server-side; clients get a generic message.
  return { status: 500, body: { error: "internal error", code: "internal" } };
}

const fail = (status: number, code: string, error: string): ApiResponse => ({ status, body: { error, code } });
const ok = (body: unknown, status = 200): ApiResponse => ({ status, body });

export interface ApiContext {
  runner?: AutomationRunner;
  log?: AutomationLog;
  events?: EventLog;
  live?: LiveRuns;
  /** config dir, for cross-process kill markers */
  dir?: string;
}

type Handler = (kb: Kanban, req: ApiRequest, params: string[], ctx: ApiContext) => ApiResponse | Promise<ApiResponse>;

/** Throws if the client's mtime is stale; returns the current ticket otherwise. */
function checkFresh(kb: Kanban, id: string, mtime: unknown): ApiResponse | undefined {
  const t = kb.get(id); // throws not-found / ambiguous
  if (mtime !== undefined && mtime !== t.mtime) {
    return { status: 409, body: { error: "ticket changed on disk", code: "stale", currentMtime: t.mtime } };
  }
  return undefined;
}

const strArray = (v: unknown, name: string): string[] | undefined => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new KanbanError("invalid", `${name} must be an array of strings`);
  }
  return v as string[];
};
const str = (v: unknown, name: string): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new KanbanError("invalid", `${name} must be a string`);
  return v;
};
const obj = (v: unknown, name: string): Record<string, unknown> | undefined => {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new KanbanError("invalid", `${name} must be an object`);
  }
  return v as Record<string, unknown>;
};

/** Label option counts for the filter bar: union over all tickets of the selected board (ignoring text/label/property filters). */
function labelCounts(tickets: Ticket[], board: string | undefined): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const t of tickets) {
    if (board !== undefined && t.board !== board) continue;
    for (const l of t.labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const board: Handler = (kb, req) => {
  const q = req.query;
  const { config, tickets } = kb.load();
  const boardName = q.get("board") ?? undefined;
  const result = kb.list({
    board: boardName,
    text: q.get("text") ?? undefined,
    labels: q.getAll("label"),
    props: q.getAll("property"),
  });
  const dups = duplicateKeys(tickets);
  const boardNames = kb.boards();
  const columns: Record<string, string[]> = {};
  for (const b of boardNames) columns[b] = (config.boards?.[b]?.columns ?? config.columns).slice();
  return ok({
    name: config.name,
    boards: result.boards.map((b) => ({
      name: b.name,
      columns: b.columns.map((c) => ({ name: c.name, tickets: c.tickets.map((t) => toView(t, dups)) })),
      unsorted: b.unsorted.map((t) => toView(t, dups)),
    })),
    boardNames,
    columns,
    warnings: result.warnings,
    labels: labelCounts(tickets, boardName),
  });
};

const detail: Handler = (kb, _req, [id]) => {
  const t = kb.get(id);
  return ok(toDetail(t, duplicateKeys(kb.load().tickets)));
};

const create: Handler = (kb, req) => {
  const b = req.body;
  const f = str(b.file, "file");
  if (f !== undefined && (path.isAbsolute(f) || path.win32.isAbsolute(f) || f.split(/[\\/]/).includes(".."))) {
    throw new KanbanError("invalid", "file must be a relative path inside the board directory");
  }
  const r = kb.add({
    name: str(b.name, "name") as string,
    status: str(b.status, "status"),
    board: str(b.board, "board"),
    labels: strArray(b.labels, "labels"),
    properties: obj(b.properties, "properties"),
    body: str(b.body, "body"),
    comment: str(b.comment, "comment"),
    file: str(b.file, "file"),
    id: str(b.id, "id"),
  });
  return ok(r, 201);
};

const patch: Handler = (kb, req, [id]) => {
  const b = req.body;
  const stale = checkFresh(kb, id, b.mtime);
  if (stale) return stale;
  const p: Patch = {
    name: str(b.name, "name"),
    status: str(b.status, "status"),
    board: str(b.board, "board"),
    addLabels: strArray(b.addLabels, "addLabels"),
    removeLabels: strArray(b.removeLabels, "removeLabels"),
    setProps: obj(b.setProps, "setProps"),
    unsetProps: strArray(b.unsetProps, "unsetProps"),
    body: str(b.body, "body"),
    comment: str(b.comment, "comment"),
    resetAutomations: b.resetAutomations === true ? true : undefined,
  };
  const r = kb.update(id, p);
  return ok({ id: r.id, warnings: r.warnings, mtime: kb.get(id).mtime });
};

const comment: Handler = (kb, req, [id]) => {
  const stale = checkFresh(kb, id, req.body.mtime);
  if (stale) return stale;
  const text = str(req.body.text, "text");
  if (text === undefined || text === "") throw new KanbanError("invalid", "text required");
  const key = kb.comment(id, text);
  return ok({ key, mtime: kb.get(id).mtime }, 201);
};

const validate: Handler = (kb) => ok(kb.validate());

const fix: Handler = (kb, req) => {
  const raw = req.body.dryRun;
  if (raw !== undefined && typeof raw !== "boolean") throw new KanbanError("invalid", "dryRun must be a boolean");
  // dry-run stays the default for an absent flag, but say so explicitly instead of reporting plain success.
  const dryRun = raw === undefined ? true : raw;
  const changes = kb.fix({ dryRun });
  return ok(
    dryRun ? { dryRun: true, applied: false, hint: "pass dryRun:false to apply", changes } : { dryRun: false, applied: true, changes },
  );
};

const getConfig: Handler = (kb) => ok(kb.getConfig());

/** PUT body: {config, renames?, mtime?, dryRun?}. dryRun only when exactly true. */
const putConfig: Handler = (kb, req) => {
  const b = req.body;
  if (b.mtime !== undefined && typeof b.mtime !== "number") throw new KanbanError("invalid", "mtime must be a number");
  const r = kb.updateConfig(b.config, { renames: b.renames, mtime: b.mtime as number | undefined, dryRun: b.dryRun === true });
  return ok({ dryRun: b.dryRun === true, ...r });
};

/** POST body: {tickets}. Read-only preview of the proposed ticket rules. */
const previewTickets: Handler = (kb, req) => {
  if (req.body.tickets === undefined) throw new KanbanError("invalid", "tickets required");
  return ok(kb.previewTicketRules(req.body.tickets));
};

/** GET /api/events?q=&type=&ticket=&board=&source=&before=&limit= (type repeatable / comma-separated) */
const events: Handler = (_kb, req, _p, ctx) => {
  const q = req.query;
  let limit: number | undefined;
  const l = q.get("limit");
  if (l !== null) {
    if (!/^\d+$/.test(l) || Number(l) < 1 || Number(l) > 200) throw new KanbanError("invalid", "limit must be an integer 1..200");
    limit = Number(l);
  }
  const types = q
    .getAll("type")
    .flatMap((t) => t.split(","))
    .filter(Boolean);
  const r = ctx.events?.query({
    q: q.get("q") || undefined,
    type: types.length ? types : undefined,
    ticketId: q.get("ticket") || undefined,
    board: q.get("board") || undefined,
    source: q.get("source") || undefined,
    before: q.get("before") || undefined,
    limit,
  }) ?? { events: [] };
  return ok(r.nextCursor ? r : { events: r.events });
};

/** LEGACY: superseded by GET /api/events (automation.finished); kept for back-compat. */
const automationLog: Handler = (_kb, _req, _p, ctx) => ok({ runs: ctx.log?.recent(20) ?? [] });

/**
 * Runs that only exist in ticket frontmatter: started by another process (a `kb mv` in a terminal,
 * an earlier `kb web`). They have no output tail (stdout lives in the owner's memory) and are killed
 * through their persisted pid. `external: true` marks them for the UI.
 */
function externalRuns(kb: Kanban, own: { rule?: string; ticketId?: string }[]): ExternalRun[] {
  const seen = new Set(own.map((r) => `${r.rule ?? ""}\u0000${r.ticketId ?? ""}`));
  return (
    kb
      .automationOverview()
      .live.filter((l) => !seen.has(`${l.rule}\u0000${String(l.ticket.id)}`))
      // A recorded pid that no longer exists means the run died without the owner cleaning up (crash,
      // killed by someone else). Leave it to `prune` rather than showing a dead row forever.
      .filter((l) => l.pid === undefined || pidAlive(l.pid))
      .map((l) => ({
        runId: `ticket:${l.board}:${String(l.ticket.id)}:${l.rule}`,
        kind: "rule" as const,
        board: l.board,
        rule: l.rule,
        ticketId: String(l.ticket.id),
        ticketName: l.ticket.name,
        path: l.ticket.path,
        command: l.command,
        pid: l.pid ?? -1,
        startedAt: l.startedAt,
        timeoutMs: l.timeoutSeconds ? l.timeoutSeconds * 1000 : null,
        elapsedMs: l.elapsedMs,
        output: "",
        external: true,
        /** board + national key for pairing back to the overview on kill */
        live: l,
      }))
  );
}

interface ExternalRun {
  runId: string;
  kind: "rule";
  board: string;
  rule: string;
  ticketId: string;
  ticketName: string;
  path: string;
  command: string;
  pid: number;
  startedAt: string;
  timeoutMs: number | null;
  elapsedMs: number;
  output: string;
  external: true;
  live: import("../core/automation.js").AutomationLive;
}

const automationRuns: Handler = (kb, _req, _p, ctx) => {
  if (!ctx.runner || !ctx.live) return ok({ runs: [], disabled: true });
  const own = ctx.live.list();
  const extra = externalRuns(kb, own).map(({ live: _l, ...r }) => r);
  return ok({ runs: [...own, ...extra] });
};

const automationKill: Handler = async (kb, _req, p, ctx) => {
  const id = p[0];
  if (ctx.live?.kill(id)) return ok({ ok: true }, 202);
  // Not ours: it may be a run owned by another process, addressed by its synthetic runId.
  const target = id.startsWith("ticket:") ? externalRuns(kb, []).find((r) => r.runId === id)?.live : undefined;
  if (!target) return fail(404, "not-found", `no running automation ${id}`);
  const r = await killRun(
    { pid: target.pid, pgid: target.pgid, host: target.host, elapsedMs: target.elapsedMs },
    { root: ctx.dir ?? kb.dir, waitMs: 1000 },
  );
  if (!r.ok) return fail(409, "kill-failed", r.reason);
  return ok({ ok: true }, 202);
};

function parseTimeout(v: unknown): number {
  const r = automationSchema.shape.timeout.safeParse(v);
  if (!r.success) throw new KanbanError("invalid", r.error.issues[0].message);
  return r.data ?? 0;
}

const SAMPLE_STATUS = "done";
const MAX_TEST_RUNS = 2;
let testRuns = 0;

/** Renders `run` with a sample ticket and really executes it (not logged, no ticket touched). */
const automationTest: Handler = async (kb, req, _p, ctx) => {
  const b = req.body;
  const run = b.run;
  const steps = typeof run === "string" ? [run] : strArray(run, "run");
  if (steps === undefined || steps.length === 0 || steps.some((s) => s.trim() === "")) {
    throw new KanbanError("invalid", "run must not be empty");
  }
  if (!ctx.runner) return fail(503, "disabled", "automations are disabled (kb web --no-automation)");
  const multi = Array.isArray(run);
  const continueOnError = b.continueOnError === true;
  const event = str(b.event, "event") ?? "moved_to";
  if (event !== "moved_to" && event !== "created_in") throw new KanbanError("invalid", "event must be moved_to or created_in");
  const s = obj(b.sample, "sample") ?? {};
  const to = str(s.to, "sample.to") ?? SAMPLE_STATUS;
  const labels = strArray(s.labels, "sample.labels") ?? [];
  const vars = {
    id: str(s.id, "sample.id") ?? "000",
    name: str(s.name, "sample.name") ?? "Sample ticket",
    body: str(s.body, "sample.body") ?? "Sample body",
    board: str(b.board, "board") ?? kb.load().config.name,
    status: str(s.status, "sample.status") ?? to,
    from: str(s.from, "sample.from") ?? (event === "moved_to" ? "todo" : undefined),
    to,
    path: "sample.md",
    labels: labels.join(","),
    event,
    props: obj(s.props, "sample.props") ?? {},
  };
  const timeout = b.timeout === undefined || b.timeout === null ? 0 : parseTimeout(b.timeout);
  // Render every step before running any (same as core): a bad placeholder fails the whole test up front.
  const commands = steps.map((step, i) => {
    try {
      return renderCommand(step, vars);
    } catch (e) {
      const msg = (e as Error).message;
      throw new KanbanError("invalid", multi ? `step ${String(i + 1)}: ${msg}` : msg);
    }
  });
  const command = commands.join(" && ");
  if (testRuns >= MAX_TEST_RUNS) return fail(429, "busy", "too many test runs in progress; try again shortly");
  testRuns++;
  try {
    const results: RunResult[] = [];
    for (const step of commands) {
      let r: RunResult;
      try {
        r = await ctx.runner.run(step, {
          cwd: kb.dir,
          env: { KB_AUTOMATION: "1" },
          ...(timeout ? { timeoutMs: timeout * 1000 } : {}),
          meta: { test: true, board: vars.board },
        });
      } catch (e) {
        r = { exitCode: null, stdout: "", stderr: "", error: (e as Error).message };
      }
      results.push(r);
      if ((r.exitCode !== 0 || r.error) && !continueOnError) break;
    }
    // Aggregate: the first failure if any, else the last step (same rule as core).
    const firstFailure = results.find((r) => r.exitCode !== 0 || r.error);
    const result: RunResult & { steps: RunResult[] } = { ...(firstFailure ?? results[results.length - 1]), steps: results };
    return ok({ command, result });
  } finally {
    testRuns--;
  }
};

interface Route {
  method: string;
  re: RegExp;
  handler: Handler;
}
const route = (method: string, pattern: string, handler: Handler): Route => ({
  method,
  re: new RegExp("^" + pattern.replace(/:id/g, "([^/]+)") + "$"),
  handler,
});

const routes: Route[] = [
  route("GET", "/api/board", board),
  route("POST", "/api/tickets", create),
  route("GET", "/api/tickets/:id", detail),
  route("PATCH", "/api/tickets/:id", patch),
  route("POST", "/api/tickets/:id/comments", comment),
  route("GET", "/api/validate", validate),
  route("POST", "/api/fix", fix),
  route("GET", "/api/config", getConfig),
  route("PUT", "/api/config", putConfig),
  route("POST", "/api/config/preview-tickets", previewTickets),
  route("GET", "/api/events", events),
  route("GET", "/api/automation/log", automationLog),
  route("POST", "/api/automation/test", automationTest),
  route("GET", "/api/automation/runs", automationRuns),
  route("POST", "/api/automation/runs/:id/kill", automationKill),
];

/** Pure request handler: no HTTP, just the Kanban core. */
export async function handleApi(kb: Kanban, req: ApiRequest, ctx: ApiContext = {}): Promise<ApiResponse> {
  const path = req.path.length > 1 ? req.path.replace(/\/+$/, "") : req.path;
  const hits = routes.filter((r) => r.re.test(path));
  if (hits.length === 0) return fail(404, "not-found", `unknown route ${path}`);
  const r = hits.find((h) => h.method === req.method);
  if (!r) return fail(405, "method-not-allowed", `${req.method} not allowed on ${path}`);
  try {
    const m = r.re.exec(path)!;
    let params: string[];
    try {
      params = m.slice(1).map(decodeURIComponent);
    } catch {
      return fail(400, "invalid", "malformed percent-encoding in path");
    }
    return await r.handler(kb, req, params, ctx);
  } catch (e) {
    return errorResponse(e);
  }
}
