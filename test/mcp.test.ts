import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createKanban } from "../src/core/index.js";
import { createEventLog } from "../src/eventLog.js";
import { LiveRuns } from "../src/liveRuns.js";
import { createShellRunner } from "../src/runner.js";
import { createTools, type ToolContext } from "../src/mcp/server.js";
import {
  PROTOCOL_VERSIONS,
  createDispatcher,
  runServer,
  type Dispatcher,
  type JsonRpcSuccess,
  type ToolCallResult,
} from "../src/mcp/protocol.js";

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

/** Usage guidance the MCP server advertises; the transport must relay it verbatim. */
const GUIDE = "Search first (kb_search) to find ids, then kb_read before kb_update.";

let dir: string;
let live: LiveRuns;
let runner: ReturnType<typeof createShellRunner>;
let dispatcher: Dispatcher;

/** Mirrors startMcpServer()'s wiring, minus the stdio transport. */
function context(d: string, opts: { automation?: boolean } = {}): ToolContext {
  const events = createEventLog(d);
  const registry = new LiveRuns();
  const r = opts.automation === false ? undefined : createShellRunner({ registry });
  return { kanban: () => createKanban({ dir: d, runner: r, events, source: "mcp" }), api: { runner: r, events, live: registry, dir: d } };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kbmcp-"));
  createKanban({ dir }).init();
  live = new LiveRuns();
  runner = createShellRunner({ registry: live });
  const events = createEventLog(dir);
  const ctx: ToolContext = { kanban: () => createKanban({ dir, runner, events, source: "mcp" }), api: { runner, events, live, dir } };
  dispatcher = createDispatcher({ tools: createTools(ctx), instructions: GUIDE });
});

afterEach(() => {
  runner.killAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const read = (rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");

const rpc = (method: string, params?: Record<string, unknown>, id: number | string = 1) =>
  dispatcher.handleMessage({ jsonrpc: "2.0", id, method, params }) as Promise<JsonRpcSuccess>;

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
  const res = await rpc("tools/call", { name, arguments: args });
  return res.result as ToolCallResult;
}

const text = (r: ToolCallResult): string => r.content.map((c) => c.text ?? "").join("\n");
const sc = (r: ToolCallResult): Record<string, unknown> => r.structuredContent ?? {};
const warnings = (r: ToolCallResult): string[] => sc(r).warnings as string[];

/** A ticket file written straight to disk (for states the tools cannot create). */
const ticket = (id: string | undefined, name: string, extra = "", body = "body\n") =>
  `---\ntype: ticket\n${id === undefined ? "" : `id: "${id}"\n`}name: ${name}\nstatus: todo\n${extra}---\n${body}`;

describe("initialize", () => {
  it("echoes a supported protocolVersion", async () => {
    for (const v of PROTOCOL_VERSIONS) {
      const r = (await rpc("initialize", { protocolVersion: v })).result as Record<string, unknown>;
      expect(r.protocolVersion).toBe(v);
    }
  });

  it("falls back to 2025-06-18 for an unknown or missing version", async () => {
    expect(((await rpc("initialize", { protocolVersion: "1999-01-01" })).result as any).protocolVersion).toBe("2025-06-18");
    expect(((await rpc("initialize", {})).result as any).protocolVersion).toBe("2025-06-18");
  });

  it("advertises tools, serverInfo kb and the instructions", async () => {
    const r = (await rpc("initialize", { protocolVersion: "2025-06-18" })).result as Record<string, any>;
    expect(r.capabilities).toEqual({ tools: {} });
    expect(r.capabilities.tools).toBeTypeOf("object");
    expect(r.serverInfo.name).toBe("kb");
    expect(r.serverInfo.version).toBeTypeOf("string");
    expect(r.instructions).toBe(GUIDE);
  });

  it("omits instructions when none were configured", async () => {
    const d = createDispatcher({ tools: createTools(context(dir)) });
    const r = (await d.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })) as JsonRpcSuccess;
    expect((r.result as Record<string, unknown>).instructions).toBeUndefined();
  });
});

