import { loadConfig } from "../config.js";
import { boardNames, scan } from "../tickets.js";

export function orderedBoards(tickets: ReturnType<typeof scan>["tickets"], config: ReturnType<typeof loadConfig>): string[] {
  const [first, ...rest] = [config.name, ...boardNames(tickets, config).filter((b) => b !== config.name).sort()];
  return [first, ...rest];
}

export function boards(cwd: string): string {
  const config = loadConfig(cwd);
  const { tickets } = scan(cwd, config);
  return orderedBoards(tickets, config).join("\n");
}
