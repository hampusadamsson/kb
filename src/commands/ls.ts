import { columnsFor, loadConfig } from "../config.js";
import { duplicates, hasFilters, hasId, matches, type Filters, orderedBoards, scan, sortTickets, UNSORTED, type Ticket } from "../tickets.js";
import { fmtId, fmtValue, makeStyle, type Result } from "./format.js";

export interface LsOpts extends Filters {
  board?: string;
  color?: boolean;
}

function line(t: Ticket, s: ReturnType<typeof makeStyle>): string {
  const tags = [
    ...t.labels.map((l) => `[${l}]`),
    ...Object.entries(t.props).map(([k, v]) => `${k}:${fmtValue(v)}`),
  ];
  const head = `  #${fmtId(t.id)} ${t.name}`;
  return tags.length ? `${head}   ${s.dim(tags.join(" "))}` : head;
}

export function ls(cwd: string, opts: LsOpts = {}): Result {
  const config = loadConfig(cwd);
  const { tickets, diagnostics } = scan(cwd, config);
  const s = makeStyle(opts.color ?? false);
  const all = orderedBoards(tickets, config);
  if (opts.board !== undefined && !all.includes(opts.board)) {
    throw new Error(`unknown board "${opts.board}" (boards: ${all.join(", ")})`);
  }
  const names = opts.board !== undefined ? [opts.board] : all;
  const out: string[] = [];
  const warnings: string[] = [];

  for (const d of diagnostics) warnings.push(`warning: ${d.path}: ${d.message}`);
  for (const t of tickets) {
    if (!hasId(t)) warnings.push(`warning: ${t.path}: ticket has no id`);
  }
  for (const g of duplicates(tickets)) {
    warnings.push(`warning: duplicate id ${String(g[0].id)}: ${g.map((t) => t.path).join(", ")}`);
  }

  for (const board of names) {
    for (const t of sortTickets(tickets.filter((t) => t.board === board && t.column === UNSORTED))) {
      const why = t.status === undefined ? "missing status" : `unknown status "${t.status}"`;
      warnings.push(`warning: ${t.path}: unsorted (${why})`);
    }
  }

  const filtered = hasFilters(opts);
  for (const board of names) {
    const mine = tickets.filter((t) => t.board === board && matches(t, opts));
    if (filtered && mine.length === 0) continue;
    out.push(s.bold(`== ${board} ==`));
    for (const col of columnsFor(config, board)) {
      const ts = sortTickets(mine.filter((t) => t.column === col));
      out.push(s.bold(`${col} (${ts.length})`));
      for (const t of ts) out.push(line(t, s));
    }
    const uns = sortTickets(mine.filter((t) => t.column === UNSORTED));
    if (uns.length) {
      out.push(s.bold(`${UNSORTED} (${uns.length})`));
      for (const t of uns) out.push(line(t, s));
    }
    out.push("");
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return { out: out.join("\n"), warnings };
}
