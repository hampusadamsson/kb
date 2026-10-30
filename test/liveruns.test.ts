import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LiveRuns, OUTPUT_TAIL } from "../src/liveRuns.js";
import { createShellRunner } from "../src/runner.js";
import { createKanban } from "../src/core/index.js";
import type { KbEvent } from "../src/core/events.js";

const cwd = process.cwd();
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (f: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("LiveRuns registry", () => {
  const info = { runId: "a", kind: "rule" as const, command: "x".repeat(900), pid: 1, startedAt: new Date().toISOString(), timeoutMs: 1000 };
  it("adds, lists newest first, removes, notifies", () => {
    const reg = new LiveRuns();
    let n = 0;
    reg.onChange(() => n++);
    const a = reg.add(info, () => true);
    const b = reg.add({ ...info, runId: "b" }, () => true);
    expect(reg.list().map((r) => r.runId)).toEqual(["b", "a"]);
    expect(reg.list()[0].command.length).toBe(500);
    a.remove();
    b.remove();
    b.remove();
    expect(reg.list()).toEqual([]);
    expect(n).toBe(4);
  });
  it("caps the output tail", () => {
    const reg = new LiveRuns();
    const h = reg.add(info, () => true);
    h.append("a".repeat(5000));
    h.append("END");
    const out = reg.list()[0].output;
    expect(out.length).toBe(OUTPUT_TAIL);
    expect(out.endsWith("END")).toBe(true);
  });
  it("kill unknown is false", () => {
    expect(new LiveRuns().kill("nope")).toBe(false);
  });
});

describe("runner + registry", () => {
  it("registers meta + output while running and removes at end", async () => {
    const reg = new LiveRuns();
    const r = createShellRunner({ registry: reg });
    const p = r.run("echo hello; sleep 0.5", { cwd, env: {}, meta: { rule: "R", board: "B", ticketId: "7", ticketName: "T", path: "t.md" } });
    await until(() => reg.list().length === 1 && reg.list()[0].output.includes("hello"));
    expect(reg.list()[0]).toMatchObject({ kind: "rule", rule: "R", board: "B", ticketId: "7", ticketName: "T", path: "t.md", timeoutMs: 30000 });
    expect(reg.list()[0].pid).toBeGreaterThan(0);
    await p;
    expect(reg.list()).toEqual([]);
  });
  it("test meta → kind test", async () => {
    const reg = new LiveRuns();
    const p = createShellRunner({ registry: reg }).run("sleep 0.3", { cwd, env: {}, meta: { test: true } });
    await until(() => reg.list().length === 1);
    expect(reg.list()[0].kind).toBe("test");
    await p;
  });
  it("kill terminates the process group incl. background children", async () => {
    const reg = new LiveRuns();
    const r = createShellRunner({ registry: reg });
    const p = r.run("sleep 30 & echo child=$!; sleep 30", { cwd, env: {} });
    await until(() => reg.list().length === 1 && /child=\d+/.test(reg.list()[0].output));
    const child = Number(/child=(\d+)/.exec(reg.list()[0].output)![1]);
    const pid = reg.list()[0].pid;
    expect(alive(child)).toBe(true);
    expect(reg.kill(reg.list()[0].runId)).toBe(true);
    const res = await p;
    expect(res).toMatchObject({ exitCode: null, error: "killed by user" });
    await until(() => !alive(child) && !alive(pid));
    expect(reg.list()).toEqual([]);
    expect(reg.kill("a")).toBe(false);
  });
  it("SIGKILLs a process ignoring SIGTERM after the grace period", async () => {
    const reg = new LiveRuns();
    const p = createShellRunner({ registry: reg }).run("trap '' TERM; echo ready; while true; do sleep 0.1; done", { cwd, env: {} });
    await until(() => reg.list().length === 1 && reg.list()[0].output.includes("ready"));
    reg.kill(reg.list()[0].runId);
    const res = await p;
    expect(res.error).toBe("killed by user");
  }, 10000);
  it("timeouts still work", async () => {
    const reg = new LiveRuns();
    const x = await createShellRunner({ timeoutMs: 200, registry: reg }).run("sleep 5", { cwd, env: {} });
    expect(x.error).toBe("timeout after 0.2s");
    expect(reg.list()).toEqual([]);
  });
  it("killAll clears the registry", async () => {
    const reg = new LiveRuns();
    const r = createShellRunner({ registry: reg });
    const p = r.run("sleep 30", { cwd, env: {} });
    await until(() => reg.list().length === 1);
    r.killAll();
    expect(reg.list()).toEqual([]);
    await p;
  });
});

describe("killed run in the core", () => {
  it("records failed / exit null / killed by user and event data.killed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-live-"));
    fs.writeFileSync(path.join(dir, "kanban.yaml"), "columns: [todo, done]\nautomations:\n  - name: slow\n    when: { moved_to: done }\n    run: sleep 30\n");
    const reg = new LiveRuns();
    const evs: KbEvent[] = [];
    const kb = createKanban({ dir, runner: createShellRunner({ registry: reg }), events: { emit: (e) => void evs.push(e) }, source: "web" });
    const t = kb.add({ name: "T" });
    kb.update(String(t.id), { status: "done" });
    await until(() => reg.list().length === 1);
    expect(reg.list()[0]).toMatchObject({ rule: "slow", ticketId: String(t.id), ticketName: "T" });
    reg.kill(reg.list()[0].runId);
    await kb.settled();
    const fin = evs.find((e) => e.type === "automation.finished")!;
    expect(fin.data).toMatchObject({ status: "failed", exit: null, error: "killed by user", killed: true });
    expect(fin.source).toBe("web");
    const file = fs.readFileSync(path.join(dir, t.path ?? ""), "utf8");
    expect(file).toMatch(/status: failed/);
    expect(file).toMatch(/error: killed by user/);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 15000);
});
