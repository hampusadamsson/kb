import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createKanban, type KbEvent } from "../src/core/index.js";
import type { AutomationRunner } from "../src/core/automation.js";

let dir: string;
let evs: KbEvent[];
const sink = { emit: (e: KbEvent) => void evs.push(e) };
const mk = (extra: object = {}) => createKanban({ dir, events: sink, source: "cli", ...extra });
const types = () => evs.map((e) => e.type);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-ev-"));
  fs.writeFileSync(path.join(dir, "kanban.yaml"), "columns: [todo, doing, done]\nboards:\n  other:\n    columns: [a, b]\n");
  evs = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("core events", () => {
  it("add emits ticket.created", () => {
    const r = mk().add({ name: "Hello", labels: ["x"], properties: { p: 1 }, body: "b" });
    expect(evs).toHaveLength(1);
    const e = evs[0];
    expect(e.type).toBe("ticket.created");
    expect(e.source).toBe("cli");
    expect(e.ticketId).toBe(r.id);
    expect(e.ticketName).toBe("Hello");
    expect(e.data).toMatchObject({ status: "todo", labels: ["x"], props: { p: 1 }, hasBody: true });
    expect(e.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/);
  });

  it("source defaults to unknown; ids sort", () => {
    createKanban({ dir, events: sink }).add({ name: "a" });
    createKanban({ dir, events: sink }).add({ name: "b" });
    expect(evs[0].source).toBe("unknown");
    expect(evs[0].id < evs[1].id).toBe(true);
  });

  it("mv emits one ticket.moved", () => {
    const k = mk();
    const { id } = k.add({ name: "A" });
    evs = [];
    k.move(id, "doing");
    expect(evs).toHaveLength(1);
    expect(evs[0].type).toBe("ticket.moved");
    expect(evs[0].data).toEqual({ from: "todo", to: "doing" });
    expect(evs[0].summary).toBe(`#${id} moved todo → doing`);
  });

  it("set emits one event per kind of change", () => {
    const k = mk();
    const { id } = k.add({ name: "A", labels: ["old"], properties: { keep: "1", gone: "z" }, body: "x" });
    evs = [];
    k.update(id, {
      name: "B",
      board: "other",
      status: "a",
      addLabels: ["new"],
      removeLabels: ["old", "nope"],
      setProps: { keep: "2", fresh: 5 },
      unsetProps: ["gone", "absent"],
      body: "different",
    });
    expect(types().sort()).toEqual(["ticket.board", "ticket.body", "ticket.labels", "ticket.moved", "ticket.props", "ticket.renamed"]);
    const by = (t: string) => evs.find((e) => e.type === t)!;
    expect(by("ticket.board").data).toEqual({ from: "default", to: "other" });
    expect(by("ticket.renamed").data).toEqual({ from: "A", to: "B" });
    expect(by("ticket.labels").data).toEqual({ added: ["new"], removed: ["old"] });
    expect(by("ticket.props").data).toEqual({ set: { keep: "2", fresh: 5 }, unset: ["gone"], old: { keep: "1", gone: "z" } });
    expect(by("ticket.body").data).toMatchObject({ changed: true, toLength: 10 });
    expect(JSON.stringify(by("ticket.body"))).not.toContain("different");
  });

  it("no-op update emits nothing", () => {
    const k = mk();
    const { id } = k.add({ name: "A", labels: ["l"], properties: { p: "1" }, body: "same" });
    evs = [];
    k.update(id, {
      name: "A",
      status: "todo",
      addLabels: ["l"],
      removeLabels: ["zzz"],
      setProps: { p: "1" },
      unsetProps: ["q"],
      body: "same",
    });
    expect(evs).toEqual([]);
  });

  it("comment emits clipped ticket.comment (via update and comment())", () => {
    const k = mk();
    const { id } = k.add({ name: "A" });
    evs = [];
    k.comment(id, "y".repeat(500));
    k.update(id, { comment: "hi" });
    expect(types()).toEqual(["ticket.comment", "ticket.comment"]);
    expect((evs[0].data.text as string).length).toBeLessThanOrEqual(201);
    expect(evs[1].data.text).toBe("hi");
  });

  it("fix emits ids.fixed, not on dry-run", () => {
    fs.writeFileSync(path.join(dir, "x.md"), "---\ntype: ticket\nname: X\nstatus: todo\n---\n");
    const k = mk();
    k.fix({ dryRun: true });
    expect(evs).toEqual([]);
    k.fix();
    expect(types()).toEqual(["ids.fixed"]);
    expect((evs[0].data.changes as unknown[]).length).toBe(1);
  });

  it("updateConfig emits config.updated with diff; dry-run and no-op nothing", () => {
    const k = mk();
    k.add({ name: "A" });
    evs = [];
    const cfg = k.getConfig().config as any;
    k.updateConfig(cfg);
    k.updateConfig({ ...cfg, columns: ["todo", "doing", "done", "extra"] }, { dryRun: true });
    expect(evs).toEqual([]);
    k.updateConfig(
      { ...cfg, columns: ["todo", "review", "done", "extra"], automations: [{ name: "r", when: { moved_to: "done" }, run: "true" }] },
      { renames: { columns: { default: { doing: "review" } } } },
    );
    expect(types()).toEqual(["config.updated"]);
    const d = evs[0].data as any;
    expect(d.columns.added).toEqual([{ board: "default", name: "extra" }]);
    expect(d.columns.renamed).toEqual([{ board: "default", from: "doing", to: "review" }]);
    expect(d.automations.added).toEqual([{ board: "default", name: "r" }]);
  });

  it('config.updated reports a default-board column rename keyed "" (as the web UI sends it)', () => {
    const k = mk();
    k.add({ name: "A", status: "doing" });
    evs = [];
    const cfg = k.getConfig().config as any;
    k.updateConfig({ ...cfg, columns: ["todo", "review", "done"] }, { renames: { columns: { "": { doing: "review" } } } });
    const d = evs.find((e) => e.type === "config.updated")!.data as any;
    expect(d.columns.renamed).toEqual([{ board: "default", from: "doing", to: "review" }]);
    expect(d.columns.added).toEqual([]);
    expect(d.columns.removed).toEqual([]);
  });
});

