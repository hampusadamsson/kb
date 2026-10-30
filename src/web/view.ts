import { duplicates, hasId, idKey, type Ticket } from "../core/index.js";

/** Light per-rule summary for board cards (no error text). */
export interface AutomationBrief {
  name: string;
  status: string;
  at?: string;
  exit?: number;
  error?: true;
}

export interface TicketView {
  id: unknown;
  name: string;
  status: string | undefined;
  board: string;
  column: string;
  labels: string[];
  props: Record<string, unknown>;
  path: string;
  mtime: number;
  hasId: boolean;
  duplicate: boolean;
  readOnly: boolean;
  autos: AutomationBrief[];
}

export interface TicketDetail extends TicketView {
  body: string;
  comments: Record<string, string>;
  /** parsed frontmatter, including reserved keys */
  data: Record<string, unknown>;
  /** per-rule automation status written by the runner: name → {status, at, exit?, error?} */
  automations: Record<string, unknown>;
}

/** Keys of ids shared by more than one ticket. */
export function duplicateKeys(tickets: Ticket[]): Set<string> {
  return new Set(duplicates(tickets).map((g) => idKey(g[0].id)));
}

export function toView(t: Ticket, dups: Set<string>): TicketView {
  const present = hasId(t);
  const duplicate = present && dups.has(idKey(t.id));
  return {
    id: t.id ?? null,
    name: t.name,
    status: t.status,
    board: t.board,
    column: t.column,
    labels: t.labels,
    props: t.props,
    path: t.path,
    mtime: t.mtime,
    hasId: present,
    duplicate,
    readOnly: duplicate || !present,
    autos: briefs(automationsOf(t.data)),
  };
}

function automationsOf(data: Record<string, unknown>): Record<string, unknown> {
  const a = data.automations;
  return a && typeof a === "object" && !Array.isArray(a) ? (a as Record<string, unknown>) : {};
}

function briefs(a: Record<string, unknown>): AutomationBrief[] {
  return Object.entries(a).map(([name, v]) => {
    const e = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    const b: AutomationBrief = { name, status: typeof e.status === "string" ? e.status : "" };
    if (e.at !== undefined && e.at !== null) b.at = String(e.at);
    if (typeof e.exit === "number") b.exit = e.exit;
    if (e.error) b.error = true;
    return b;
  });
}

export function toDetail(t: Ticket, dups: Set<string>): TicketDetail {
  return { ...toView(t, dups), body: t.body, comments: t.comments, data: t.data, automations: automationsOf(t.data) };
}
