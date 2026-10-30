import path from "node:path";
import type { AutomationLog } from "../automationLog.js";
import type { AutomationRunner } from "../core/automation.js";
import { renderCommand } from "../core/automation.js";
import { KanbanError, type Kanban, type Patch } from "../core/index.js";
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
  return { status: 500, body: { error: (e as Error).message ?? String(e), code: "internal" } };
}

const fail = (status: number, code: string, error: string): ApiResponse => ({ status, body: { error, code } });
const ok = (body: unknown, status = 200): ApiResponse => ({ status, body });

export interface ApiContext {
  runner?: AutomationRunner;
  log?: AutomationLog;
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

const board: Handler = (kb, req) => {
  const q = req.query;
  const { config, tickets } = kb.load();
  const result = kb.list({
    board: q.get("board") ?? undefined,
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
  const dryRun = req.body.dryRun !== false;
  return ok({ dryRun, changes: kb.fix({ dryRun }) });
};

const getConfig: Handler = (kb) => ok(kb.getConfig());

/** PUT body: {config, renames?, mtime?, dryRun?}. dryRun only when exactly true. */
const putConfig: Handler = (kb, req) => {
  const b = req.body;
  if (b.mtime !== undefined && typeof b.mtime !== "number") throw new KanbanError("invalid", "mtime must be a number");
  const r = kb.updateConfig(b.config, { renames: b.renames, mtime: b.mtime as number | undefined, dryRun: b.dryRun === true });
  return ok({ dryRun: b.dryRun === true, ...r });
};

const automationLog: Handler = (_kb, _req, _p, ctx) => ok({ runs: ctx.log?.recent(20) ?? [] });

const SAMPLE_STATUS = "done";
const MAX_TEST_RUNS = 2;
let testRuns = 0;

/** Renders `run` with a sample ticket and really executes it (not logged, no ticket touched). */
const automationTest: Handler = async (kb, req, _p, ctx) => {
  const b = req.body;
  const run = str(b.run, "run");
  if (run === undefined || run.trim() === "") throw new KanbanError("invalid", "run must not be empty");
  if (!ctx.runner) return fail(503, "disabled", "automations are disabled (kb web --no-automation)");
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
  const command = renderCommand(run, vars); // throws invalid on unknown variable
  if (testRuns >= MAX_TEST_RUNS) return fail(429, "busy", "too many test runs in progress; try again shortly");
  testRuns++;
  try {
    const result = await ctx.runner.run(command, { cwd: kb.dir, env: { KB_AUTOMATION: "1" } });
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
  route("GET", "/api/automation/log", automationLog),
  route("POST", "/api/automation/test", automationTest),
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
