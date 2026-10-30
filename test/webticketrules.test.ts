import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS ES module without types
import * as T from "../src/web/public/ticket-rules-logic.js";
// @ts-expect-error plain JS ES module without types
import * as L from "../src/web/public/logic.js";

const A = T as any;
const B = L as any;
const DEF = { baseline: true, include: [], exclude: [] };
const base = { name: "default", glob: "*.md", columns: ["todo"], boards: {} };
const rule = (o: object = {}) => ({ ...A.newTicketRule(), ...o });

describe("summarizeRule", () => {
  it("describes conditions", () => {
    const r = A.ticketsToForm({ include: [{ glob: "tasks/**/*.md", prefix: "T-", props: { kind: "task" } }] }).include[0];
    expect(A.summarizeRule(r)).toBe("Files in tasks/**/*.md whose name starts with T- and kind = task");
  });
  it("handles negation, has, and empty", () => {
    const r = A.ticketsToForm({ exclude: [{ props: { type: "!daily" }, has: ["status", "!done"] }] }).exclude[0];
    expect(A.summarizeRule(r)).toBe("Files where type ≠ daily and has status and has no done");
    expect(A.summarizeRule(rule())).toBe("No conditions yet.");
    expect(A.summarizeRule(rule({ glob: "a/**" }))).toBe("Files in a/**");
  });
});

describe("presets", () => {
  it("builds prefilled rules", () => {
    expect(A.ruleToConfig(A.presetRule("include", "folder"))).toEqual({ glob: "tasks/**/*.md" });
    expect(A.ruleToConfig(A.presetRule("exclude", "underscore"))).toEqual({ prefix: "_" });
    expect(A.ruleToConfig(A.presetRule("exclude", "daily"))).toEqual({ props: { type: "daily" } });
    expect(A.ruleToConfig(A.presetRule("exclude", "templates"))).toEqual({ glob: "templates/**" });
    expect(A.presetRule("include", "nope")).toBeNull();
    for (const k of ["include", "exclude"]) for (const p of A.PRESETS[k]) expect(A.checkRule(A.presetRule(k, p.id))).toBe("");
  });
});

describe("validation", () => {
  it("mirrors the server rules", () => {
    expect(A.checkRule(rule())).toMatch(/at least one condition/);
    expect(A.checkRule(rule({ name: "x" }))).toMatch(/at least one condition/);
    expect(A.checkRule(rule({ glob: "/abs/*.md" }))).toMatch(/relative/);
    expect(A.checkRule(rule({ glob: "../x/*.md" }))).toMatch(/\.\./);
    expect(A.checkRule(rule({ glob: "a/{b,c" }))).toMatch(/brackets/);
    expect(A.checkRule(rule({ glob: "a/[b]/{c,d}/*.md" }))).toBe("");
    expect(A.checkRule(rule({ prefix: "a/b" }))).toMatch(/slash/);
    expect(A.checkRule(rule({ has: ["a", " "] }))).toMatch(/empty/);
    expect(A.checkRule(rule({ props: [{ key: "", value: "x" }] }))).toMatch(/at least one condition/);
    expect(A.checkRule(rule({ prefix: "T-" }))).toBe("");
  });
  it("names the rule in the form error and feeds checkForm", () => {
    const f = A.ticketsToForm({ include: [{ glob: "a/*.md" }], exclude: [{ name: "tpl", prefix: "_" }] });
    f.exclude.push(rule({ name: "bad" }));
    expect(A.checkTickets(f)).toMatch(/^Ticket rules: exclude rule 2 "bad" needs at least one condition/);
    const form = B.configToForm(base);
    form.tickets = f;
    expect(B.checkForm(form)).toMatch(/exclude rule 2 "bad"/);
    expect(B.errorTab(B.checkForm(form))).toBe("config");
    form.tickets = A.ticketsToForm({ include: [{ glob: "a/*.md" }] });
    expect(B.checkForm(form)).toBe("");
  });
  it("warns when nothing can be a ticket", () => {
    expect(A.noTicketsWarning({ baseline: false, include: [], exclude: [] })).toBe("No files will count as tickets.");
    expect(A.noTicketsWarning({ baseline: false, include: [rule({ glob: "a" })], exclude: [] })).toBe("");
    expect(A.noTicketsWarning({ baseline: true, include: [], exclude: [] })).toBe("");
  });
});

describe("payload and dirty state", () => {
  it("always sends tickets; default object when nothing is configured", () => {
    expect(B.formToPayload(B.configToForm(base)).config.tickets).toEqual(DEF);
    expect(A.isDefaultTickets(A.ticketsToConfig(A.ticketsToForm(undefined)))).toBe(true);
    const f = B.configToForm({ ...base, tickets: { baseline: false, include: [{ glob: "x/*.md" }], exclude: [] } });
    f.tickets.include = [];
    f.tickets.baseline = true;
    expect(B.formToPayload(f).config.tickets).toEqual(DEF);
  });
  it("detects dirty changes (baseline, rules, rows)", () => {
    const cfg = { ...base, tickets: { baseline: true, include: [{ glob: "t/*.md", props: { n: 1 } }], exclude: [] } };
    const f = B.configToForm(cfg);
    expect(B.formDirty(f, cfg)).toBe(false);
    expect(B.dirtyTabs(f, cfg)).toEqual({ config: false, automations: false });
    f.tickets.baseline = false;
    expect(B.formDirty(f, cfg)).toBe(true);
    expect(B.dirtyTabs(f, cfg).config).toBe(true);
    f.tickets.baseline = true;
    f.tickets.exclude.push(A.presetRule("exclude", "underscore"));
    expect(B.formDirty(f, cfg)).toBe(true);
    // an added but still blank rule is not a payload change... but untouched config is clean
    expect(B.formDirty(B.configToForm(base), base)).toBe(false);
  });
  it("preserves prop value types of untouched rules", () => {
    const t = { baseline: true, include: [{ name: "n", props: { n: 3, ok: true, s: "x", neg: "!no" }, has: ["a"] }], exclude: [] };
    const f = A.ticketsToForm(t);
    expect(A.ticketsToConfig(f)).toEqual(t);
    f.include[0].props[0].value = "4";
    expect(A.ticketsToConfig(f).include[0].props.n).toBe("4");
    expect(A.ticketsToConfig(f).include[0].props.ok).toBe(true);
  });
});

describe("preview text", () => {
  it("formats counts", () => {
    expect(A.previewText({ gained: 1, lost: 1, total: 5 })).toBe("1 file becomes a ticket, 1 file stops being a ticket (total 5)");
    expect(A.previewText({ gained: 3, lost: 0, total: 5 })).toBe("3 files become tickets, 0 files stop being tickets (total 5)");
    expect(A.previewText({ gained: 0, lost: 0, total: 5 })).toMatch(/^No change/);
  });
  it("formats the confirm scope", () => {
    expect(A.scopeLines({ gained: 2, lost: 1 })).toEqual(["2 files will become tickets", "1 file will stop being a ticket"]);
    expect(A.scopeLines({ gained: 0, lost: 0 })).toEqual([]);
    expect(A.scopeLines(undefined)).toEqual([]);
  });
});
