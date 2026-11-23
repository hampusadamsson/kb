import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { automationProblems, guardEnabled, matchRule, type AutomationEvent } from "../src/core/automation.js";
import { automationSchema, type Automation } from "../src/core/config.js";
import { createKanban } from "../src/index.js";
import type { Ticket } from "../src/core/tickets.js";
import { configToForm, formToPayload } from "../src/web/public/logic.js";

const rule = (when: object, extra: object = {}) => ({ name: "r", when, run: "echo hi", ...extra });
const parse = (r: object) => automationSchema.safeParse(r);
const tk = (over: Partial<Ticket> = {}): Ticket =>
  ({ path: "1.md", id: "1", name: "T", status: "todo", board: "default", labels: [], props: {}, data: {}, body: "", ...over }) as Ticket;
const tick: AutomationEvent = { type: "schedule" };

describe("schedule schema", () => {
  it("accepts schedule, with and without in", () => {
    expect(parse(rule({ schedule: "*/5 * * * *" })).success).toBe(true);
    expect(parse(rule({ schedule: "0 9 * * 1", in: "todo" })).success).toBe(true);
  });
  it("rejects none, several, and in without schedule", () => {
    for (const w of [
      {},
      { schedule: "* * * * *", moved_to: "a" },
      { schedule: "* * * * *", created_in: "a" },
      { moved_to: "a", created_in: "b" },
    ]) {
      const r = parse(rule(w));
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain("exactly one of moved_to / created_in / schedule");
    }
    expect(parse(rule({ moved_to: "a", in: "todo" })).success).toBe(false);
  });
});

describe("matchRule schedule", () => {
  const r = (when: object) => rule(when) as Automation;
  it("ignores `to`, requires schedule", () => {
    expect(matchRule(r({ schedule: "* * * * *" }), tick, tk())).toBe(true);
    expect(matchRule(r({ moved_to: "todo" }), tick, tk())).toBe(false);
  });
  it("applies in, labels, props", () => {
    expect(matchRule(r({ schedule: "* * * * *", in: "todo" }), tick, tk())).toBe(true);
    expect(matchRule(r({ schedule: "* * * * *", in: "done" }), tick, tk())).toBe(false);
    expect(matchRule(r({ schedule: "* * * * *", labels: ["x"] }), tick, tk())).toBe(false);
    expect(matchRule(r({ schedule: "* * * * *", labels: ["x"] }), tick, tk({ labels: ["x"] }))).toBe(true);
    expect(matchRule(r({ schedule: "* * * * *", props: { k: "v" } }), tick, tk({ data: { k: "v" } }))).toBe(true);
    expect(matchRule(r({ schedule: "* * * * *", props: { k: "v" } }), tick, tk())).toBe(false);
  });
  it("keeps other events unchanged", () => {
    expect(matchRule(r({ moved_to: "done" }), { type: "moved_to", to: "done" }, tk())).toBe(true);
    expect(matchRule(r({ moved_to: "done" }), { type: "moved_to", to: "x" }, tk())).toBe(false);
  });
});

describe("guardEnabled", () => {
  it("defaults", () => {
    expect(guardEnabled(rule({ moved_to: "a" }) as Automation)).toBe(true);
    expect(guardEnabled(rule({ moved_to: "a" }, { guard: false }) as Automation)).toBe(false);
    expect(guardEnabled(rule({ schedule: "* * * * *" }) as Automation)).toBe(false);
    expect(guardEnabled(rule({ schedule: "* * * * *" }, { guard: true }) as Automation)).toBe(true);
  });
});

describe("automationProblems schedule", () => {
  const probs = (r: object) => automationProblems({ name: "default", columns: ["todo", "done"], automations: [r as Automation] });
  it("accepts a good rule", () => {
    expect(probs(rule({ schedule: "*/5 * * * *", in: "todo" }))).toEqual([]);
  });
  it("invalid cron", () => {
    const p = probs(rule({ schedule: "nope" }));
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("invalid schedule");
    expect(p[0]).toContain("nope");
  });
  it("unknown in column", () => {
    expect(probs(rule({ schedule: "* * * * *", in: "zzz" }))[0]).toContain('column "zzz"');
  });
  it("from/to vars", () => {
    const p = probs(rule({ schedule: "* * * * *" }, { run: "echo {{from}} {{ to }}" }));
    expect(p).toHaveLength(2);
    expect(p[0]).toContain("not available in schedule rules");
  });
  it("from/to still fine in moved_to rules", () => {
    expect(probs(rule({ moved_to: "done" }, { run: "echo {{from}} {{to}}" }))).toEqual([]);
  });
});

describe("settings round-trip", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-sc-"));
    fs.writeFileSync(path.join(dir, "kanban.yaml"), "columns: [todo, done]\n");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("saves schedule + in and reads them back", () => {
    const kb = createKanban({ dir });
    const cfg = kb.getConfig().config;
    kb.updateConfig({ ...cfg, automations: [rule({ schedule: "0 9 * * *", in: "todo" }) as Automation] });
    expect(fs.readFileSync(path.join(dir, "kanban.yaml"), "utf8")).toContain("schedule: 0 9 * * *");
    const back = kb.getConfig().config;
    expect(back.automations?.[0].when).toEqual({ schedule: "0 9 * * *", in: "todo" });
    expect(kb.updateConfig(back)).toMatchObject({ configChanged: false });
  });
  it("rejects an invalid cron on save", () => {
    const kb = createKanban({ dir });
    expect(() => kb.updateConfig({ ...kb.getConfig().config, automations: [rule({ schedule: "bad" }) as Automation] })).toThrow(
      /invalid schedule/,
    );
  });
  it("form round-trip keeps schedule, in and guard", () => {
    const c = {
      name: "default",
      glob: "*.md",
      columns: ["todo", "done"],
      boards: {},
      automations: [rule({ schedule: "0 9 * * *", in: "todo" })],
    };
    const form = configToForm(c as never);
    expect(form.automations[0]).toMatchObject({ event: "schedule", schedule: "0 9 * * *", column: "todo", guard: false });
    expect(formToPayload(form).config.automations).toEqual(c.automations);
    form.automations[0].guard = true;
    expect(formToPayload(form).config.automations[0]).toMatchObject({ guard: true });
  });
});