describe("tools/list", () => {
  it("returns all 10 tools with inputSchema and annotations", async () => {
    const r = (await rpc("tools/list")).result as { tools: Record<string, any>[] };
    expect(r.tools.map((t) => t.name)).toEqual(TOOL_NAMES);
    for (const t of r.tools) {
      expect(t.description, t.name).toBeTypeOf("string");
      expect(t.inputSchema, t.name).toMatchObject({ type: "object" });
      expect(t.annotations, t.name).toBeTypeOf("object");
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint"])
        expect(t.annotations[hint], `${t.name}.${hint}`).toBeTypeOf("boolean");
    }
  });

  it("read-only tools say so; writers do not", async () => {
    const r = (await rpc("tools/list")).result as { tools: Record<string, any>[] };
    const annotations = Object.fromEntries(r.tools.map((t) => [t.name, t.annotations]));
    for (const name of ["kb_boards", "kb_search", "kb_read", "kb_validate"]) expect(annotations[name].readOnlyHint, name).toBe(true);
    for (const name of ["kb_create", "kb_update", "kb_move", "kb_comment", "kb_fix"])
      expect(annotations[name].readOnlyHint, name).toBe(false);
  });

  it("declares required arguments and schema bounds", async () => {
    const r = (await rpc("tools/list")).result as { tools: Record<string, any>[] };
    const byName = Object.fromEntries(r.tools.map((t) => [t.name, t]));
    expect(byName.kb_read.inputSchema.required).toEqual(["id"]);
    expect(byName.kb_move.inputSchema.required).toEqual(["id", "status"]);
    expect(byName.kb_comment.inputSchema.required).toEqual(["id", "text"]);
    expect(byName.kb_create.inputSchema.required).toEqual(["name"]);
    expect(byName.kb_search.inputSchema.properties.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 200, default: 20 });
  });
});

