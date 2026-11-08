import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createKanban } from "../src/core/index.js";
import { killRun } from "../src/killRun.js";
import { consumeKilled, markKilled } from "../src/killMarker.js";
import { createShellRunner } from "../src/runner.js";
import { killAutomations } from "../src/cli/commands/automations.js";
import type { ChildProcess } from "node:child_process";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (f: () => boolean | Promise<boolean>, ms = 5000): Promise<void> => {
  const t0 = Date.now();
  while (!(await f())) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-kill-"));
  fs.writeFileSync(
    path.join(dir, "kanban.yaml"),
    "columns: [todo, done]\nautomations:\n  - name: slow\n    when: { moved_to: done }\n    run: sleep 30\n",
  );
  fs.writeFileSync(path.join(dir, "a.md"), "---\ntype: ticket\nid: 1\nname: Alpha\nstatus: todo\n---\n");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Local timestamp without offset, like the owner writes it (`at: "2026-01-02T03:04:05"`). */
const nowLocal = (): string => {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** Start a real detached shell like the runner does. Unref'd so the child handle never pins the worker. */
const spawnShell = (cmd = "sleep 30"): ChildProcess => {
  const child = spawn("bash", ["-c", cmd], { detached: true, stdio: "ignore" });
  // Like every other spawner in the suite: a lingering child handle must not keep the worker alive.
  child.unref();
  return child;
};

const entry = (pid: number, extra = ""): string =>
  `automations:\n  slow: { status: running, at: "${nowLocal()}", pid: ${pid}, pgid: ${pid}${extra}, runs: 1 }\n`;

const writeRunning = (pid: number, extra = ""): void => {
  fs.writeFileSync(path.join(dir, "a.md"), `---\ntype: ticket\nid: 1\nname: Alpha\nstatus: done\n${entry(pid, extra)}---\n`);
};

describe("killMarker", () => {
  it("records and consumes once", () => {
    expect(consumeKilled(dir, 1234)).toBe(false);
    markKilled(dir, 1234);
    expect(consumeKilled(dir, 1234)).toBe(true);
    expect(consumeKilled(dir, 1234)).toBe(false);
  });
  it("never throws on a bad root", () => {
    expect(() => markKilled("/proc/nope/does/not/exist", 1)).not.toThrow();
    expect(consumeKilled("/proc/nope/does/not/exist", 1)).toBe(false);
  });
});

describe("killRun", () => {
  it("kills a real process group and marks it", async () => {
    const child = spawnShell();
    await until(() => alive(child.pid!));
    const r = await killRun({ pid: child.pid!, pgid: child.pid! }, { root: dir, waitMs: 3000 });
    expect(r).toMatchObject({ ok: true, pid: child.pid });
    await until(() => !alive(child.pid!));
    expect(consumeKilled(dir, child.pid!)).toBe(true);
  });
  it("refuses a foreign host", async () => {
    const r = await killRun({ pid: process.pid, pgid: process.pid, host: "some-other-host" }, { root: dir });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/cannot kill from here/);
  });
  it("refuses an entry without a pid", async () => {
    const r = await killRun({}, { root: dir });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no pid recorded/);
  });
  it("refuses a gone pid", async () => {
    const child = spawnShell();
    const pid = child.pid!;
    await until(() => !alive(pid) || (child.kill("SIGKILL"), true));
    await until(() => !alive(pid));
    const r = await killRun({ pid, pgid: pid }, { root: dir });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not reachable|gone/);
    expect(consumeKilled(dir, pid)).toBe(false); // nothing was signalled
  });
  it("refuses a live pid it cannot verify when ps is unavailable", async () => {
    // `ps` failing means both reuse guards are skipped. With no pgid/elapsedMs on the entry there is
    // nothing to corroborate identity, so the kill must fail closed instead of firing at whatever now
    // owns the pid. PATH is emptied for the duration so the module's execFileSync("ps") throws.
    const child = spawnShell();
    const pid = child.pid!;
    await until(() => alive(pid));
    const savedPath = process.env.PATH;
    process.env.PATH = "/nonexistent-kb-ps";
    let r: Awaited<ReturnType<typeof killRun>>;
    try {
      r = await killRun({ pid }, { root: dir, graceMs: 0, waitMs: 0 });
    } finally {
      process.env.PATH = savedPath;
    }
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/cannot verify pid \d+ belongs to this run \(ps unavailable\)/);
    expect(alive(pid)).toBe(true);
    expect(consumeKilled(dir, pid)).toBe(false); // nothing was signalled
    child.kill("SIGKILL");
    await until(() => !alive(pid));
  });
  it("refuses a reused pid (not a shell / wrong group)", async () => {
    // process.pid is this node process: right owner, wrong group and wrong command
    const r = await killRun({ pid: process.pid, pgid: 1 }, { root: dir });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/pid reused|now in group|not a shell/);
  });
  it("does not mark a kill that failed", async () => {
    // The pid is alive but reserved, so nothing may be signalled: the kill fails and the marker must be
    // rolled back, or the owner would later record an unrelated death as "killed by user".
    const child = spawnShell();
    const pid = child.pid!;
    await until(() => alive(pid));
    const r = await killRun({ pid, pgid: pid }, { root: dir, waitMs: 0, reserved: [pid] });
    expect(r.ok).toBe(false);
    expect(consumeKilled(dir, pid)).toBe(false);
    expect(alive(pid)).toBe(true);
    child.kill("SIGKILL");
    await until(() => !alive(pid));
  });
  it("marks the kill as soon as it signals, and consumes it once", async () => {
    // The marker has to be there while the tree is still dying: the owner consumes it when the child
    // exits, which happens during killTree's SIGTERM grace, not after killTree resolves.
    const child = spawnShell();
    const pid = child.pid!;
    await until(() => alive(pid));
    let markedDuringGrace = false;
    const probe = setInterval(() => {
      if (alive(pid) && fs.existsSync(path.join(dir, ".kb", "killed", String(pid)))) markedDuringGrace = true;
    }, 10);
    let r: Awaited<ReturnType<typeof killRun>>;
    try {
      r = await killRun({ pid, pgid: pid }, { root: dir, graceMs: 300, waitMs: 3000 });
      expect(r.ok).toBe(true);
      expect(markedDuringGrace).toBe(true);
      await until(() => !alive(pid));
      expect(consumeKilled(dir, pid)).toBe(true);
    } finally {
      // A failing assertion must not leave a 10 ms interval spinning for the rest of the run.
      clearInterval(probe);
    }
  });
  it("returns promptly when ps is slow instead of blocking the event loop", async () => {
    // Regression: the `ps` lookup used to be an unbounded execFileSync, which froze the event loop
    // so hard that no test timeout could fire. A stub `ps` that sleeps forever stands in for a wedged
    // ps; the lookup must give up (bounded) and the kill must fail closed, not hang.
    const child = spawnShell();
    const pid = child.pid!;
    await until(() => alive(pid));
    const stubDir = path.join(dir, "bin");
    fs.mkdirSync(stubDir, { recursive: true });
    const stub = path.join(stubDir, "ps");
    fs.writeFileSync(stub, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = `${stubDir}${path.delimiter}${savedPath}`;
    const t0 = Date.now();
    let r: Awaited<ReturnType<typeof killRun>>;
    try {
      r = await killRun({ pid }, { root: dir, graceMs: 0, waitMs: 0 });
    } finally {
      process.env.PATH = savedPath;
    }
    const elapsed = Date.now() - t0;
    // Well under testTimeout: the point is that it returns at all, and that the bound is honoured.
    expect(elapsed).toBeLessThan(15_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/cannot verify pid \d+ belongs to this run \(ps unavailable\)/);
    expect(alive(pid)).toBe(true); // nothing was signalled
    expect(consumeKilled(dir, pid)).toBe(false);
    child.kill("SIGKILL");
    await until(() => !alive(pid));
  });
});

