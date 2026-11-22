import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/web/server.js";

// MCP over HTTP on the `kb web` port: stateless request/response, same tools as stdio.
const TOOL_NAMES = [
  "kb_boards",
  "kb_search",
  "kb_read",
  "kb_create",
  "kb_update",
  "kb_move",
  "kb_comment",
  "kb_validate",
  "kb_fix",
  "kb_automations",
];

let dir: string;
let srv: RunningServer;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-mcphttp-"));
  fs.writeFileSync(path.join(dir, "kanban.yaml"), 'columns: [todo, doing, done]\nglob: "**/*.md"\n');
  fs.writeFileSync(path.join(dir, "1-a.md"), '---\ntype: ticket\nid: "1"\nname: Alpha\nstatus: todo\n---\nbody\n');
  srv = await startServer({ dir, port: 0 });
});
afterEach(async () => {
  await srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** One JSON-RPC message in, the raw response out (a notification may answer with no body at all). */
const post = async (body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(srv.url + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, text, json: text === "" ? undefined : JSON.parse(text) };
};

const rpc = async (method: string, params?: Record<string, unknown>, id: number | string = 1) =>
  post({ jsonrpc: "2.0", id, method, params });

describe("mcp over http", () => {
  it("answers initialize with a result", async () => {
    const r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "kb" } },
    });
    expect(typeof r.json.result.instructions).toBe("string");
  });

  it("lists the kb tools", async () => {
    const r = await rpc("tools/list");
    expect(r.status).toBe(200);
    expect(r.json.result.tools.map((t: any) => t.name)).toEqual(TOOL_NAMES);
  });

  it("runs a tool against the board on disk", async () => {
    const created = await rpc("tools/call", { name: "kb_create", arguments: { name: "From HTTP", body: "hi" } });
    expect(created.status).toBe(200);
    expect(created.json.result.isError).toBeUndefined();
    expect(created.json.result.structuredContent).toMatchObject({ id: "002", path: "002-from-http.md" });
    expect(
      fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .sort(),
    ).toEqual(["002-from-http.md", "1-a.md"]);

    const read = await rpc("tools/call", { name: "kb_read", arguments: { id: "2" } }, 2);
    expect(read.json).toMatchObject({ id: 2, result: { structuredContent: { id: "002", name: "From HTTP" } } });
  });

  it("answers a notification with 202 and no body", async () => {
    const r = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(r.status).toBe(202);
    expect(r.text).toBe("");
  });

  it("answers a batch with an array, dropping the notifications", async () => {
    const r = await post([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    expect(r.status).toBe(200);
    expect(r.json.map((m: any) => m.id)).toEqual([1, 2]);
    expect(r.json[0].result).toEqual({});
    expect(r.json[1].result.tools).toHaveLength(TOOL_NAMES.length);
  });

  it("passes JSON-RPC errors through with status 200", async () => {
    const unknown = await rpc("tools/call", { name: "kb_nope" });
    expect(unknown.status).toBe(200);
    expect(unknown.json.error).toMatchObject({ code: -32602, message: "unknown tool: kb_nope" });

    const method = await rpc("nope");
    expect(method.status).toBe(200);
    expect(method.json.error).toMatchObject({ code: -32601 });
  });

  it("rejects a body that is neither an object nor an array", async () => {
    expect((await post("5")).status).toBe(400);
    expect((await post("{nope")).status).toBe(400);
  });

  it("guards the route like the /api writes and refuses every method but POST", async () => {
    const crossOrigin = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { Origin: "http://evil.example" });
    expect(crossOrigin.status).toBe(403);

    const wrongType = await fetch(srv.url + "/mcp", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(wrongType.status).toBe(415);

    for (const method of ["GET", "DELETE"]) {
      const r = await fetch(srv.url + "/mcp", { method });
      expect(r.status).toBe(405);
      expect(await r.json()).toEqual({ error: "method not allowed", code: "method-not-allowed" });
    }
  });
});