describe("automation events", () => {
  const cfg = `columns: [todo, done]\nautomations:\n  - name: r\n    when: { moved_to: done }\n    run: "echo {{ id }}"\n  - name: off\n    enabled: false\n    when: { moved_to: done }\n    run: "true"\n`;
  const runner = (exitCode: number): AutomationRunner => ({ run: async () => ({ exitCode, stdout: "", stderr: "" }) });

  it("emits started/finished (+skipped for disabled) and no extra ticket.* from status writes", async () => {
    fs.writeFileSync(path.join(dir, "kanban.yaml"), cfg);
    const k = mk({ runner: runner(3) });
    const { id } = k.add({ name: "A" });
    evs = [];
    k.move(id, "done");
    await k.settled();
    expect(types().sort()).toEqual(["automation.finished", "automation.skipped", "automation.started", "ticket.moved"]);
    const fin = evs.find((e) => e.type === "automation.finished")!;
    expect(fin.data).toMatchObject({ rule: "r", status: "failed", exit: 3 });
    expect(typeof fin.data.durationMs).toBe("number");
    expect(fin.ticketId).toBe(id);
    expect(evs.find((e) => e.type === "automation.skipped")!.data).toMatchObject({ rule: "off", reason: "rule-disabled" });
  });

  it("without runner, matching rules are skipped", () => {
    fs.writeFileSync(path.join(dir, "kanban.yaml"), cfg);
    const k = mk();
    const { id } = k.add({ name: "A" });
    evs = [];
    k.move(id, "done");
    expect(evs.filter((e) => e.type === "automation.skipped")).toHaveLength(2);
  });

  // A failed automation-state write used to be swallowed (`catch { return false; }`, return value ignored).
  // That hid the one failure mode the loop guard depends on: if the `runs` counter cannot be persisted, a
  // self-retriggering rule never reaches the limit. It must now surface as a diagnostic and not dispatch.
  const failStatusWrites = (): (() => void) => {
    const real = fs.writeFileSync.bind(fs) as typeof fs.writeFileSync;
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(((file: any, data: any, opts: any) => {
      // Only automation-state writes fail: the ticket move itself must still land, so the rule still matches.
      if (/status: (running|skipped)/.test(String(data))) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${String(file)}'`), { code: "EACCES" });
      }
      return real(file, data, opts);
    }) as typeof fs.writeFileSync);
    return () => spy.mockRestore();
  };

  it("a failed runs-counter write is reported and stops the dispatch (no silent loop)", async () => {
    fs.writeFileSync(path.join(dir, "kanban.yaml"), cfg);
    const runs: string[] = [];
    const k = mk({ runner: { run: async (c: string) => (runs.push(c), { exitCode: 0, stdout: "", stderr: "" }) } });
    const { id } = k.add({ name: "A" });
    evs = [];
    const restore = failStatusWrites();
    try {
      k.move(id, "done");
      await k.settled();
    } finally {
      restore();
    }
    // The rule matched, but its run must not start: without a persisted counter the guard cannot bound it.
    expect(runs).toEqual([]);
    expect(types()).not.toContain("automation.started");
    const warn = evs.filter((e) => e.type === "automation.skipped" && e.data.reason === "state-write-failed");
    expect(warn).toHaveLength(1);
    expect(warn[0]).toMatchObject({ ticketId: id, path: expect.any(String) });
    expect(warn[0].data).toMatchObject({ rule: "r", bumped: true });
    expect(String(warn[0].data.error)).toMatch(/EACCES/);
    expect(warn[0].summary).toMatch(/state not saved/);
  });

  it("with guard: false a failed status write is reported but does not cancel the run", async () => {
    fs.writeFileSync(
      path.join(dir, "kanban.yaml"),
      `columns: [todo, done]\nautomations:\n  - name: r\n    when: { moved_to: done }\n    run: "true"\n    guard: false\n`,
    );
    const runs: string[] = [];
    const k = mk({ runner: { run: async (c: string) => (runs.push(c), { exitCode: 0, stdout: "", stderr: "" }) } });
    const { id } = k.add({ name: "A" });
    evs = [];
    const logged: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logged.push(a.join(" ")));
    const restore = failStatusWrites();
    try {
      k.move(id, "done");
      await k.settled();
    } finally {
      restore();
      errSpy.mockRestore();
    }
    // The runs counter is not used by the guard, so a failed write must not drop the run.
    expect(runs).toEqual(["true"]);
    expect(types()).toContain("automation.started");
    const warn = evs.filter((e) => e.type === "automation.skipped" && e.data.reason === "state-write-failed");
    expect(warn).toHaveLength(1);
    expect(logged.some((l) => /^kb: could not persist automation state for #001: .*EACCES/.test(l))).toBe(true);
  });

  it("a failed status write is logged even without an event sink", async () => {
    fs.writeFileSync(path.join(dir, "kanban.yaml"), cfg);
    const runs: string[] = [];
    const k = createKanban({ dir, runner: { run: async (c: string) => (runs.push(c), { exitCode: 0, stdout: "", stderr: "" }) } });
    const { id } = k.add({ name: "A" });
    const logged: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logged.push(a.join(" ")));
    const restore = failStatusWrites();
    try {
      k.move(id, "done");
      await k.settled();
    } finally {
      restore();
      errSpy.mockRestore();
    }
    expect(runs).toEqual([]);
    expect(logged).toContainEqual(expect.stringMatching(/^kb: could not persist automation state for #001: /));
  });

  it("a non-counter status write still fails loudly but keeps its call site's behaviour", async () => {
    // Guardrail path: the ticket is already over the limit, so the skipped status write failing must not
    // swallow the guardrail skip event itself.
    fs.writeFileSync(
      path.join(dir, "kanban.yaml"),
      `columns: [todo, done]\nautomations:\n  - name: r\n    when: { moved_to: done }\n    run: "true"\n`,
    );
    const k = mk({ runner: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } });
    const { id } = k.add({ name: "A" });
    const file = path.join(
      dir,
      fs.readdirSync(dir).find((f) => f.endsWith(".md"))!,
    );
    const many = Array.from({ length: 15 }, (_, i) => `  old${i}: { status: done, at: "2026-01-01T00:00:00" }\n`).join("");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("---\n", `---\nautomations:\n${many}`));
    evs = [];
    const restore = failStatusWrites();
    try {
      k.move(id, "done");
      await k.settled();
    } finally {
      restore();
    }
    const reasons = evs.filter((e) => e.type === "automation.skipped").map((e) => e.data.reason);
    expect(reasons).toContain("state-write-failed");
    expect(reasons).toContain("guardrail");
    expect(types()).not.toContain("automation.started");
  });

  it("a read-only ticket file surfaces the state-write failure (real fs)", async () => {
    // Real-fs counterpart to the stubbed test: on macOS an owned file with mode 0o444 still rejects writes.
    // The mode is applied from inside the runner, i.e. after the ticket move but before the pid status write.
    if (process.getuid?.() === 0) return; // root ignores file modes
    fs.writeFileSync(path.join(dir, "kanban.yaml"), cfg);
    const { id } = mk().add({ name: "A" });
    const file = path.join(
      dir,
      fs.readdirSync(dir).find((f) => f.endsWith(".md"))!,
    );
    const ran: string[] = [];
    const ro = mk({
      runner: {
        run: async (c: string, opts: any) => {
          ran.push(c);
          fs.chmodSync(file, 0o444);
          opts.onSpawn({ pid: 1234, pgid: 1234 });
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    });
    evs = [];
    try {
      ro.move(id, "done");
      await ro.settled();
    } finally {
      fs.chmodSync(file, 0o644);
    }
    expect(ran).toHaveLength(1);
    const warn = evs.filter((e) => e.type === "automation.skipped" && e.data.reason === "state-write-failed");
    expect(warn.length).toBeGreaterThan(0);
    expect(String(warn[0].data.error)).toMatch(/EACCES|EPERM|permission/i);
  });
});
