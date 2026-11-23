import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AutomationRunner, RunResult } from "../src/core/automation.js";
import { createKanban } from "../src/core/board.js";
import type { KbEvent } from "../src/core/events.js";
import { readFile } from "../src/core/frontmatter.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-sched-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

class FakeRunner implements AutomationRunner {
  calls: string[] = [];
  pending: ((r: RunResult) => void)[] = [];
  auto = false;
  run(command: string) {
    this.calls.push(command);
    if (this.auto) return Promise.resolve<RunResult>({ exitCode: 0, stdout: "", stderr: "" });
    return new Promise<RunResult>((res) => this.pending.push(res));
  }
}

const at = (h: number, m: number) => new Date(2026, 2, 1, h, m, 0);
const tick = () => new Promise((r) => setTimeout(r, 0));
const tk = (file: string, fm: string) => fs.writeFileSync(path.join(dir, file), `---\ntype: ticket\n${fm}\n---\n`);
const fm = (rel: string) => readFile(path.join(dir, rel)).doc.toJS() as Record<string, any>;

const rule = (extra = "", name = "nightly", cron = "0 9 * * *") =>
  `  - name: ${name}\n    when: { schedule: "${cron}", in: todo }\n    run: "echo {{ id }} {{ event }}"\n${extra}`;
const cfg = (automations: string) => `columns: [todo, done]\nautomations:\n${automations}`;

function setup(yaml: string) {
  fs.writeFileSync(path.join(dir, "kanban.yaml"), yaml);
  const runner = new FakeRunner();
  const evs: KbEvent[] = [];
  const kb = createKanban({ dir, now: () => at(9, 0), runner, events: { emit: (e) => void evs.push(e) } });
  return { kb, runner, evs };
}

describe("Board.runSchedule", () => {
  it("fires for matching tickets only (status via in, labels)", async () => {
    const { kb, runner } = setup(
      cfg(`  - name: nightly\n    when: { schedule: "0 9 * * *", in: todo, labels: [x] }\n    run: "echo {{ id }} {{ event }}"\n`),
    );
    tk("a.md", "id: 1\nname: A\nstatus: todo\nlabels: [x]");
    tk("b.md", "id: 2\nname: B\nstatus: done\nlabels: [x]");
    tk("c.md", "id: 3\nname: C\nstatus: todo");
    expect(kb.runSchedule(at(9, 0))).toEqual({ fired: 1 });
    await tick();
    expect(runner.calls).toEqual(["echo '1' 'schedule'"]);
    expect(fm("a.md").automations.nightly.status).toBe("running");
  });

  it("does not fire when the cron does not match", () => {
    const { kb, runner } = setup(cfg(rule()));
    tk("a.md", "id: 1\nname: A\nstatus: todo");
    expect(kb.runSchedule(at(9, 1))).toEqual({ fired: 0 });
    expect(runner.calls).toEqual([]);
  });

  it("does not fire twice in the same minute", () => {
    const { kb, runner } = setup(cfg(rule()));
    tk("a.md", "id: 1\nname: A\nstatus: todo");
    expect(kb.runSchedule(at(9, 0)).fired).toBe(1);
    expect(kb.runSchedule(new Date(2026, 2, 1, 9, 0, 30)).fired).toBe(0);
    expect(runner.calls).toHaveLength(1);
  });

  it("skips a still-running ticket with a skipped event", () => {
    const { kb, runner, evs } = setup(cfg(rule("", "nightly", "* * * * *")));
    tk("a.md", "id: 1\nname: A\nstatus: todo");
    expect(kb.runSchedule(at(9, 0)).fired).toBe(1);
    expect(kb.runSchedule(at(9, 1)).fired).toBe(0);
    expect(runner.calls).toHaveLength(1);
    const skipped = evs.filter((e) => e.type === "automation.skipped");
    expect(skipped).toHaveLength(1);
    expect(JSON.stringify(skipped[0])).toContain("still-running");
  });

  it("has the loop guard off by default for schedule", async () => {
    const { kb, runner } = setup(cfg(rule("", "nightly", "* * * * *")));
    runner.auto = true;
    tk("a.md", "id: 1\nname: A\nstatus: todo");
    for (let i = 0; i < 20; i++) {
      expect(kb.runSchedule(at(9, i)).fired).toBe(1);
      await tick();
    }
    expect(runner.calls).toHaveLength(20);
  });

  it("applies the loop guard with guard: true", async () => {
    const { kb, runner } = setup(cfg(rule("    guard: true\n", "nightly", "* * * * *")));
    runner.auto = true;
    tk("a.md", "id: 1\nname: A\nstatus: todo");
    let fired = 0;
    for (let i = 0; i < 20; i++) {
      fired += kb.runSchedule(at(9, i)).fired;
      await tick();
    }
    expect(fired).toBeLessThan(20);
    expect(runner.calls).toHaveLength(fired);
  });

  const mixed = (guard: string) =>
    cfg(rule(guard, "tick", "* * * * *") + `  - name: mv\n    when: { moved_to: done }\n    run: "echo mv"\n`);

  it("guard-off schedule runs do not consume the budget of other rules", async () => {
    const { kb, runner } = setup(mixed(""));
    runner.auto = true;
    tk("a.md", "id: 1\nname: A\nstatus: todo");
    for (let i = 0; i < 20; i++) {
      kb.runSchedule(at(9, i));
      await tick();
    }
    expect(runner.calls).toHaveLength(20);
    expect(fm("a.md").automations.tick.runs).toBe(0);
    kb.move("1", "done");
    await tick();
    expect(runner.calls).toHaveLength(21);
    expect(fm("a.md").automations.mv.status).toBe("done");
  });

  it("guard: true schedule runs count toward the shared budget", async () => {
    const { kb, runner } = setup(mixed("    guard: true\n"));
    runner.auto = true;
    tk("a.md", "id: 1\nname: A\nstatus: todo");
    for (let i = 0; i < 20; i++) {
      kb.runSchedule(at(9, i));
      await tick();
    }
    expect(fm("a.md").automations.tick.runs).toBeGreaterThan(0);
    const before = runner.calls.length;
    kb.move("1", "done");
    await tick();
    expect(runner.calls).toHaveLength(before);
  });

  it("skips disabled rules", () => {
    const { kb, runner } = setup(cfg(rule("    enabled: false\n")));
    tk("a.md", "id: 1\nname: A\nstatus: todo");
    expect(kb.runSchedule(at(9, 0))).toEqual({ fired: 0 });
    expect(runner.calls).toEqual([]);
  });

  it("ignores rules with an invalid cron", () => {
    const { kb, runner } = setup(cfg(rule("", "bad", "nope") + rule("", "good")));
    tk("a.md", "id: 1\nname: A\nstatus: todo");
    expect(kb.runSchedule(at(9, 0))).toEqual({ fired: 1 });
    expect(runner.calls).toHaveLength(1);
  });
});
