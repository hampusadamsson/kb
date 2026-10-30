import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LiveRuns } from "../src/liveRuns.js";
import { createShellRunner } from "../src/runner.js";
import { startServer, type RunningServer } from "../src/web/server.js";

let dir: string;
let srv: RunningServer | undefined;
let live: LiveRuns;
const runner = () => createShellRunner({ registry: live });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-weblive-"));
  fs.writeFileSync(path.join(dir, "kanban.yaml"), "columns: [todo, done]\nautomations:\n  - name: slow\n    when: { moved_to: done }\n    run: sleep 30\n");
  fs.writeFileSync(path.join(dir, "a.md"), "---\ntype: ticket\nid: 1\nname: Alpha\nstatus: todo\n---\n");
  live = new LiveRuns();
});
afterEach(async () => {
  live.clear();
  await srv?.close();
  srv = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

const until = async (f: () => boolean | Promise<boolean>, ms = 5000) => {
  const t0 = Date.now();
  while (!(await f())) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
};
const req = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(srv!.url + p, {
    method,
    headers: method === "GET" ? headers : { "content-type": "application/json", ...headers },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  return { status: r.status, json: (await r.json()) as any };
};

describe("live runs API", () => {
  it("lists a running rule, kills it, records failure", async () => {
    srv = await startServer({ dir, port: 0, runner: runner(), live });
    expect((await req("PATCH", "/api/tickets/1", { status: "done" })).status).toBe(200);
    await until(async () => (await req("GET", "/api/automation/runs")).json.runs.length === 1);
    const run = (await req("GET", "/api/automation/runs")).json.runs[0];
    expect(run).toMatchObject({ kind: "rule", rule: "slow", ticketId: "1", ticketName: "Alpha", command: "sleep 30", timeoutMs: null });
    expect(run.pid).toBeGreaterThan(0);
    expect(typeof run.elapsedMs).toBe("number");
    expect(run.startedAt).toMatch(/[+-]\d\d:\d\d$|Z$/);
    const k = await req("POST", `/api/automation/runs/${run.runId}/kill`);
    expect(k).toMatchObject({ status: 202, json: { ok: true } });
    await srv.settled();
    expect((await req("GET", "/api/automation/runs")).json.runs).toEqual([]);
    expect((await req("POST", `/api/automation/runs/${run.runId}/kill`)).status).toBe(404);
    const file = fs.readFileSync(path.join(dir, "a.md"), "utf8");
    expect(file).toMatch(/status: failed/);
    expect(file).toMatch(/error: killed by user/);
    const lines = fs.readFileSync(path.join(dir, ".kb", "events.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const fin = lines.find((e) => e.type === "automation.finished");
    expect(fin.data).toMatchObject({ killed: true, error: "killed by user", status: "failed" });
    expect(fin.source).toBe("web");
  });

  it("test runs appear and are killable", async () => {
    srv = await startServer({ dir, port: 0, runner: runner(), live });
    const p = req("POST", "/api/automation/test", { run: "sleep 30" });
    await until(async () => (await req("GET", "/api/automation/runs")).json.runs.length === 1);
    const run = (await req("GET", "/api/automation/runs")).json.runs[0];
    expect(run.kind).toBe("test");
    expect((await req("POST", `/api/automation/runs/${run.runId}/kill`)).status).toBe(202);
    const r = await p;
    expect(r.json.result.error).toBe("killed by user");
  });

  it("404 unknown, 405 wrong method, 403 foreign origin", async () => {
    srv = await startServer({ dir, port: 0, runner: runner(), live });
    expect((await req("POST", "/api/automation/runs/nope/kill")).status).toBe(404);
    expect((await req("GET", "/api/automation/runs/nope/kill")).status).toBe(405);
    expect((await req("POST", "/api/automation/runs", {})).status).toBe(405);
    expect((await req("POST", "/api/automation/runs/nope/kill", {}, { origin: "http://evil.example" })).status).toBe(403);
  });

  it("disabled server → empty list", async () => {
    srv = await startServer({ dir, port: 0 });
    expect(await req("GET", "/api/automation/runs")).toMatchObject({ status: 200, json: { runs: [], disabled: true } });
    expect((await req("POST", "/api/automation/runs/x/kill")).status).toBe(404);
  });

  it("SSE sends a runs event on start and finish", async () => {
    srv = await startServer({ dir, port: 0, runner: runner(), live });
    const ac = new AbortController();
    const res = await fetch(srv.url + "/api/stream", { signal: ac.signal });
    const reader = res.body!.getReader();
    let text = "";
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          text += new TextDecoder().decode(value);
        }
      } catch {
        // aborted
      }
    })();
    await req("PATCH", "/api/tickets/1", { status: "done" });
    await until(() => text.includes("event: runs"));
    const id = (await req("GET", "/api/automation/runs")).json.runs[0].runId;
    const before = text.split("event: runs").length;
    await req("POST", `/api/automation/runs/${id}/kill`);
    await until(() => text.split("event: runs").length > before);
    ac.abort();
  });
});
