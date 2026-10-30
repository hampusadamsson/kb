import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
      addLabels: ["new", "old"],
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
    k.update(id, { name: "A", status: "todo", addLabels: ["l"], removeLabels: ["zzz"], setProps: { p: "1" }, unsetProps: ["q"], body: "same" });
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
});