describe("tools/call", () => {
  it("kb_boards lists boards and columns", async () => {
    const r = await call("kb_boards");
    expect(r.isError).toBeUndefined();
    expect(sc(r)).toMatchObject({ name: "default", boards: [{ name: "default", columns: ["todo", "doing", "done"] }] });
    expect(text(r)).toContain("kb default");
    expect(text(r)).toContain("- default: todo, doing, done");
  });

  it("kb_search returns compact summaries without body/path/mtime", async () => {
    await call("kb_create", { name: "Fix login", body: "secret body text", labels: ["bug"] });
    const r = await call("kb_search", { text: "login" });
    const tickets = sc(r).tickets as Record<string, unknown>[];
    expect(tickets).toHaveLength(1);
    expect(Object.keys(tickets[0]).sort()).toEqual(["board", "id", "labels", "name", "status"]);
    expect(tickets[0]).toMatchObject({ id: "001", name: "Fix login", status: "todo", board: "default", labels: ["bug"] });
    expect(sc(r)).toMatchObject({ total: 1, limit: 20, truncated: false });
    expect(text(r)).toContain("#001 [todo] Fix login · default · bug");
    // neither the rendered text nor the structured payload may leak the body or filesystem details
    for (const blob of [JSON.stringify(r), text(r)]) {
      expect(blob).not.toContain("secret body text");
      expect(blob).not.toContain("001-fix-login.md");
      expect(blob).not.toMatch(/mtime/);
    }
  });

  it("kb_search truncates at limit and says so", async () => {
    for (const n of ["one", "two", "three"]) await call("kb_create", { name: n });
    const r = await call("kb_search", { limit: 2 });
    const tickets = sc(r).tickets as Record<string, unknown>[];
    expect(tickets).toHaveLength(2);
    expect(sc(r)).toMatchObject({ total: 3, limit: 2, truncated: true });
    expect(text(r)).toContain("2 of 3 matches");
    expect(text(r)).toContain("limit 2");
    expect((await call("kb_search")).structuredContent).toMatchObject({ truncated: false, total: 3 });
  });

  it("kb_read returns the body and automation status", async () => {
    write("042-auto.md", ticket("042", "Auto", "automations:\n  lint:\n    status: done\n    at: 2026-01-01\n", "body here\n"));
    const r = await call("kb_read", { id: "42" });
    expect(r.isError).toBeUndefined();
    expect(sc(r)).toMatchObject({ id: "042", name: "Auto", status: "todo", column: "todo", body: "body here\n" });
    expect(text(r)).toContain("body here");
    expect(text(r)).toContain("automations: lint=done");
    expect(sc(r).autos).toEqual([{ name: "lint", status: "done", at: "2026-01-01" }]);
    expect(sc(r).mtime).toBeTypeOf("number");
  });

  it("kb_create writes the ticket", async () => {
    const r = await call("kb_create", { name: "New ticket", body: "details", labels: ["ui"], properties: { priority: "high" } });
    expect(r.isError).toBeUndefined();
    expect(sc(r)).toMatchObject({ id: "001", path: "001-new-ticket.md" });
    expect(text(r)).toBe("created #001 (001-new-ticket.md)");
    const raw = read("001-new-ticket.md");
    expect(raw).toContain('id: "001"');
    expect(raw).toContain("priority: high");
    expect(raw).toContain("details");
  });

  it("kb_update changes name, labels and body", async () => {
    await call("kb_create", { name: "Old name" });
    const r = await call("kb_update", { id: "001", name: "New name", addLabels: ["api"], setProps: { size: "S" }, body: "rewritten" });
    expect(r.isError).toBeUndefined();
    expect(sc(r).mtime).toBeTypeOf("number");
    expect(text(r)).toMatch(/^updated #001 \(mtime \d/);
    const after = await call("kb_read", { id: "1" });
    expect(sc(after)).toMatchObject({ name: "New name", labels: ["api"], props: { size: "S" }, body: "rewritten\n" });
  });

  it("kb_move moves between columns", async () => {
    await call("kb_create", { name: "Movable" });
    const r = await call("kb_move", { id: "001", status: "doing" });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toMatch(/^moved #001 to doing \(mtime \d/);
    expect(sc(await call("kb_read", { id: "001" }))).toMatchObject({ status: "doing", column: "doing" });
  });

  it("kb_comment appends a comment", async () => {
    await call("kb_create", { name: "Commented" });
    const r = await call("kb_comment", { id: "001", text: "first note" });
    expect(r.isError).toBeUndefined();
    expect(sc(r).key).toBeTypeOf("string");
    expect(text(r)).toMatch(/^commented #001 \(key \d{4}-\d\d-\d\dT\d\d:\d\d\)$/);
    expect(text(await call("kb_read", { id: "001" }))).toContain("first note");
  });

  it("kb_validate reports a clean board and then errors", async () => {
    const clean = await call("kb_validate");
    expect(clean.isError).toBeUndefined();
    expect(sc(clean).issues).toEqual([]);
    expect(text(clean)).toBe("ok: no issues");
    write("bad.md", ticket("009", "Bad", "status: nope\n"));
    const bad = await call("kb_validate");
    expect((sc(bad).errors as unknown[]).length).toBeGreaterThan(0);
    expect(text(bad)).toMatch(/^\d+ error\(s\), \d+ warning\(s\)\nerror: bad\.md: /);
  });

  it("kb_fix is a dry run unless dryRun:false", async () => {
    write("loose.md", ticket(undefined, "Loose"));
    const before = read("loose.md");
    const dry = await call("kb_fix");
    expect(sc(dry)).toMatchObject({ dryRun: true, changes: [{ path: "loose.md", to: "001" }] });
    expect(text(dry)).toContain("dry run: 1 id change(s)");
    expect(text(dry)).toContain("pass dryRun: false");
    expect(read("loose.md")).toBe(before);
    const real = await call("kb_fix", { dryRun: false });
    expect(sc(real)).toMatchObject({ dryRun: false, changes: [{ path: "loose.md", to: "001" }] });
    expect(text(real)).not.toContain("dry run");
    expect(read("loose.md")).toContain('id: "001"');
    expect(text(await call("kb_fix"))).toBe("ok: nothing to fix");
  });

  it("kb_automations lists live runs", async () => {
    live.add(
      {
        runId: "run-1",
        kind: "rule",
        board: "default",
        rule: "lint",
        ticketId: "001",
        ticketName: "Linted",
        command: "npm test",
        pid: process.pid,
        startedAt: new Date().toISOString(),
        timeoutMs: null,
      },
      () => true,
    );
    const r = await call("kb_automations");
    expect(r.isError).toBeUndefined();
    expect((sc(r).runs as unknown[]).length).toBe(1);
    expect(text(r)).toContain("1 run(s)");
    expect(text(r)).toContain("lint #001");
    expect(text(r)).toContain("npm test");
  });

  it("kb_automations says so when automations are disabled", async () => {
    const d = createDispatcher({ tools: createTools(context(dir, { automation: false })) });
    const r = (await d.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kb_automations", arguments: {} } }))
      .result as ToolCallResult;
    expect(r.structuredContent).toMatchObject({ runs: [], disabled: true });
    expect(text(r)).toBe("automations are disabled");
  });
});

describe("validation", () => {
  it("rejects non-string list members instead of silently dropping them", async () => {
    await call("kb_create", { name: "Labeled", body: "x", labels: ["bug"] });
    // A filtered-out non-string member used to degrade into "no filter" / "no labels requested".
    const search = await call("kb_search", { label: ["bug", 1] });
    expect(search.isError).toBe(true);
    expect(sc(search).code).toBe("invalid");
    expect(text(search)).toContain("label");
    expect(text(search)).toContain("strings");

    const create = await call("kb_create", { name: "Bad labels", labels: ["ui", 2] });
    expect(create.isError).toBe(true);
    expect(text(create)).toContain("labels");
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".md"))).toHaveLength(1);

    const update = await call("kb_update", { id: "001", addLabels: ["api", null] });
    expect(update.isError).toBe(true);
    expect(text(update)).toContain("addLabels");
    expect(sc(await call("kb_read", { id: "001" }))).toMatchObject({ labels: ["bug"] });

    const property = await call("kb_search", { property: { a: 1 } });
    expect(property.isError).toBe(true);
    expect(text(property)).toContain("property");
  });

  it("clamps limit to the advertised maximum of 200", async () => {
    for (const n of ["one", "two", "three"]) await call("kb_create", { name: n });
    const r = await call("kb_search", { limit: 5000 });
    expect(r.isError).toBeUndefined();
    expect(sc(r)).toMatchObject({ total: 3, limit: 200, truncated: false });
    expect(sc(r).tickets).toHaveLength(3);
    // below the minimum the floor still applies
    expect(sc(await call("kb_search", { limit: 0 }))).toMatchObject({ limit: 1, truncated: true });
  });
});

describe("stdio transport", () => {
  /** Drives runServer with an injected stdin/stdout pair and collects the framed responses. */
  async function transport(chunks: string[]): Promise<{ responses: Record<string, any>[]; raw: string }> {
    let raw = "";
    const stdin = (async function* () {
      for (const c of chunks) yield c;
    })();
    await runServer({
      tools: createTools(context(dir)),
      stdin,
      stdout: {
        write(chunk: string) {
          raw += chunk;
          return true;
        },
      },
    });
    const responses = raw
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, any>);
    return { responses, raw };
  }

  it("caps an oversized line, drops it and reports a parse error", async () => {
    const huge = "x".repeat(9 * 1024 * 1024);
    const { responses, raw } = await transport([
      huge,
      // the newline only arrives on a later chunk; the tail must be discarded, not parsed
      `"tail-of-the-dropped-line"}\n`,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n",
    ]);
    expect(raw.length).toBeLessThan(huge.length);
    expect(responses).toHaveLength(2);
    expect(responses[0]).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32700 } });
    expect(responses[0].error.message).toContain("too long");
    expect(responses[1]).toMatchObject({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("keeps accepting lines after an oversized one is dropped", async () => {
    const { responses } = await transport([
      "y".repeat(9 * 1024 * 1024) + "\n",
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n",
    ]);
    expect(responses).toHaveLength(2);
    expect(responses[0].error.code).toBe(-32700);
    expect((responses[1].result as { tools: unknown[] }).tools).toHaveLength(TOOL_NAMES.length);
  });

  it("leaves the process globals alone when stdout is injected, and restores them otherwise", async () => {
    const originalWrite = process.stdout.write;
    const originalLog = console.log;
    // injected stdout: nothing may be redirected, not even for the duration of the call
    const seen: string[] = [];
    const stdin = (async function* () {
      yield JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n";
    })();
    await runServer({
      stdin,
      stdout: {
        write: (chunk: string) => (seen.push(chunk), true),
      },
    });
    expect(process.stdout.write).toBe(originalWrite);
    expect(console.log).toBe(originalLog);
    expect(seen.join("")).toContain('"id":1');

    // default stdout (the real process.stdout): redirected during the run, restored after it
    let redirectedDuringRun = false;
    const empty = (async function* () {
      yield "";
      redirectedDuringRun = process.stdout.write !== originalWrite && console.log !== originalLog;
    })();
    await runServer({ stdin: empty });
    expect(redirectedDuringRun).toBe(true);
    expect(process.stdout.write).toBe(originalWrite);
    expect(console.log).toBe(originalLog);
  });

  it("swallows a failing write (EPIPE / unserialisable) instead of throwing", async () => {
    const stdin = (async function* () {
      yield JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n";
      yield JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) + "\n";
    })();
    let calls = 0;
    await expect(
      runServer({
        stdin,
        stdout: {
          write() {
            calls += 1;
            throw new Error("EPIPE");
          },
        },
      }),
    ).resolves.toBeUndefined();
    // both responses were attempted; neither failure escaped
    expect(calls).toBe(2);
  });

  it("does not let a slow tool call block later lines (ping / notifications/cancelled stay responsive)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const tools = [
      {
        name: "slow",
        handler: async () => {
          await gate;
          return { content: [] };
        },
      },
    ];
    let raw = "";
    const until = async (cond: () => boolean): Promise<void> => {
      const deadline = Date.now() + 5000;
      while (!cond()) {
        if (Date.now() > deadline) throw new Error("timed out waiting for the server");
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    const stdin = (async function* () {
      yield JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow" } }) + "\n";
      yield JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }) + "\n";
      yield JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) + "\n";
      // Both later lines must have been read and answered while `slow` is still blocked.
      await until(() => raw.includes('"id":2'));
      expect(raw).not.toContain('"id":1');
      release();
    })();
    await expect(
      runServer({
        tools,
        stdin,
        stdout: {
          write(chunk: string) {
            raw += chunk;
            return true;
          },
        },
      }),
    ).resolves.toBeUndefined();
    release();
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    // The notification answered nothing, the ping answered first, the slow call answered last.
    expect(lines.filter((l) => l.includes('"method"'))).toHaveLength(0);
    expect(lines.map((l) => JSON.parse(l).id)).toEqual([2, 1]);
  }, 10000);

  it("swallows an unserialisable response (BigInt in structuredContent)", async () => {
    const tools = [
      {
        name: "big",
        handler: () => ({ content: [], structuredContent: { n: 1n as unknown as number } }),
      },
    ];
    let raw = "";
    const stdin = (async function* () {
      yield JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "big" } }) + "\n";
      yield JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) + "\n";
    })();
    await expect(
      runServer({
        tools,
        stdin,
        stdout: {
          write(chunk: string) {
            raw += chunk;
            return true;
          },
        },
      }),
    ).resolves.toBeUndefined();
    // The bad response is dropped, the server keeps going.
    expect(raw).not.toContain('"id":1');
    expect(raw).toContain('"id":2');
  });
});