describe("pid recorded by the owner", () => {
  it("frontmatter gets pid/pgid/host; overview exposes them", async () => {
    const runner = createShellRunner();
    const kb = createKanban({ dir, runner });
    kb.move("1", "done");
    await until(() => /pid:/.test(fs.readFileSync(path.join(dir, "a.md"), "utf8")));
    const live = kb.automationOverview().live;
    expect(live).toHaveLength(1);
    expect(live[0].pid).toBeGreaterThan(0);
    expect(live[0].pgid).toBe(live[0].pid);
    expect(live[0].host).toBe(os.hostname());
    // stop the 30 s run so the test does not wait for it
    process.kill(-live[0].pid!, "SIGKILL");
    await kb.settled();
  });
  it("a marked kill is recorded as 'killed by user', not SIGTERM", async () => {
    const runner = createShellRunner();
    const kb = createKanban({ dir, runner });
    kb.move("1", "done");
    await until(() => kb.automationOverview().live.length === 1);
    const { pid } = kb.automationOverview().live[0];
    markKilled(dir, pid!);
    process.kill(-pid!, "SIGTERM");
    await kb.settled();
    const data = kb.get("1").data.automations as Record<string, Record<string, unknown>>;
    expect(data.slow).toMatchObject({ status: "failed", error: "killed by user", exit: null });
  });
});

