import { createKanban } from "../../core/index.js";

export function boards(cwd: string): string {
  return createKanban({ dir: cwd }).boards().join("\n");
}
