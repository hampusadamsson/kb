import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { startServer, type RunningServer } from "../src/web/server.js";

const main = path.resolve(import.meta.dirname, "../dist/cli/main.js");
let dir: string;
let srv: RunningServer;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-webev-"));
  fs.writeFileSync(path.join(dir, "kanban.yaml"), "columns: [todo, done]\n");
  srv = await startServer({ dir, port: 0 });
});
afterEach(async () => {
  await srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const J = { "content-type": "application/json" };
const get = async (q = "") => {
  const r = await fetch(`${srv.url}/api/events${q}`);
  return { status: r.status, json: (await r.json()) as any };
};
const post = (p: string, b: unknown, m = "POST") => fetch(srv.url + p, { method: m, headers: J, body: JSON.stringify(b) });

describe("GET /api/events", () => {
  it("returns web-sourced events newest first, with filters", async () => {
    const c = (await (await post("/api/tickets", { name: "Alpha" })).json()) as any;
    await post(`/api/tickets/${c.id}`, { status: "done" }, "PATCH");
    await post(`/api/tickets/${c.id}/comments`, { text: "hello" });
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.json.events.map((e: any) => e.type)).toEqual(["ticket.comment", "ticket.moved", "ticket.created"]);
    expect(r.json.events.every((e: any) => e.source === "web")).toBe(true);
    expect(r.json.nextCursor).toBeUndefined();
    expect((await get("?type=ticket.moved")).json.events).toHaveLength(1);
    expect((await get("?type=ticket.moved,ticket.created")).json.events).toHaveLength(2);
    expect((await get(`?ticket=${c.id}&q=HELLO`)).json.events).toHaveLength(1);
    expect((await get("?source=cli")).json.events).toHaveLength(0);
    expect((await get("?board=default")).json.events).toHaveLength(3);
    const p1 = await get("?limit=2");
    expect(p1.json.events).toHaveLength(2);
    const p2 = await get(`?limit=2&before=${p1.json.nextCursor}`);
    expect(p2.json.events.map((e: any) => e.type)).toEqual(["ticket.created"]);
  });

  it("validates limit", async () => {
    for (const l of ["0", "201", "abc", "1.5", "-1"]) expect((await get(`?limit=${l}`)).status).toBe(400);
    expect((await get("?limit=200")).status).toBe(200);
  });

  it("log writes do not trigger SSE refresh (.kb ignored)", async () => {
    const ac = new AbortController();
    const res = await fetch(srv.url + "/api/stream", { signal: ac.signal });
    const reader = res.body!.getReader();
    let buf = "";
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += new TextDecoder().decode(value);
        }
      } catch {
        // aborted
      }
    })();
    await new Promise((r) => setTimeout(r, 200));
    fs.mkdirSync(path.join(dir, ".kb"), { recursive: true });
    fs.appendFileSync(path.join(dir, ".kb", "events.log"), "{}\n");
    await new Promise((r) => setTimeout(r, 600));
    ac.abort();
    expect(buf).not.toContain("changed");
  });
});

describe("CLI events (e2e)", () => {
  it("kb add + kb mv log source cli; KB_AUTOMATION logs automation", async () => {
    const run = (args: string[], env: Record<string, string> = {}) => {
      const e = { ...process.env, ...env };
      if (!env.KB_AUTOMATION) delete e.KB_AUTOMATION;
      return spawnSync("node", [main, ...args], { cwd: dir, env: e, encoding: "utf8" });
    };
    const a = run(["add", "Task"]);
    expect(a.status).toBe(0);
    const id = /#(\S+)/.exec(a.stdout)![1];
    expect(run(["mv", id, "done"]).status).toBe(0);
    expect(run(["set", id, "-n", "Renamed"], { KB_AUTOMATION: "1" }).status).toBe(0);
    const r = await get();
    expect(r.json.events.map((e: any) => [e.type, e.source])).toEqual([
      ["ticket.renamed", "automation"],
      ["ticket.moved", "cli"],
      ["ticket.created", "cli"],
    ]);
  });
});
