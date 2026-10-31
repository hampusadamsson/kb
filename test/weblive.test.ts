import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { LiveRuns } from "../src/liveRuns.js";
import { createShellRunner } from "../src/runner.js";
import { startServer, type RunningServer } from "../src/web/server.js";

let dir: string;
let srv: RunningServer | undefined;
let live: LiveRuns;
const runner = () => createShellRunner({ registry: live });

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Local timestamp like the owner writes it (no zone → parsed as local). */
const nowLocal = (): string => {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-weblive-"));
  fs.writeFileSync(
    path.join(dir, "kanban.yaml"),
    "columns: [todo, done]\nautomations:\n  - name: slow\n    when: { moved_to: done }\n    run: sleep 30\n",
  );
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
    const lines = fs
      .readFileSync(path.join(dir, ".kb", "events.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
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

  it("merges runs started by another process (frontmatter only)", async () => {
    // A run this server did not start: only its ticket frontmatter exists.
    const child = spawn("bash", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
    await until(() => alive(child.pid!));
    fs.writeFileSync(
      path.join(dir, "a.md"),
      `---\ntype: ticket\nid: 1\nname: Alpha\nstatus: done\nautomations:\n  slow: { status: running, at: "${nowLocal()}", pid: ${child.pid}, pgid: ${child.pid}, runs: 1 }\n---\n`,
    );
    srv = await startServer({ dir, port: 0, runner: runner(), live });
    const list = (await req("GET", "/api/automation/runs")).json.runs;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      runId: "ticket:default:1:slow",
      kind: "rule",
      rule: "slow",
      ticketId: "1",
      ticketName: "Alpha",
      command: "sleep 30",
      pid: child.pid,
      output: "",
      external: true,
    });
    expect(list[0].elapsedMs).toBeGreaterThanOrEqual(0);
    // The synthetic id is killable through the persisted pid.
    const k = await req("POST", `/api/automation/runs/${encodeURIComponent(list[0].runId)}/kill`);
    expect(k).toMatchObject({ status: 202, json: { ok: true } });
    await until(() => !alive(child.pid!));
    expect((await req("GET", "/api/automation/runs")).json.runs).toEqual([]);
  });
  it("a run started by this server is not duplicated", async () => {
    srv = await startServer({ dir, port: 0, runner: runner(), live });
    expect((await req("PATCH", "/api/tickets/1", { status: "done" })).status).toBe(200);
    await until(async () => (await req("GET", "/api/automation/runs")).json.runs.length === 1);
    // Give the overview a running entry too; the registry copy must win, not add a second row.
    await until(() => /status: running/.test(fs.readFileSync(path.join(dir, "a.md"), "utf8")));
    const runs = (await req("GET", "/api/automation/runs")).json.runs;
    expect(runs).toHaveLength(1);
    expect(runs[0].external).toBeUndefined();
    await req("POST", `/api/automation/runs/${runs[0].runId}/kill`);
    await srv.settled();
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
