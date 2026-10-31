import { eventOpts } from "../automation.js";
import { createKanban } from "../../core/index.js";

export function fix(cwd: string, dryRun = false): string {
  const changes = createKanban({ dir: cwd, ...eventOpts(cwd) }).fix({ dryRun });
  const out = changes.map(
    (c) => `${dryRun ? "(dry-run) " : ""}${c.path}: id ${c.from === undefined ? "(none)" : String(c.from)} -> ${c.to}`,
  );
  return out.length ? out.join("\n") : "nothing to fix";
}
