import { duplicates, hasId, idKey, type Ticket } from "../core/index.js";

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
}

export interface TicketDetail extends TicketView {
  body: string;
  comments: Record<string, string>;
  /** parsed frontmatter, including reserved keys */
  data: Record<string, unknown>;
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
  };
}

export function toDetail(t: Ticket, dups: Set<string>): TicketDetail {
  return { ...toView(t, dups), body: t.body, comments: t.comments, data: t.data };
}
