import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createShellRunner } from "../src/runner.js";

// The runner's kill is wrapped so one test can hold it open and prove the result waits for it.
const mocks = vi.hoisted(() => ({
  killTree: vi.fn<typeof import("../src/procTree.js").killTree>(),
  real: undefined as typeof import("../src/procTree.js").killTree | undefined,
}));
vi.mock("../src/procTree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/procTree.js")>();
  mocks.real = actual.killTree;
  return { ...actual, killTree: (...args: Parameters<typeof actual.killTree>) => mocks.killTree(...args) };
});
beforeEach(() => {
  mocks.killTree.mockReset();
  mocks.killTree.mockImplementation((...args) => mocks.real!(...args));
});

const cwd = process.cwd();
const r = createShellRunner({ timeoutMs: 5000 });

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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

const until = async (f: () => boolean, ms = 5000): Promise<void> => {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting");
    await new Promise((res) => setTimeout(res, 25));
  }
};

describe("shell runner", () => {
  it("captures stdout", async () => {
    expect(await r.run("echo hi", { cwd, env: {} })).toMatchObject({ exitCode: 0, stdout: "hi\n", stderr: "" });
  });
  it("exit code and stderr", async () => {
    const x = await r.run("echo bad >&2; exit 3", { cwd, env: {} });
    expect(x.exitCode).toBe(3);
    expect(x.stderr).toBe("bad\n");
    expect(x.error).toBeUndefined();
  });
  it("reports a timeout only once the kill has finished", async () => {
    // The result may not be reported while killTree is still running: a one-shot CLI exits on it.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    mocks.killTree.mockImplementation(async () => {
      await gate;
      return { pids: [], all: [], pgids: [], survivors: [] };
    });
    const k = createShellRunner({ timeoutMs: 150 });
    let reported: { error?: string; timedOut?: boolean } | undefined;
    const p = k.run("sleep 5", { cwd, env: {} }).then((x) => {
      reported = x;
      return x;
    });
    await new Promise((res) => setTimeout(res, 600));
    expect(mocks.killTree).toHaveBeenCalledTimes(1);
    expect(reported).toBeUndefined(); // kill still in flight, so the run is not finished yet
    release();
    const x = await p;
    expect(x).toMatchObject({ exitCode: null, error: "timed out after 0.15s", timedOut: true });
    // One report only: the exit handler must not finish the run a second time.
    expect(reported).toBe(x);
    mocks.killTree.mockImplementation((...args) => mocks.real!(...args));
    k.killAll();
  });

  it("reports the timeout even if the kill never resolves", async () => {
    // A wedged kill (a hung `ps` in listProcs) must not swallow the report: the run is always
    // reported, at the latest once the kill cap expires. The signals still go out (the real kill is
    // started), but its promise never settles, which is what a blocked kill looks like from here.
    mocks.killTree.mockImplementation((...args) => {
      void mocks.real!(...args);
      return new Promise<never>(() => {});
    });
    const k = createShellRunner({ timeoutMs: 150 });
    let pid: number | undefined;
    let x: { error?: string; timedOut?: boolean } | "still-pending" | undefined;
    const t0 = Date.now();
    try {
      const p = k.run("sleep 30", { cwd, env: {}, onSpawn: (s) => (pid = s.pid) });
      // Fail fast instead of waiting for the 30 s vitest timeout when the cap is not honoured.
      x = await Promise.race([p, new Promise<"still-pending">((res) => setTimeout(() => res("still-pending"), 9000))]);
      const took = Date.now() - t0;
      expect(x).not.toBe("still-pending"); // swallowed report: nothing resolved while the kill hung
      expect(x).toMatchObject({ exitCode: null, error: "timed out after 0.15s", timedOut: true });
      // TERM_GRACE_MS (2000) + KILL_CAP_MS (5000), plus slack for a loaded machine.
      expect(took).toBeLessThan(7000 + 2000);
      // The exit path was re-armed when the cap won, so the child must not stay alive behind it.
      await until(() => !alive(pid!), 2000);
      expect(alive(pid!)).toBe(false);
    } finally {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      k.killAll();
    }
  });

  it("waits for the tree to die before reporting a timeout", async () => {
    // The run is not finished while its tree is still alive. A one-shot CLI would exit right after
    // the result, so a fire-and-forget kill left the SIGKILL phase unrun and the child orphaned.
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "kb-runner-"));
    const pidFile = path.join(d, "gc.pid");
    let gc: number | undefined;
    try {
      // An escaped child that ignores SIGTERM: only the SIGKILL phase can reach it.
      const cmd = `(trap '' TERM; echo $$ > ${pidFile}; while true; do sleep 1; done) &\nwait`;
      const x = await createShellRunner({ timeoutMs: 300 }).run(cmd, { cwd: d, env: {} });
      expect(x).toMatchObject({ exitCode: null, error: "timed out after 0.3s", timedOut: true });
      // The shell got SIGTERM during the kill, so the exit handler ran too: only one of the two paths
      // may report, and it must be the timeout (otherwise the tree's fate would be unreported).
      expect(x.error).not.toMatch(/killed by/);
      gc = readPid(pidFile);
      expect(gc).toBeDefined();
      // Gone when (or right after) the result is reported: the SIGKILL phase ran and was awaited,
      // instead of being left to a process that is about to exit.
      await until(() => !alive(gc!), 1500);
      expect(alive(gc!)).toBe(false);
    } finally {
      if (gc) {
        try {
          process.kill(gc, "SIGKILL");
        } catch {
          // already gone
        }
      }
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("reports the real exit code when the child exits by itself during the timeout window", async () => {
    // The child ignores SIGTERM, so the kill lingers past the timeout; the script then exits on its
    // own with code 0. That real exit must be reported, not a synthetic timeout.
    const x = await createShellRunner({ timeoutMs: 150 }).run("trap '' TERM; sleep 0.3; exit 0", { cwd, env: {} });
    expect(x.timedOut).toBeUndefined();
    expect(x.exitCode).toBe(0);
    expect(x.error).toBeUndefined();
  });
  it("times out", async () => {
    const t0 = Date.now();
    const x = await createShellRunner({ timeoutMs: 200 }).run("sleep 5", { cwd, env: {} });
    expect(x.exitCode).toBeNull();
    expect(x.error).toBe("timed out after 0.2s");
    expect(Date.now() - t0).toBeLessThan(3000);
  });
  it("caps output", async () => {
    const x = await r.run("head -c 200000 /dev/zero | tr '\\0' a", { cwd, env: {} });
    expect(x.stdout.length).toBeLessThan(70000);
    expect(x.stdout).toContain("[output truncated]");
  });
  it("passes env and cwd", async () => {
    const x = await r.run('echo "$KB_AUTOMATION $FOO"; pwd', { cwd: "/tmp", env: { KB_AUTOMATION: "1", FOO: "bar" } });
    expect(x.stdout.split("\n")[0]).toBe("1 bar");
    expect(x.stdout).toMatch(/tmp/);
  });
  it("handles a 2MB command", async () => {
    const x = await r.run(`printf %s '${"x".repeat(2_000_000)}' | wc -c`, { cwd, env: {} });
    expect(x.error).toBeUndefined();
    expect(x.stdout.trim()).toBe("2000000");
  });
  it("returns promptly when a script backgrounds a process", async () => {
    const t0 = Date.now();
    const x = await createShellRunner({ timeoutMs: 3000 }).run("sleep 2 &", { cwd, env: {} });
    expect(x.exitCode).toBe(0);
    expect(x.error).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it("keeps output written before exit", async () => {
    const x = await r.run("echo a; echo b >&2; sleep 2 &", { cwd, env: {} });
    expect(x).toMatchObject({ exitCode: 0, stdout: "a\n", stderr: "b\n" });
  });
  it("killAll kills running scripts", async () => {
    const k = createShellRunner({ timeoutMs: 10000 });
    const t0 = Date.now();
    const p = k.run("sleep 5", { cwd, env: {} });
    await new Promise((res) => setTimeout(res, 150));
    k.killAll();
    const x = await p;
    expect(x.exitCode).toBeNull();
    expect(x.error).toMatch(/killed by SIGKILL/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it("never rejects on bad cwd", async () => {
    const x = await r.run("true", { cwd: "/nonexistent-dir-xyz", env: {} });
    expect(x.exitCode).toBeNull();
    expect(x.error).toBeTruthy();
  });
});
