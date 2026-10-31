import { createKanban } from "../../core/index.js";
import { fmtId, fmtValue } from "../format.js";

export interface ShowOpts {
  /** board to look in; "all" (or --all/-a) searches every board. Defaults to the config's default board. */
  board?: string;
  /** shorthand for board: "all" */
  all?: boolean;
}

/** Resolve the board selector: --all wins, then --board, else the config default. */
export function resolveBoard(board: string | undefined, all: boolean | undefined, fallback: string): string {
  if (all) return "all";
  return board ?? fallback;
}

export function show(cwd: string, id: string, o: ShowOpts = {}): string {
  const kb = createKanban({ dir: cwd });
  // The default board is the config's name, so a bare `kb show 31` means "ticket 31 on the default board".
  const t = kb.get(id, { board: resolveBoard(o.board, o.all, kb.load().config.name) });
  const out = [t.path, `#${fmtId(t.id)} ${t.name}`, `board: ${t.board}`, `status: ${t.status ?? "(none)"}`];
  if (t.labels.length) out.push(`labels: ${t.labels.map((l) => `[${l}]`).join(" ")}`);
  for (const [k, v] of Object.entries(t.props)) out.push(`${k}: ${fmtValue(v)}`);
  const body = t.body.replace(/^\n+/, "").trimEnd();
  if (body) out.push("", body);
  const cs = Object.entries(t.comments);
  if (cs.length) {
    out.push("", "comments:");
    for (const [k, v] of cs) out.push(`${k}  ${v}`);
  }
  return out.join("\n");
}
