import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  matchRule,
  placeholderContextProblems,
  shellQuote,
  renderCommand,
  templateVars,
  unknownVars,
  type AutomationEvent,
  type AutomationRecord,
  type AutomationRunner,
  type RunResult,
} from "../src/core/automation.js";
import { automationsFor, loadConfig, type Automation } from "../src/core/config.js";
import { createKanban } from "../src/core/board.js";
import { readFile } from "../src/core/frontmatter.js";
import type { KbEvent } from "../src/core/events.js";
import type { Ticket } from "../src/core/tickets.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-auto-"));
});
const w = (name: string, text: string) => fs.writeFileSync(path.join(dir, name), text);

class FakeRunner implements AutomationRunner {
  calls: { command: string; cwd: string; env: Record<string, string> }[] = [];
  pending: ((r: RunResult) => void)[] = [];
  run(command: string, opts: { cwd: string; env: Record<string, string> }) {
    this.calls.push({ command, ...opts });
    return new Promise<RunResult>((res) => this.pending.push(res));
  }
  finish(r: Partial<RunResult> = {}, i = 0) {
    this.pending[i]({ exitCode: 0, stdout: "", stderr: "", ...r });
  }
}

const NOW = new Date(2026, 9, 30, 14, 20, 5);
const AT = "2026-10-30T14:20:05";

const rule = (over: Partial<Automation> = {}): Automation => ({
  name: "r",
  when: { moved_to: "done" },
  run: "echo {{ id }}",
  ...over,
});
const tk = (over: Partial<Ticket> = {}): Ticket =>
  ({
    path: "1.md",
    id: "001",
    name: "T",
    status: "done",
    column: "done",
    board: "default",
    labels: [],
    comments: {},
    props: {},
    body: "",
    raw: "",
    data: {},
    mtime: 0,
    ...over,
  }) as Ticket;
const mv: AutomationEvent = { type: "moved_to", to: "done", from: "todo" };

function setup(yaml: string, opts: { automations?: boolean; noRunner?: boolean; events?: boolean } = {}) {
  w("kanban.yaml", yaml);
  const runner = new FakeRunner();
  const records: AutomationRecord[] = [];
  const evs: KbEvent[] = [];
  const kb = createKanban({
    dir,
    now: () => NOW,
    runner: opts.noRunner ? undefined : runner,
    automations: opts.automations,
    onAutomation: (r) => records.push(r),
    ...(opts.events ? { events: { emit: (e) => void evs.push(e) } } : {}),
  });
  return { kb, runner, records, evs };
}
const BASIC = `columns: [todo, done]
automations:
  - name: n
    when: { moved_to: done }
    run: "echo {{ id }}"
  - name: c
    when: { created_in: todo }
    run: "echo created {{ id }}"
`;
const STEPS = `columns: [todo, done]
automations:
  - name: m
    when: { created_in: todo }
    run:
      - "echo one"
      - "echo two {{ id }}"
      - "echo three"
`;

const fm = (rel: string) => readFile(path.join(dir, rel)).doc.toJS() as Record<string, any>;

