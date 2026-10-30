import { createKanban } from "../../core/index.js";
import { fmtId, fmtValue } from "../format.js";

export function show(cwd: string, id: string): string {
  const t = createKanban({ dir: cwd }).get(id);
  const out = [
    t.path,
    `#${fmtId(t.id)} ${t.name}`,
    `board: ${t.board}`,
    `status: ${t.status ?? "(none)"}`,
  ];
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
