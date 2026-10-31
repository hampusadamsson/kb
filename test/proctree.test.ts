import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectTree, killTree, listProcs, type Proc } from "../src/procTree.js";
import { killRun } from "../src/killRun.js";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const until = async (f: () => boolean | Promise<boolean>, ms = 8000): Promise<void> => {
  const t0 = Date.now();
  while (!(await f())) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
};

const readPid = (file: string): number | undefined => {
  try {
    const n = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
};

const dirs: string[] = [];
const spawned: number[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "kb-tree-"));
  dirs.push(d);
  return d;
};
/** Track a spawned root so a failing assertion cannot leak it. */
const track = (pid: number | undefined): number => {
  if (pid) spawned.push(pid);
  return pid ?? 0;
};
const forceKill = (pid: number): void => {
  for (const sig of ["SIGKILL"] as const) {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        // already gone
      }
    }
  }
};
afterEach(() => {
  for (const pid of spawned.splice(0)) forceKill(pid);
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("collectTree (pure)", () => {
  const procs: Proc[] = [
    { pid: 10, ppid: 1, pgid: 10 },
    { pid: 11, ppid: 10, pgid: 10 },
    { pid: 12, ppid: 11, pgid: 12 }, // escaped into its own group
    { pid: 13, ppid: 12, pgid: 12 },
    { pid: 20, ppid: 1, pgid: 20 }, // unrelated
  ];

  it("collects descendants across process groups, children first", () => {
    const t = collectTree([10], procs);
    expect(new Set(t.all)).toEqual(new Set([10, 11, 12, 13]));
    expect(t.all[t.all.length - 1]).toBe(10); // root last
    expect(new Set(t.pgids)).toEqual(new Set([10, 12]));
  });

  it("ignores missing roots", () => {
    expect(collectTree([999], procs)).toEqual({ pids: [], all: [], pgids: [] });
  });

  it("protects a reserved pid and its ancestors", () => {
    // 12 is reserved: signalling 10 would reach 12 through the tree/group, so nothing is collected.
    expect(collectTree([10], procs, [12]).all).toEqual([]);
    // With the reserved pid outside the tree, the tree is collected normally.
    expect(new Set(collectTree([10], procs, [20]).all)).toEqual(new Set([10, 11, 12, 13]));
  });

  it("still kills descendants of a reserved pid (a run is one)", () => {
    // This process is 'reserved', but the run it spawned must remain killable.
    const t = collectTree([11], procs, [10]);
    expect(new Set(t.all)).toEqual(new Set([11, 12, 13]));
  });

  it("does not treat the reserved pid itself as a root", () => {
    expect(collectTree([20], procs, [20]).all).toEqual([]);
  });
});

describe("killTree", () => {
  it("kills a child that moved to its own process group", async () => {
    // Mirrors an agent harness: a live parent that spawns a detached grandchild.
    const d = tmp();
    const pidFile = path.join(d, "gc.pid");
    const script = `
      const { spawn } = require("node:child_process");
      spawn("bash", ["-c", "echo $$ > ${pidFile}; while true; do sleep 1; done"], { detached: true, stdio: "ignore" }).unref();
      setInterval(() => {}, 1000);
    `;
    const root = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" });
    track(root.pid);
    await until(() => readPid(pidFile) !== undefined);
    const gc = readPid(pidFile)!;
    // The grandchild is in its own group, so a group kill on the root would miss it.
    const gcPgid = listProcs().find((p) => p.pid === gc)?.pgid;
    expect(gcPgid).toBe(gc);
    expect(gcPgid).not.toBe(root.pid);

    const r = await killTree([root.pid!], { graceMs: 200, waitMs: 3000 });
    expect(r.all).toContain(gc);
    expect(r.survivors).toEqual([]);
    await until(() => !alive(root.pid!) && !alive(gc));
  });

  it("SIGKILLs a tree that ignores SIGTERM", async () => {
    const d = tmp();
    const pidFile = path.join(d, "tough.pid");
    const root = spawn("bash", ["-c", `trap '' TERM; echo $$ > ${pidFile}; while true; do sleep 1; done`], {
      detached: true,
      stdio: "ignore",
    });
    track(root.pid);
    await until(() => readPid(pidFile) !== undefined);
    const r = await killTree([root.pid!], { graceMs: 150, waitMs: 3000 });
    expect(r.survivors).toEqual([]);
    await until(() => !alive(root.pid!));
  });

  it("reports nothing to do for a dead pid", async () => {
    const r = await killTree([999_999], { graceMs: 0, waitMs: 0 });
    expect(r).toEqual({ pids: [], all: [], pgids: [], survivors: [] });
  });
});

describe("killRun kills escaped descendants", () => {
  it("terminates a detached grandchild started by the run", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "kanban.yaml"), "columns: [todo, done]\n");
    const pidFile = path.join(dir, "gc.pid");
    // The run: a live process that spawns a detached child (what an agent harness does).
    const script = `
      const { spawn } = require("node:child_process");
      spawn("bash", ["-c", "echo $$ > ${pidFile}; trap '' TERM; while true; do sleep 1; done"], { detached: true, stdio: "ignore" }).unref();
      setInterval(() => {}, 1000);
    `;
    const root = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" });
    track(root.pid);
    await until(() => readPid(pidFile) !== undefined);
    const gc = readPid(pidFile)!;

    const r = await killRun({ pid: root.pid!, pgid: root.pid }, { root: dir, graceMs: 200, waitMs: 3000 });
    expect(r.ok).toBe(true);
    // The regression: the old code only signalled the root's group and left this alive.
    await until(() => !alive(gc));
    expect(alive(gc)).toBe(false);
  });

  it("never signals the caller", async () => {
    const dir = tmp();
    const r = await killRun({ pid: process.pid, pgid: process.pid }, { root: dir, graceMs: 0, waitMs: 0 });
    // process.pid is its own root: reserved, so there is nothing safe to kill.
    expect(r.ok).toBe(false);
    expect(alive(process.pid)).toBe(true);
  });
});
