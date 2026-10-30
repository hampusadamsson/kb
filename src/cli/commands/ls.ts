import { createKanban, type Filters, type Ticket } from "../../core/index.js";
import { fmtId, fmtValue, fmtWarning, makeStyle, type Style } from "../format.js";

export interface LsOpts extends Filters {
  board?: string;
  color?: boolean;
}

export interface Result {
  out: string;
  warnings: string[];
}

function line(t: Ticket, s: Style): string {
  const tags = [
    ...t.labels.map((l) => `[${l}]`),
    ...Object.entries(t.props).map(([k, v]) => `${k}:${fmtValue(v)}`),
  ];
  const head = `  #${fmtId(t.id)} ${t.name}`;
  return tags.length ? `${head}   ${s.dim(tags.join(" "))}` : head;
}

export function ls(cwd: string, opts: LsOpts = {}): Result {
  const { color, ...filters } = opts;
  const s = makeStyle(color ?? false);
  const r = createKanban({ dir: cwd }).list(filters);
  const out: string[] = [];
  for (const b of r.boards) {
    out.push(s.bold(`== ${b.name} ==`));
    for (const col of b.columns) {
      out.push(s.bold(`${col.name} (${col.tickets.length})`));
      for (const t of col.tickets) out.push(line(t, s));
    }
    if (b.unsorted.length) {
      out.push(s.bold(`unsorted (${b.unsorted.length})`));
      for (const t of b.unsorted) out.push(line(t, s));
    }
    out.push("");
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return { out: out.join("\n"), warnings: r.warnings.map(fmtWarning) };
}

export const DEFAULT_LIMIT = 50;

export interface LsJsonOpts extends Filters {
  board?: string;
  /** include body and comments */
  full?: boolean;
  /** max tickets; 0 = unlimited (default 50) */
  limit?: number;
}

export function parseLimit(v: string | undefined): number {
  if (v === undefined) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(v)) throw new Error(`--limit must be a non-negative integer (0 = no limit), got "${v}"`);
  return Number(v);
}

function jsonTicket(t: Ticket, full: boolean): Record<string, unknown> {
  const o: Record<string, unknown> = {
    id: t.id ?? null,
    name: t.name,
    board: t.board,
    status: t.status ?? null,
    column: t.column,
    labels: t.labels,
    props: t.props,
    path: t.path,
  };
  if (full) {
    o.body = t.body;
    o.comments = t.comments;
  }
  return o;
}

/**
 * JSON listing: { total, shown, limit, truncated, tickets: [...] }.
 * Tickets are flat, in board → column → id order. A warning is emitted when the limit cuts the list.
 */
export function lsJson(cwd: string, opts: LsJsonOpts = {}): Result {
  const { full = false, limit = DEFAULT_LIMIT, ...filters } = opts;
  const r = createKanban({ dir: cwd }).list(filters);
  const all = r.boards.flatMap((b) => [...b.columns.flatMap((c) => c.tickets), ...b.unsorted]);
  const shown = limit > 0 ? all.slice(0, limit) : all;
  const truncated = shown.length < all.length;
  const warnings = r.warnings.map(fmtWarning);
  if (truncated) {
    warnings.push(
      `warning: showing ${shown.length} of ${all.length} tickets (limit ${limit}); use --limit <n>, or --limit 0 for all, or add filters`,
    );
  }
  const out = JSON.stringify(
    { total: all.length, shown: shown.length, limit, truncated, tickets: shown.map((t) => jsonTicket(t, full)) },
    null,
    2,
  );
  return { out, warnings };
}