describe("kb automations kill (command layer)", () => {
  it("kills a running automation and reports it", async () => {
    const child = spawnShell();
    await until(() => alive(child.pid!));
    writeRunning(child.pid!);
    const r = await killAutomations(dir, { ticket: "1", rule: "slow", format: "text", waitMs: 3000 });
    expect(r.dryRun).toBe(false);
    expect(r.killed).toHaveLength(1);
    expect(r.failed).toEqual([]);
    expect(r.out).toMatch(/^killed slow on #1 Alpha/);
    await until(() => !alive(child.pid!));
  });
  it("requires a selector unless --all", async () => {
    await expect(killAutomations(dir, {})).rejects.toThrow(/nothing selected/);
  });
  it("errors when nothing matches", async () => {
    await expect(killAutomations(dir, { ticket: "9" })).rejects.toThrow(/no automation running for ticket 9/);
  });
  it("demands --all when several match", async () => {
    const a = spawnShell();
    const b = spawnShell();
    await until(() => alive(a.pid!) && alive(b.pid!));
    fs.writeFileSync(
      path.join(dir, "a.md"),
      `---\ntype: ticket\nid: 1\nname: Alpha\nstatus: done\nautomations:\n  slow: { status: running, at: "${nowLocal()}", pid: ${a.pid}, pgid: ${a.pid}, runs: 1 }\n  other: { status: running, at: "${nowLocal()}", pid: ${b.pid}, pgid: ${b.pid}, runs: 1 }\n---\n`,
    );
    await expect(killAutomations(dir, { ticket: "1" })).rejects.toThrow(/2 automations match; narrow with -t\/-r or pass -a\/--all/);
    const r = await killAutomations(dir, { ticket: "1", all: true, waitMs: 3000 });
    expect(r.killed).toHaveLength(2);
    await until(() => !alive(a.pid!) && !alive(b.pid!));
  });
  it("--dry-run signals nothing", async () => {
    const child = spawnShell();
    await until(() => alive(child.pid!));
    writeRunning(child.pid!);
    const r = await killAutomations(dir, { all: true, dryRun: true, format: "text" });
    expect(r.dryRun).toBe(true);
    expect(r.out).toMatch(/^would kill 1 automation:\n  slow on #1 Alpha \(pid \d+\)$/);
    await new Promise((res) => setTimeout(res, 150));
    expect(alive(child.pid!)).toBe(true);
    await killRun({ pid: child.pid!, pgid: child.pid! }, { root: dir });
  });
});
