import { loadConfig } from "../config.js";
import { orderedBoards, scan } from "../tickets.js";

export function boards(cwd: string): string {
  const config = loadConfig(cwd);
  const { tickets } = scan(cwd, config);
  return orderedBoards(tickets, config).join("\n");
}