/** Let queued microtasks/next steps run without waiting for the whole rule. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("config", () => {
  it("parses automations and per-board lists, not inherited", () => {
    w(
      "kanban.yaml",
      BASIC +
        "boards:\n  other:\n    columns: [a, b]\n  third:\n    columns: [a]\n    automations:\n      - { name: x, when: { created_in: a }, run: ls }\n",
    );
    const c = loadConfig(dir);
    expect(automationsFor(c, "default")).toHaveLength(2);
    expect(automationsFor(c, "other")).toEqual([]);
    expect(automationsFor(c, "third").map((a) => a.name)).toEqual(["x"]);
  });
  it("rejects wrong types and bad when", () => {
    w("kanban.yaml", "columns: [a]\nautomations:\n  - { name: x, when: { moved_to: 3 }, run: ls }\n");
    expect(() => loadConfig(dir)).toThrow();
    w("kanban.yaml", "columns: [a]\nautomations:\n  - { name: x, when: { moved_to: a, created_in: a }, run: ls }\n");
    expect(() => loadConfig(dir)).toThrow(/exactly one/);
  });
});

describe("matchRule", () => {
  it("event types", () => {
    expect(matchRule(rule(), mv, tk())).toBe(true);
    expect(matchRule(rule(), { type: "moved_to", to: "todo" }, tk())).toBe(false);
    expect(matchRule(rule(), { type: "created_in", to: "done" }, tk())).toBe(false);
    expect(matchRule(rule({ when: { created_in: "done" } }), { type: "created_in", to: "done" }, tk())).toBe(true);
  });
  it("enabled false", () => {
    expect(matchRule(rule({ enabled: false }), mv, tk())).toBe(false);
  });
  it("labels incl. negation", () => {
    const r = rule({ when: { moved_to: "done", labels: ["bug"] } });
    expect(matchRule(r, mv, tk({ labels: ["bug"] }))).toBe(true);
    expect(matchRule(r, mv, tk())).toBe(false);
    const n = rule({ when: { moved_to: "done", labels: ["!bug"] } });
    expect(matchRule(n, mv, tk({ labels: ["bug"] }))).toBe(false);
    expect(matchRule(n, mv, tk())).toBe(true);
  });
  it("props incl. negation", () => {
    const r = rule({ when: { moved_to: "done", props: { priority: "high", n: 2 } } });
    expect(matchRule(r, mv, tk({ data: { priority: "high", n: 2 } }))).toBe(true);
    expect(matchRule(r, mv, tk({ data: { priority: "low", n: 2 } }))).toBe(false);
    const n = rule({ when: { moved_to: "done", props: { priority: "!high" } } });
    expect(matchRule(n, mv, tk({ data: { priority: "high" } }))).toBe(false);
    expect(matchRule(n, mv, tk({ data: { priority: "low" } }))).toBe(true);
  });
});

describe("templates", () => {
  const vars = { id: "001", name: "it's", body: "x'; rm -rf ~ $(whoami)\n", labels: "a,b", props: { p: 1, o: { a: 1 }, s: "z" } };
  it("quotes every value", () => {
    expect(renderCommand("echo {{id}} {{ name }} {{labels}}", vars)).toBe(`echo '001' 'it'\\''s' 'a,b'`);
    expect(renderCommand("echo {{ body }}", vars)).toBe(`echo 'x'\\''; rm -rf ~ $(whoami)\n'`);
  });
  it("missing → empty, props", () => {
    expect(renderCommand("{{ from }}|{{ props.p }}|{{ props.o }}|{{ props.nope }}", vars)).toBe(`''|'1'|'{"a":1}'|''`);
  });
  it("unknown var throws", () => {
    expect(() => renderCommand("{{ bogus }}", vars)).toThrow(/bogus/);
    expect(unknownVars("{{ id }} {{ x }} {{ props.a }}")).toEqual(["x"]);
    expect(templateVars("{{ id }}{{id}}{{ props.a }}")).toEqual(["id", "props.a"]);
  });
  it("injection in body stays inside one quoted word", () => {
    const { kb, runner } = setup(BASIC.replace("echo {{ id }}", "echo {{ body }}"));
    const { id } = kb.add({ name: "a", body: "'; rm -rf ~ $(touch x)" });
    kb.move(id, "done");
    expect(runner.calls.at(-1)!.command).toBe(`echo ''\\''; rm -rf ~ $(touch x)\n'`);
  });
});

describe("dispatch", () => {
  it("moved_to: running → done, preserves frontmatter", async () => {
    const { kb, runner, records } = setup(BASIC);
    const { id, path: p } = kb.add({ name: "a", comment: "hi", properties: { x: 1 } });
    expect(runner.calls).toHaveLength(1); // created_in rule
    runner.finish();
    await kb.settled();
    runner.calls.length = 0;
    runner.pending.length = 0;

    kb.move(id, "done");
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({ command: "echo '001'", cwd: dir, env: { KB_AUTOMATION: "1" } });
    let d = fm(p);
    expect(d.automations.n).toEqual({ status: "running", at: AT, runs: 1 });
    expect(d.automations.c.status).toBe("done");
    expect(d.x).toBe(1);
    expect(Object.values(d.comments)).toEqual(["hi"]);
    runner.finish();
    await kb.settled();
    d = fm(p);
    expect(d.automations.n).toEqual({ status: "done", at: AT, exit: 0, runs: 1 });
    expect(d.status).toBe("done");
    expect(records.at(-1)).toMatchObject({ rule: "n", status: "done", board: "default", path: p, ticketId: "001" });
  });

  it("failed on non-zero exit and on error", async () => {
    const { kb, runner } = setup(BASIC);
    const { id, path: p } = kb.add({ name: "a" });
    runner.finish({ exitCode: 3 });
    await kb.settled();
    expect(fm(p).automations.c).toEqual({ status: "failed", at: AT, exit: 3, runs: 1 });
    kb.move(id, "done");
    runner.finish({ exitCode: null, error: "boom" }, 1);
    await kb.settled();
    expect(fm(p).automations.n).toEqual({ status: "failed", at: AT, exit: null, error: "boom", runs: 1 });
  });

  it("render error → failed without running", async () => {
    const { kb, runner, records } = setup(BASIC.replace("echo {{ id }}", "echo {{ nope }}"));
    const { id, path: p } = kb.add({ name: "a" });
    runner.finish();
    await kb.settled();
    runner.calls.length = 0;
    kb.move(id, "done");
    await kb.settled();
    expect(runner.calls).toHaveLength(0);
    expect(fm(p).automations.n.status).toBe("failed");
    expect(fm(p).automations.n.error).toMatch(/nope/);
    expect(records.at(-1)!.status).toBe("failed");
  });

  it("list runs all steps in order", async () => {
    const { kb, runner, records } = setup(STEPS);
    const { path: p } = kb.add({ name: "a" });
    expect(runner.calls.map((c) => c.command)).toEqual(["echo one"]);
    runner.finish();
    await tick();
    expect(runner.calls.map((c) => c.command)).toEqual(["echo one", "echo two '001'"]);
    runner.finish({}, 1);
    await tick();
    expect(runner.calls.map((c) => c.command)).toEqual(["echo one", "echo two '001'", "echo three"]);
    runner.finish({}, 2);
    await kb.settled();
    expect(runner.calls.every((c) => c.env.KB_AUTOMATION === "1")).toBe(true);
    expect(fm(p).automations.m).toEqual({ status: "done", at: AT, exit: 0, runs: 1 });
    expect(records.at(-1)).toMatchObject({ status: "done", command: "echo one && echo two '001' && echo three" });
    expect(records.at(-1)!.failedStep).toBeUndefined();
  });

  it("step 0 fails → later steps do not run", async () => {
    const { kb, runner, records } = setup(STEPS);
    const { path: p } = kb.add({ name: "a" });
    expect(runner.calls.map((c) => c.command)).toEqual(["echo one"]);
    runner.finish({ exitCode: 7 });
    await tick();
    expect(runner.calls).toHaveLength(1);
    await kb.settled();
    expect(fm(p).automations.m).toEqual({ status: "failed", at: AT, exit: 7, step: 1, runs: 1 });
    expect(records.at(-1)).toMatchObject({ status: "failed", failedStep: 1, command: "echo one && echo two '001' && echo three" });
  });

  it("continueOnError: true keeps the first failure's result", async () => {
    const { kb, runner, records, evs } = setup(STEPS.replace("    run:", "    continueOnError: true\n    run:"), { events: true });
    const { path: p } = kb.add({ name: "a" });
    runner.finish({ exitCode: 3, stdout: "one out\n", stderr: "one err\n", error: "step one broke" });
    await tick();
    expect(runner.calls.map((c) => c.command)).toEqual(["echo one", "echo two '001'"]);
    runner.finish({}, 1);
    await tick();
    expect(runner.calls.map((c) => c.command)).toEqual(["echo one", "echo two '001'", "echo three"]);
    runner.finish({}, 2);
    await kb.settled();
    // the first failure is what gets recorded, not the last (successful) step
    expect(fm(p).automations.m).toEqual({ status: "failed", at: AT, exit: 3, error: "step one broke", step: 1, runs: 1 });
    expect(records.at(-1)).toMatchObject({
      status: "failed",
      failedStep: 1,
      result: { exitCode: 3, stdout: "one out\n", stderr: "one err\n", error: "step one broke" },
    });
    expect(evs.find((e) => e.type === "automation.finished")!.data).toMatchObject({
      status: "failed",
      exit: 3,
      error: "step one broke",
      step: 1,
    });
  });

  it("all steps succeeding records the last result and no step", async () => {
    const { kb, runner, evs } = setup(STEPS.replace("    run:", "    continueOnError: true\n    run:"), { events: true });
    const { path: p } = kb.add({ name: "a" });
    runner.finish({}, 0);
    await tick();
    runner.finish({}, 1);
    await tick();
    runner.finish({ stdout: "three out\n" }, 2);
    await kb.settled();
    expect(fm(p).automations.m).toEqual({ status: "done", at: AT, exit: 0, runs: 1 });
    const data = evs.find((e) => e.type === "automation.finished")!.data;
    expect(data).toMatchObject({ status: "done", exit: 0 });
    expect(data.step).toBeUndefined();
  });

  it("a failing string run records no step", async () => {
    const { kb, runner } = setup(BASIC);
    const { path: p } = kb.add({ name: "a" });
    runner.finish({ exitCode: 4, error: "boom" });
    await kb.settled();
    expect(fm(p).automations.c).toEqual({ status: "failed", at: AT, exit: 4, error: "boom", runs: 1 });
    expect(fm(p).automations.c.step).toBeUndefined();
  });

  it("a string run is still a single step", async () => {
    const { kb, runner, records } = setup(BASIC);
    kb.add({ name: "a" });
    expect(runner.calls.map((c) => c.command)).toEqual(["echo created '001'"]);
    expect(records).toHaveLength(0);
    runner.finish();
    await kb.settled();
    expect(records.at(-1)).toMatchObject({ status: "done", command: "echo created '001'" });
    expect(records.at(-1)!.failedStep).toBeUndefined();
  });

  it("no trigger when status unchanged or non-status edits", () => {
    const { kb, runner } = setup(BASIC);
    const { id } = kb.add({ name: "a", status: "done" });
    runner.calls.length = 0;
    kb.move(id, "done");
    kb.update(id, { name: "b", addLabels: ["x"] });
    kb.comment(id, "c");
    expect(runner.calls).toHaveLength(0);
  });

  it("settled waits", async () => {
    const { kb, runner } = setup(BASIC);
    kb.add({ name: "a" });
    let done = false;
    const s = kb.settled().then(() => (done = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    runner.finish();
    await s;
    expect(done).toBe(true);
  });

  it("status writes don't retrigger", async () => {
    const { kb, runner } = setup(BASIC);
    kb.add({ name: "a" });
    runner.finish();
    await kb.settled();
    expect(runner.calls).toHaveLength(1);
  });

  it("disabled or no runner: nothing runs, nothing written", async () => {
    for (const o of [{ automations: false }, { noRunner: true }]) {
      const { kb, runner } = setup(BASIC, o);
      const { id, path: p } = kb.add({ name: "a" });
      kb.move(id, "done");
      await kb.settled();
      expect(runner.calls).toHaveLength(0);
      expect(fm(p).automations).toBeUndefined();
      fs.rmSync(path.join(dir, p));
    }
  });

  it("file deleted before completion is fine", async () => {
    const { kb, runner, records } = setup(BASIC);
    const { path: p } = kb.add({ name: "a" });
    fs.rmSync(path.join(dir, p));
    runner.finish();
    await kb.settled();
    expect(fs.existsSync(path.join(dir, p))).toBe(false);
    expect(records).toHaveLength(1);
  });

  it("rules are per board", async () => {
    const { kb, runner } = setup(
      BASIC +
        "boards:\n  other:\n    columns: [todo, done]\n  third:\n    columns: [todo, done]\n    automations:\n      - { name: t, when: { created_in: todo }, run: 'echo {{ board }}' }\n",
    );
    kb.add({ name: "a", board: "other" });
    expect(runner.calls).toHaveLength(0);
    kb.add({ name: "b", board: "third" });
    expect(runner.calls.map((c) => c.command)).toEqual(["echo 'third'"]);
    runner.finish();
    await kb.settled();
  });

  it("automations is a reserved prop and not a user prop", async () => {
    const { kb, runner } = setup(BASIC);
    expect(() => kb.add({ name: "a", properties: { automations: 1 } })).toThrow(/reserved/);
    const { id } = kb.add({ name: "a" });
    runner.finish();
    await kb.settled();
    expect(kb.get(id).props).toEqual({});
  });
});

describe("placeholder contexts", () => {
  const ctx = (t: string) => placeholderContextProblems(t).map((p) => `${p.variable}:${p.context}`);
  it("flags quotes, backticks, heredocs", () => {
    expect(ctx('echo "{{ name }}"')).toEqual(["name:double-quote"]);
    expect(ctx("echo '{{ name }}'")).toEqual(["name:single-quote"]);
    expect(ctx("echo `{{ name }}`")).toEqual(["name:backtick"]);
    expect(ctx("cat <<EOF\nhi {{ body }}\nEOF\necho {{ id }}")).toEqual(["body:heredoc"]);
    expect(ctx("cat <<-'EOF'\n\t{{ body }}\n\tEOF")).toEqual(["body:heredoc"]);
    expect(ctx('echo "a $(echo {{ name }}) b"')).toEqual([]);
    expect(ctx('echo "a \\" {{ name }}"')).toEqual(["name:double-quote"]);
  });
  it("allows bare and nested bare", () => {
    expect(ctx("echo {{ name }} && x {{id}}")).toEqual([]);
    expect(ctx("echo $(foo {{ name }})")).toEqual([]);
    expect(ctx('echo $(foo (a) {{ name }}) "x" {{ id }}')).toEqual([]);
    expect(ctx("# c {{ id }}\necho {{ id }}")).toEqual([]);
    expect(ctx("echo \"x\" {{ id }} 'y' {{ name }}")).toEqual([]);
  });
  it("renderCommand throws invalid", () => {
    expect(() => renderCommand('echo "{{ name }}"', { name: "$(touch X)" })).toThrow(/must not be inside/);
  });
  it("strips NUL", () => {
    expect(shellQuote("a\0b")).toBe("'ab'");
  });
  it("props lookup ignores prototype keys", () => {
    const vars = { props: { a: 1 } };
    for (const k of ["constructor", "toString", "__proto__"]) {
      expect(renderCommand(`echo {{ props.${k} }}`, vars)).toBe("echo ''");
    }
  });
  it("props keys containing ':'", () => {
    const r = rule({ when: { moved_to: "done", props: { "a:b": "x" } } });
    expect(matchRule(r, mv, tk({ data: { "a:b": "x" } }))).toBe(true);
    expect(matchRule(r, mv, tk({ data: { "a:b": "y" } }))).toBe(false);
    const l = rule({ when: { moved_to: "done", props: { k: "x" } } });
    expect(matchRule(l, mv, tk({ data: { k: ["w", "x"] } }))).toBe(true);
  });
  it("does not match inherited props", () => {
    const r = rule({ when: { moved_to: "done", props: { constructor: "!x" } } });
    expect(matchRule(r, mv, tk())).toBe(true);
  });
});

describe("status writes follow the ticket", () => {
  const Y = "columns: [todo, done]\nautomations:\n  - { name: n, when: { moved_to: done }, run: ls }\n";
  const T = (id: string) => `---\ntype: ticket\nid: "${id}"\nname: T\nstatus: todo\n---\n`;
  it("rename mid-run writes to the new path", async () => {
    w("1.md", T("001"));
    const { kb, runner } = setup(Y);
    kb.move("001", "done");
    fs.renameSync(path.join(dir, "1.md"), path.join(dir, "2.md"));
    runner.finish();
    await kb.settled();
    expect(fm("2.md").automations.n.status).toBe("done");
    expect(fs.existsSync(path.join(dir, "1.md"))).toBe(false);
  });
  it("never writes to a file with another id", async () => {
    w("1.md", T("001"));
    const { kb, runner } = setup(Y);
    kb.move("001", "done");
    fs.rmSync(path.join(dir, "1.md"));
    w("1.md", T("009"));
    runner.finish();
    await kb.settled();
    expect(fm("1.md").automations).toBeUndefined();
  });
  it("skips when the ticket is gone", async () => {
    w("1.md", T("001"));
    const { kb, runner } = setup(Y);
    kb.move("001", "done");
    fs.rmSync(path.join(dir, "1.md"));
    runner.finish();
    await kb.settled();
    expect(fs.existsSync(path.join(dir, "1.md"))).toBe(false);
  });
});