describe("errors", () => {
  it("kb_read on a missing id is an isError result with an actionable hint, not a throw", async () => {
    const pending = rpc("tools/call", { name: "kb_read", arguments: { id: "404" } });
    await expect(pending).resolves.toBeDefined();
    const r = (await pending).result as ToolCallResult;
    expect(r.isError).toBe(true);
    expect(sc(r)).toEqual({ error: "no ticket 404", code: "not-found" });
    expect(text(r)).toContain("no ticket 404");
    expect(text(r)).toContain("kb_search");
    expect(text(r)).toContain("kb_read");
  });

  it("missing required arguments are tool errors, not JSON-RPC errors", async () => {
    const noId = await call("kb_read", {});
    expect(noId.isError).toBe(true);
    expect(sc(noId).code).toBe("invalid");
    const noStatus = await call("kb_move", { id: "001" });
    expect(noStatus.isError).toBe(true);
    expect(text(noStatus)).toContain("status is required");
  });

  it("a present but malformed id is an invalid request, not a coerced null", async () => {
    for (const bad of [true, {}, [], false]) {
      const res = (await dispatcher.handleMessage({ jsonrpc: "2.0", id: bad, method: "ping" })) as any;
      expect(res.jsonrpc, JSON.stringify(bad)).toBe("2.0");
      expect(res.id, JSON.stringify(bad)).toBeNull();
      expect(res.error.code, JSON.stringify(bad)).toBe(-32600);
      expect(res.error.message).toContain("id");
      expect(res.result).toBeUndefined();
    }
    // A null id is legal and must still be echoed, not rejected.
    const nul = (await dispatcher.handleMessage({ jsonrpc: "2.0", id: null, method: "ping" })) as any;
    expect(nul).toMatchObject({ jsonrpc: "2.0", id: null, result: {} });
  });

  it("a request whose handler resolves to undefined gets -32603 instead of silence", async () => {
    const silence = createDispatcher({
      tools: [{ name: "void", handler: () => undefined as unknown as ToolCallResult }],
    });
    const res = (await silence.handleMessage({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "void" } })) as any;
    expect(res.id).toBe(9);
    expect(res.error.code).toBe(-32603);
    expect(res.result).toBeUndefined();
    // Notifications stay silent: a client that sent none is not waiting for a reply.
    await expect(silence.handleMessage({ jsonrpc: "2.0", method: "tools/call", params: { name: "void" } })).resolves.toBeUndefined();
  });

  it("unknown tools are JSON-RPC errors (invalid params)", async () => {
    const res = (await dispatcher.handleMessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "kb_nope" } })) as any;
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toContain("unknown tool: kb_nope");
  });
});

describe("warnings", () => {
  it("ride in structuredContent.warnings and as ⚠ lines in the text", async () => {
    write("dup1.md", ticket("5", "A"));
    write("dup2.md", ticket("5", "B"));
    const r = await call("kb_search");
    expect(warnings(r)).toEqual(["duplicate id 5: dup1.md, dup2.md"]);
    expect(text(r)).toContain("⚠ duplicate id 5: dup1.md, dup2.md");
    for (const w of warnings(r)) expect(text(r)).toContain(`⚠ ${w}`);
  });

  it("are not errors, and come from creates too", async () => {
    const r = await call("kb_create", { name: "Unsorted", status: "nope" });
    expect(r.isError).toBeUndefined();
    expect(warnings(r)).toHaveLength(1);
    expect(warnings(r)[0]).toContain('status "nope" is not a column');
    expect(text(r)).toContain(`⚠ ${warnings(r)[0]}`);
    expect(text(r).startsWith("created #001")).toBe(true);
  });

  it("are absent (empty array) when the board is clean", async () => {
    const r = await call("kb_boards");
    expect(warnings(r)).toEqual([]);
    expect(text(r)).not.toContain("⚠");
  });
});
