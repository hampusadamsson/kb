import { CONFIG_FILE, createKanban } from "../../core/index.js";

export function init(cwd: string): string {
  createKanban({ dir: cwd }).init();
  return `created ${CONFIG_FILE}`;
}
