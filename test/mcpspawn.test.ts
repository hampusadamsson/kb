import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createKanban } from "../src/core/index.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kbmcpspawn-"));
  createKanban({ dir }).init();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

interface Run {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Spawns `kb mcp --dir <dir>`, feeds the messages as newline-delimited JSON, and collects both streams. */
function run(messages: unknown[]): Promise<Run> {
  const main = path.resolve(import.meta.dirname, "../dist/cli/main.js");
  const child = spawn(process.execPath, [main, "mcp", "--dir", dir], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
  child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
  const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  for (const m of messages) child.stdin.write(JSON.stringify(m) + "\n");
  // Closing stdin is how an MCP client shuts the server down; it must exit on its own.
  child.stdin.end();
  return exited.then((code) => ({ stdout, stderr, code }));
}

describe("kb mcp over stdio", () => {
  it("answers newline-delimited JSON-RPC on stdout and exits on stdin close", async () => {
    const r = await run([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "kb_create", arguments: { name: "From MCP" } } },
    ]);

    // stdout-corruption guard: MCP framing is the only thing allowed on stdout, so every non-empty
    // line must be a complete JSON-RPC 2.0 message. Nothing may be interleaved with it.
    const lines = r.stdout.split("\n").filter((l) => l.trim() !== "");
    for (const line of lines) {
      const msg = JSON.parse(line) as { jsonrpc?: string; id?: unknown };
      expect(msg.jsonrpc).toBe("2.0");
      expect(msg.id).toBeTypeOf("number");
    }

    // ...and the three responses must actually be there, in order. A client that sees nothing on stdout
    // has no way to proceed, so an empty stream is as broken as a corrupt one.
    expect(lines, `no JSON-RPC responses on stdout; stderr had: ${r.stderr}`).toHaveLength(3);
    const [init, list, created] = lines.map((l) => JSON.parse(l) as { id: number; result: any; error?: unknown });
    expect(init.id).toBe(1);
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "kb" }, capabilities: { tools: {} } });
    expect(init.result.instructions).toContain("kb_search");
    expect(list.id).toBe(2);
    expect(list.result.tools.map((t: { name: string }) => t.name)).toHaveLength(10);
    expect(created.id).toBe(3);
    expect(created.error).toBeUndefined();
    expect(created.result.structuredContent).toMatchObject({ id: "001", path: "001-from-mcp.md" });
    expect(created.result.content[0].text).toBe("created #001 (001-from-mcp.md)");

    // The write really landed on disk, and the process exited cleanly without a signal.
    expect(fs.readFileSync(path.join(dir, "001-from-mcp.md"), "utf8")).toContain("From MCP");
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("error:");
  }, 20000);
});
