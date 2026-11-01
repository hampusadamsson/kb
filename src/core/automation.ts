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
  /** the run was killed because it exceeded its timeout */
  timedOut?: boolean;
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

/** Where the spawned process landed (reported by the runner right after spawn). */
export interface RunSpawn {
  pid: number;
  /** process group id; equal to pid for detached runs */
  pgid: number;
}

export interface RunOptions {
  cwd: string;
  env: Record<string, string>;
  meta?: RunMeta;
  timeoutMs?: number;
  /** called once the child exists, so the owner can record a killable pid */
  onSpawn?: (spawn: RunSpawn) => void;
}

export interface AutomationRunner {
  run(command: string, opts: RunOptions): Promise<RunResult>;
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
  /** 1-based index of the first failing step, when the rule has several steps */
  failedStep?: number;
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

export const KNOWN_VARS = ["id", "name", "body", "board", "status", "from", "to", "path", "labels", "event"] as const;

const VAR_RE = /\{\{\s*([^{}\s]+)\s*\}\}/g;

/** Variable names used in a template, in order of appearance (with duplicates removed). */
export function templateVars(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(VAR_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

const isKnown = (v: string): boolean => (KNOWN_VARS as readonly string[]).includes(v) || (v.startsWith("props.") && v.length > 6);

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
      else if (c === "$" && t[i + 1] === "(") {
        stack.push({ kind: "code", depth: 0, paren: true });
        i++;
      }
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
    else if (c === "$" && t[i + 1] === "(") {
      stack.push({ kind: "code", depth: 0, paren: true });
      i++;
    } else if (c === "(") top.depth++;
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

/** The rule's commands, in order (a plain string `run` is a single step). */
export function runSteps(rule: Pick<Automation, "run">): string[] {
  return Array.isArray(rule.run) ? rule.run : [rule.run];
}

/** All steps joined for logs/records (`&&` reads like the sequence). */
export function ruleCommand(rule: Pick<Automation, "run">): string {
  return Array.isArray(rule.run) ? rule.run.join(" && ") : rule.run;
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
      const steps = runSteps(rule);
      for (const [i, cmd] of steps.entries()) {
        const step = Array.isArray(rule.run) ? ` in step ${String(i + 1)}` : "";
        if (!cmd.trim()) out.push(`${where}: empty run command${step}`);
        for (const v of unknownVars(cmd)) out.push(`${where}: unknown template variable "${v}"${step}`);
        for (const p of placeholderContextProblems(cmd)) out.push(`${where}: ${contextMessage(p)}${step}`);
      }
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
      const v = props && typeof props === "object" && Object.hasOwn(props, key) ? (props as Record<string, unknown>)[key] : undefined;
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
  /** the rule's timeout in seconds; 0 = none */
  timeoutSeconds: number;
  /** OS process id, when the owner recorded it (needed to kill from another process) */
  pid?: number;
  /** process group id of the detached run */
  pgid?: number;
  /** hostname the run started on; absent on entries written by older versions */
  host?: string;
}

export interface AutomationInfo {
  name: string;
  board: string;
  enabled: boolean;
  guard: boolean;
  /** seconds; 0 = no timeout */
  timeout: number;
  when: Automation["when"];
  /** the script as configured: one command, or the list of steps */
  run: string | string[];
  /** steps keep running after a failure (only when the rule sets it) */
  continueOnError?: boolean;
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

/** Liveness probe for a recorded run: `true` when the process is still running. */
export type AliveProbe = (pid: number) => boolean;

/** A positive integer from frontmatter (pids may be written as strings). */
function posInt(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER ? n : undefined;
}

/**
 * Is a `running` entry dead? A recorded pid on this host is authoritative: a live process is never
 * stale, however long it has run (agent runs last for hours). Without a probe — or for an entry
 * recorded on another host, where the pid is meaningless — fall back to the age threshold.
 */
export function isStaleRun(
  ent: Record<string, unknown>,
  ms: number,
  nowMs: number,
  probe: { isAlive?: AliveProbe; localHost?: string } = {},
): boolean {
  const pid = posInt(ent.pid);
  const host = typeof ent.host === "string" && ent.host ? ent.host : undefined;
  const sameHost = host === undefined || probe.localHost === undefined || host === probe.localHost;
  if (pid !== undefined && probe.isAlive && sameHost) return !probe.isAlive(pid);
  return Number.isNaN(ms) || nowMs - ms > STALE_RUNNING_MS;
}

/** Rule definitions plus runtime data from ticket `automations` frontmatter. Pure. */
export function buildAutomationOverview(
  config: Config,
  tickets: Ticket[],
  boards: string[],
  nowMs: number,
  probe: { isAlive?: AliveProbe; localHost?: string } = {},
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
        timeout: r.timeout ?? 0,
        when: r.when,
        run: typeof r.run === "string" ? clipText(r.run) : r.run.map((s) => clipText(s)),
        ...(r.continueOnError === true ? { continueOnError: true } : {}),
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
          const stale = isStaleRun(ent, ms, nowMs, probe);
          if (stale) status = "stale";
          else {
            const pid = posInt(ent.pid);
            const pgid = posInt(ent.pgid) ?? pid;
            const host = typeof ent.host === "string" && ent.host ? ent.host : undefined;
            live.push({
              rule,
              board,
              ticket: { id: t.id, name: t.name, path: t.path },
              startedAt: at,
              elapsedMs: Math.max(0, nowMs - ms),
              command: info ? ruleCommand(info) : "",
              timeoutSeconds: info?.timeout ?? 0,
              ...(pid ? { pid, pgid } : {}),
              ...(host ? { host } : {}),
              ms,
            });
          }
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
