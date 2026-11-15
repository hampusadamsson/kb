import { eventOpts } from "../automation.js";
import { createKanban } from "../../core/index.js";

export function fix(cwd: string, dryRun = false): string {
  const kb = createKanban({ dir: cwd, ...eventOpts(cwd) });
  // Ids are file names in this mode and files are never renamed, so there is nothing to write.
  if (kb.load().config.ticketId === "filename") {
    return "ticketId is filename: ids come from file names, so ids cannot be fixed here — rename the files instead";
  }
  const changes = kb.fix({ dryRun });
  const out = changes.map(
    (c) => `${dryRun ? "(dry-run) " : ""}${c.path}: id ${c.from === undefined ? "(none)" : String(c.from)} -> ${c.to}`,
  );
  return out.length ? out.join("\n") : "nothing to fix";
}
