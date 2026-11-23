import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationRunner, RunResult } from "../src/core/automation.js";
import { startScheduler } from "../src/scheduler.js";
import { startServer } from "../src/web/server.js";

describe("startScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 1, 9, 0, 30));
  });
  afterEach(() => vi.useRealTimers());

  it("fires at the next minute boundary, once per minute, and re-arms", () => {
    const runSchedule = vi.fn<(now?: Date) => void>();
    const kanban = vi.fn<() => { runSchedule: typeof runSchedule }>(() => ({ runSchedule }));
    const s = startScheduler({ kanban });
    expect(kanban).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(29_999);
    expect(runSchedule).not.toHaveBeenCalled();
    vi.advanceTimersByTime(251);
    expect(runSchedule).toHaveBeenCalledTimes(1);
    expect((runSchedule.mock.calls[0][0] as Date).getMinutes()).toBe(1);
    vi.advanceTimersByTime(59_000);
    expect(runSchedule).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(runSchedule).toHaveBeenCalledTimes(2);
    expect(kanban).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it("stop() halts the loop", () => {
    const runSchedule = vi.fn<(now?: Date) => void>();
    const s = startScheduler({ kanban: () => ({ runSchedule }) });
    s.stop();
    vi.advanceTimersByTime(300_000);
    expect(runSchedule).not.toHaveBeenCalled();
  });

  it("a throwing runSchedule is logged and does not stop the loop", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const runSchedule = vi.fn<(now?: Date) => void>(() => {
      throw new Error("boom");
    });
    const s = startScheduler({ kanban: () => ({ runSchedule }) });
    vi.advanceTimersByTime(30_250 + 60_000);
    expect(runSchedule).toHaveBeenCalledTimes(2);
    expect(err).toHaveBeenCalledTimes(2);
    s.stop();
    err.mockRestore();
  });

  it("does not catch up missed ticks after a suspend", () => {
    const runSchedule = vi.fn<(now?: Date) => void>();
    let t = new Date(2026, 2, 1, 9, 0, 30).getTime();
    const timers: (() => void)[] = [];
    const s = startScheduler({
      kanban: () => ({ runSchedule }),
      now: () => new Date(t),
      setTimeoutFn: (fn) => void timers.push(fn),
    });
    t += 3 * 3_600_000; // suspended for hours
    timers.shift()!();
    expect(runSchedule).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(1);
    s.stop();
  });

  it("unrefs the timer", () => {
    const unref = vi.fn<() => void>();
    const clear = vi.fn<(h: unknown) => void>();
    const s = startScheduler({
      kanban: () => ({ runSchedule: vi.fn<(now?: Date) => void>() }),
      setTimeoutFn: () => ({ unref }),
      clearTimeoutFn: clear,
    });
    expect(unref).toHaveBeenCalledTimes(1);
    s.stop();
    expect(clear).toHaveBeenCalledTimes(1);
  });
});

describe("scheduler integration", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-sched-int-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("a web server with a runner fires a scheduled rule once", async () => {
    fs.writeFileSync(
      path.join(dir, "kanban.yaml"),
      `columns: [todo, done]\nautomations:\n  - name: nightly\n    when: { schedule: "* * * * *", in: todo }\n    run: "echo {{ event }}"\n`,
    );
    fs.writeFileSync(path.join(dir, "a.md"), `---\ntype: ticket\nid: 1\nname: A\nstatus: todo\n---\n`);
    const calls: string[] = [];
    const runner: AutomationRunner = {
      run(command) {
        calls.push(command);
        return Promise.resolve<RunResult>({ exitCode: 0, stdout: "", stderr: "" });
      },
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date(2026, 2, 1, 9, 0, 30));
    const srv = await startServer({ dir, port: 0, runner, schedule: true });
    try {
      await vi.advanceTimersByTimeAsync(30_250);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("schedule");
    } finally {
      vi.useRealTimers();
      await srv.close();
    }
  });
});
