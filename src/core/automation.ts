// Board automations: rule matching, command templates, runner interface. UI/process agnostic.
import { automationsFor, type Automation, type Config } from "./config.js";
import { KanbanError } from "./errors.js";
import { clipText } from "./events.js";
import { matches, type Ticket } from "./tickets.js";

export interface AutomationEvent {
  type: "moved_to" | "created_in";
  to: string;
  from?: string;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Error text of a run terminated by the user (web Kill button). */
export const KILLED_BY_USER = "killed by user";

/** Describes what a run is for (informational; runners may register it). */
export interface RunMeta {
  board?: string;
  rule?: string;
  ticketId?: string;
  ticketName?: string;
  path?: string;
  /** a test run from the settings UI */
  test?: boolean;
}

export interface AutomationRunner {
  run(command: string, opts: { cwd: string; env: Record<string, string>; meta?: RunMeta }): Promise<RunResult>;
}

export interface AutomationRecord {
  board: string;
  /** rule name */
  rule: string;
  ticketId: unknown;
  path: string;
  event: AutomationEvent;
  command: string;
  startedAt: string;
  finishedAt: string;
  status: "done" | "failed";
  result: RunResult;
}

/** Loop guardrail: a ticket with this many recorded automation runs gets no more (unless the rule has guard: false). */
export const AUTOMATION_RUN_LIMIT = 15;

/** Runs recorded in one `automations` entry (entries without `runs` count as 1). */
export function entryRuns(e: unknown): number {
  if (!e || typeof e !== "object" || Array.isArray(e)) return 1;
  const r = Number((e as Record<string, unknown>).runs);
  return Number.isFinite(r) && r >= 0 ? Math.floor(r) : 1;
}

/** Total automation runs recorded on a ticket (`automations` frontmatter value). */
export function totalRuns(automations: unknown): number {
  if (!automations || typeof automations !== "object" || Array.isArray(automations)) return 0;
  return Object.values(automations).reduce<number>((n, e) => n + entryRuns(e), 0);
}

export const KNOWN_VARS = [
  "id", "name", "body", "board", "status", "from", "to", "path", "labels", "event",
] as const;

const VAR_RE = /\{\{\s*([^{}\s]+)\s*\}\}/g;

/** Variable names used in a template, in order of appearance (with duplicates removed). */
export function templateVars(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(VAR_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

const isKnown = (v: string): boolean =>
  (KNOWN_VARS as readonly string[]).includes(v) || (v.startsWith("props.") && v.length > 6);

export function unknownVars(template: string): string[] {
  return templateVars(template).filter((v) => !isKnown(v));
}

export function shellQuote(s: string): string {
  return `'${s.replace(/\0/g, "").replace(/'/g, `'\\''`)}'`;
}

export type PlaceholderContext = "double-quote" | "single-quote" | "backtick" | "heredoc";
export interface PlaceholderProblem {
  variable: string;
  context: PlaceholderContext;
}

const PLACEHOLDER_AT = /\{\{\s*([^{}\s]+)\s*\}\}/y;
const HEREDOC_RE = /^<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_][\w]*))/;

/**
 * Placeholders located inside quotes, backticks or heredoc bodies of a shell template. Values are
 * shell-quoted ('…') automatically, which is only safe in unquoted code position (incl. `$( … )`).
 */
export function placeholderContextProblems(template: string): PlaceholderProblem[] {
  const out: PlaceholderProblem[] = [];
  const add = (variable: string, context: PlaceholderContext) => {
    if (!out.some((p) => p.variable === variable && p.context === context)) out.push({ variable, context });
  };
  type Frame = { kind: "code" | "dq" | "sq" | "bt"; depth: number; paren: boolean };
  const stack: Frame[] = [{ kind: "code", depth: 0, paren: false }];
  const heredocs: { word: string; strip: boolean }[] = [];
  const t = template;
  let i = 0;
  const ctxOf = (k: Frame["kind"]): PlaceholderContext | undefined =>
    k === "dq" ? "double-quote" : k === "sq" ? "single-quote" : k === "bt" ? "backtick" : undefined;

  while (i < t.length) {
    const top = stack[stack.length - 1];
    const c = t[i];
    if (c === "{" && t[i + 1] === "{") {
      PLACEHOLDER_AT.lastIndex = i;
      const m = PLACEHOLDER_AT.exec(t);
      if (m) {
        const ctx = ctxOf(top.kind);
        if (ctx) add(m[1], ctx);
        i += m[0].length;
        continue;
      }
    }
    if (top.kind === "sq") {
      if (c === "'") stack.pop();
      i++;
      continue;
    }
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (top.kind === "dq") {
      if (c === '"') stack.pop();
      else if (c === "`") stack.push({ kind: "bt", depth: 0, paren: false });
      else if (c === "$" && t[i + 1] === "(") (stack.push({ kind: "code", depth: 0, paren: true }), i++);
      i++;
      continue;
    }
    if (top.kind === "bt") {
      if (c === "`") stack.pop();
      i++;
      continue;
    }
    // code
    if (c === "'") stack.push({ kind: "sq", depth: 0, paren: false });
    else if (c === '"') stack.push({ kind: "dq", depth: 0, paren: false });
    else if (c === "`") stack.push({ kind: "bt", depth: 0, paren: false });
    else if (c === "$" && t[i + 1] === "(") (stack.push({ kind: "code", depth: 0, paren: true }), i++);
    else if (c === "(") top.depth++;
    else if (c === ")") {
      if (top.depth > 0) top.depth--;
      else if (top.paren) stack.pop();
    } else if (c === "#" && (i === 0 || /[\s;&|(]/.test(t[i - 1]))) {
      while (i < t.length && t[i] !== "\n") i++;
      continue;
    } else if (c === "<" && t[i + 1] === "<" && t[i + 2] !== "<" && t[i - 1] !== "<") {
      const m = HEREDOC_RE.exec(t.slice(i));
      if (m) {
        heredocs.push({ word: m[2] ?? m[3] ?? m[4], strip: m[1] === "-" });
        i += m[0].length;
        continue;
      }
    } else if (c === "\n" && heredocs.length) {
      i++;
      for (const h of heredocs.splice(0)) {
        while (i < t.length) {
          let end = t.indexOf("\n", i);
          if (end < 0) end = t.length;
          const line = t.slice(i, end);
          i = Math.min(end + 1, t.length);
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.word) break;
          for (const m of line.matchAll(VAR_RE)) add(m[1], "heredoc");
        }
      }
      continue;
    }
    i++;
  }
  return out;
}

function contextMessage(p: PlaceholderProblem): string {
  return `{{ ${p.variable} }} must not be inside "…"/'…'/backticks/heredoc (${p.context}) — values are shell-quoted automatically, write it bare, e.g. echo {{ name }}`;
}

/** All problems of the automations in a config (shared by validate and settings). */
export function automationProblems(config: {
  name: string;
  columns: string[];
  boards?: Record<string, { columns: string[]; automations?: Automation[] }>;
  automations?: Automation[];
}): string[] {
  const out: string[] = [];
  const boards = [config.name, ...Object.keys(config.boards ?? {})];
  for (const board of boards) {
    const cols = config.boards?.[board]?.columns ?? config.columns;
    const rules = (board === config.name ? config.automations : config.boards?.[board]?.automations) ?? [];
    const seen = new Set<string>();
    for (const rule of rules) {
      const where = `board "${board}" automation "${rule.name}"`;
      if (!rule.name.trim()) out.push(`board "${board}": automation has an empty name`);
      else if (seen.has(rule.name)) out.push(`${where}: duplicate name`);
      seen.add(rule.name);
      if (!rule.run.trim()) out.push(`${where}: empty run command`);
      for (const v of unknownVars(rule.run)) out.push(`${where}: unknown template variable "${v}"`);
      for (const p of placeholderContextProblems(rule.run)) out.push(`${where}: ${contextMessage(p)}`);
      const col = rule.when.moved_to ?? rule.when.created_in;
      if (col !== undefined && !cols.includes(col)) {
        out.push(`${where}: column "${col}" is not a column of board "${board}"`);
      }
    }
  }
  return out;
}

function str(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function renderCommand(template: string, vars: Record<string, unknown>): string {
  const bad = unknownVars(template);
  if (bad.length) throw new KanbanError("invalid", `unknown template variable: ${bad.join(", ")}`);
  const ctx = placeholderContextProblems(template);
  if (ctx.length) throw new KanbanError("invalid", ctx.map(contextMessage).join("; "));
  return template.replace(VAR_RE, (_m, name: string) => {
    if (name.startsWith("props.")) {
      const props = vars.props;
      const key = name.slice(6);
      const v =
        props && typeof props === "object" && Object.hasOwn(props, key)
          ? (props as Record<string, unknown>)[key]
          : undefined;
      return shellQuote(str(v));
    }
    const v = Object.hasOwn(vars, name) ? vars[name] : undefined;
    return shellQuote(Array.isArray(v) ? v.join(",") : str(v));
  });
}

/** Template variables for a ticket and event. */
export function ticketVars(ticket: Ticket, event: AutomationEvent): Record<string, unknown> {
  return {
    id: ticket.id,
    name: ticket.name,
    body: ticket.body,
    board: ticket.board,
    status: ticket.status,
    from: event.from,
    to: event.to,
    path: ticket.path,
    labels: ticket.labels.join(","),
    event: event.type,
    props: ticket.props,
  };
}

export function matchRule(rule: Automation, event: AutomationEvent, ticket: Ticket): boolean {
  if (rule.enabled === false) return false;
  if (rule.when[event.type] !== event.to) return false;
  if (!matches(ticket, { labels: rule.when.labels })) return false;
  for (const [k, v] of Object.entries(rule.when.props ?? {})) {
    const s = String(v);
    const neg = s.startsWith("!");
    const want = neg ? s.slice(1) : s;
    const val = Object.hasOwn(ticket.data, k) ? ticket.data[k] : undefined;
    const ok = Array.isArray(val) ? val.some((e) => String(e) === want) : val != null && String(val) === want;
    if (ok === neg) return false;
  }
  return true;
}

// ---- overview (read-only, derived from ticket frontmatter) ----

/** A `running` entry older than this is considered stale (same threshold as validate). */
export const STALE_RUNNING_MS = 5 * 60_000;

export interface AutomationLastRun {
  ticketId: unknown;
  /** done | failed | skipped | running | stale */
  status: string;
  at: string;
  exit?: number | null;
  error?: string;
}

export interface AutomationLive {
  rule: string;
  board: string;
  ticket: { id: unknown; name: string; path: string };
  startedAt: string;
  elapsedMs: number;
  command: string;
}

export interface AutomationInfo {
  name: string;
  board: string;
  enabled: boolean;
  guard: boolean;
  when: Automation["when"];
  run: string;
  /** non-stale running entries */
  running: number;
  lastRun: AutomationLastRun | null;
  counts: { done: number; failed: number; skipped: number; running: number; stale: number };
}

export interface AutomationOverview {
  rules: AutomationInfo[];
  /** non-stale running entries, newest first */
  live: AutomationLive[];
}

function atMs(at: unknown): number {
  const ms = at instanceof Date ? at.getTime() : typeof at === "string" ? new Date(at).getTime() : NaN;
  return ms;
}

/** Rule definitions plus runtime data from ticket `automations` frontmatter. Pure. */
export function buildAutomationOverview(
  config: Config,
  tickets: Ticket[],
  boards: string[],
  nowMs: number,
): AutomationOverview {
  const rules: AutomationInfo[] = [];
  const live: (AutomationLive & { ms: number })[] = [];
  for (const board of boards) {
    const defs = automationsFor(config, board);
    const infos = new Map<string, AutomationInfo & { lastMs: number }>();
    for (const r of defs) {
      infos.set(r.name, {
        name: r.name,
        board,
        enabled: r.enabled !== false,
        guard: r.guard !== false,
        when: r.when,
        run: clipText(r.run),
        running: 0,
        lastRun: null,
        counts: { done: 0, failed: 0, skipped: 0, running: 0, stale: 0 },
        lastMs: -Infinity,
      });
    }
    for (const t of tickets) {
      if (t.board !== board) continue;
      const autos = t.data.automations;
      if (autos === null || typeof autos !== "object" || Array.isArray(autos)) continue;
      for (const [rule, e] of Object.entries(autos as Record<string, unknown>)) {
        if (e === null || typeof e !== "object" || Array.isArray(e)) continue;
        const ent = e as Record<string, unknown>;
        let status = typeof ent.status === "string" ? ent.status : "";
        const ms = atMs(ent.at);
        const at = ent.at instanceof Date ? ent.at.toISOString() : ent.at === undefined ? "" : String(ent.at);
        const info = infos.get(rule);
        if (status === "running") {
          const stale = Number.isNaN(ms) || nowMs - ms > STALE_RUNNING_MS;
          if (stale) status = "stale";
          else live.push({ rule, board, ticket: { id: t.id, name: t.name, path: t.path }, startedAt: at, elapsedMs: Math.max(0, nowMs - ms), command: info?.run ?? "", ms });
        }
        if (!info) continue;
        if (status === "done" || status === "failed" || status === "skipped" || status === "running" || status === "stale") {
          info.counts[status]++;
          if (status === "running") info.running++;
        }
        const sortMs = Number.isNaN(ms) ? -1 : ms;
        if (sortMs > info.lastMs || (info.lastRun === null && sortMs >= info.lastMs)) {
          info.lastMs = sortMs;
          const last: AutomationLastRun = { ticketId: t.id, status: status || "unknown", at };
          if (ent.exit !== undefined) last.exit = ent.exit as number | null;
          if (typeof ent.error === "string") last.error = ent.error;
          info.lastRun = last;
        }
      }
    }
    for (const { lastMs: _l, ...i } of infos.values()) rules.push(i);
  }
  live.sort((a, b) => b.ms - a.ms);
  return { rules, live: live.map(({ ms: _m, ...l }) => l) };
}
