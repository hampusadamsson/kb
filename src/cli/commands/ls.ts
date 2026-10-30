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
