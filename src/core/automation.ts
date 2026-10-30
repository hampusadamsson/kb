// Board automations: rule matching, command templates, runner interface. UI/process agnostic.
import type { Automation } from "./config.js";
import { KanbanError } from "./errors.js";
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

export interface AutomationRunner {
  run(command: string, opts: { cwd: string; env: Record<string, string> }): Promise<RunResult>;
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
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function str(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function renderCommand(template: string, vars: Record<string, unknown>): string {
  const bad = unknownVars(template);
  if (bad.length) throw new KanbanError("invalid", `unknown template variable: ${bad.join(", ")}`);
  return template.replace(VAR_RE, (_m, name: string) => {
    if (name.startsWith("props.")) {
      const props = vars.props;
      const v = props && typeof props === "object" ? (props as Record<string, unknown>)[name.slice(6)] : undefined;
      return shellQuote(str(v));
    }
    const v = vars[name];
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
  const props = Object.entries(rule.when.props ?? {}).map(([k, v]) => {
    const s = String(v);
    return s.startsWith("!") ? `!${k}:${s.slice(1)}` : `${k}:${s}`;
  });
  return matches(ticket, { labels: rule.when.labels, props });
}
