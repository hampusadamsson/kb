import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILE, KanbanError } from "../../core/index.js";
import { startMcpServer } from "../../mcp/server.js";

export interface McpOpts {
  dir?: string;
  automation?: boolean; // false for --no-automation
}

/**
 * Run kb as an MCP server on stdio over the board in `opts.dir` (default: cwd).
 * Nothing may be printed to stdout here: it is the JSON-RPC channel.
 */
export async function mcp(cwd: string, opts: McpOpts): Promise<void> {
  const dir = path.resolve(cwd, opts.dir ?? ".");
  if (!fs.existsSync(path.join(dir, CONFIG_FILE))) {
    throw new KanbanError("config", `${CONFIG_FILE} not found in ${dir} (run \`kb init\`)`);
  }
  await startMcpServer({ dir, automation: opts.automation });
}
