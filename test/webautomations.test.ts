import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS ES module without types
import * as A from "../src/web/public/automation-logic.js";
// @ts-expect-error plain JS ES module without types
import * as L from "../src/web/public/logic.js";

const a = A as any;
const l = L as any;
const cols = [
  { orig: "todo", value: "todo" },
  { orig: "done", value: "done" },
];
const rule = (o: object = {}) => ({ ...l.newRule(cols), name: "r", run: "echo {{ id }}", ...o });

describe("insertAtCursor", () => {
  it("inserts at the cursor with a separating space", () => {
    expect(a.insertAtCursor("echo", 4, 4, "{{ id }}")).toEqual({ value: "echo {{ id }}", start: 13, end: 13 });
    expect(a.insertAtCursor("echo ", 5, 5, "{{ id }}").value).toBe("echo {{ id }}");
    expect(a.insertAtCursor("", 0, 0, "{{ id }}").value).toBe("{{ id }}");
  });
  it("replaces a selection and clamps", () => {
    expect(a.insertAtCursor("a XX b", 2, 4, "{{ to }}").value).toBe("a {{ to }} b");
    expect(a.insertAtCursor("ab", 99, 99, "{{ id }}").value).toBe("ab {{ id }}");
  });
  it("selects KEY of the props snippet", () => {
    const r = a.insertAtCursor("x ", 2, 2, "{{ props.KEY }}");
    expect(r.value.slice(r.start, r.end)).toBe("KEY");
  });
});

describe("summary", () => {
  it("describes event, conditions and script", () => {
    const r = rule({
      column: "review",
      labels: ["bug"],
      props: [
        { key: "owner", value: "me" },
        { key: "p", value: "!low" },
        { key: " ", value: "x" },
      ],
    });
    expect(a.ruleSummary(r)).toBe("When a ticket moves to review · labels: bug · owner = me, p not low · runs echo {{ id }}");
    expect(a.ruleSummary(rule({ event: "created_in", column: "todo", run: " " }))).toBe("When a ticket is created in todo · no script yet");
  });
  it("truncates long scripts to one line", () => {
    const s = a.ruleSummary(rule({ column: "x", run: "a\n" + "b".repeat(200) }));
    expect(s).not.toContain("\n");
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("names and templates", () => {
  it("uniqueName / duplicateRule", () => {
    const rs = [rule({ name: "a" }), rule({ name: "a-2" })];
    expect(a.uniqueName(rs, "a")).toBe("a-3");
    expect(a.uniqueName(rs, "z")).toBe("z");
    const d = a.duplicateRule(rule({ name: "a", labels: ["x"], props: [{ key: "k", value: "v" }] }), rs);
    expect(d).toMatchObject({ name: "a-copy", orig: null, labels: ["x"] });
    d.labels.push("y");
    expect(a.duplicateRule(rs[0], rs).labels).toEqual([]);
  });
  it("starterRule picks first/last column", () => {
    const [moved, created] = a.STARTERS;
    expect(a.starterRule(moved, cols, [], l.newRule)).toMatchObject({ event: "moved_to", column: "done", name: "on-move" });
    expect(a.starterRule(created, cols, [rule({ name: "on-create" })], l.newRule)).toMatchObject({
      event: "created_in",
      column: "todo",
      name: "on-create-2",
    });
  });
  it("starter scripts have no placeholder problems", () => {
    for (const s of a.STARTERS) expect(a.previewScript(s.run, { to: "x", labels: [], props: {}, board: "b" }, s.event)).not.toMatch(/\{\{/);
  });
});

describe("validation", () => {
  it("ruleIssues per field", () => {
    expect(a.ruleIssues(rule({ column: "todo" }), [], cols)).toEqual({});
    const bad = rule({ name: " ", run: "", column: "nope" });
    expect(Object.keys(a.ruleIssues(bad, [bad], cols)).sort()).toEqual(["column", "name", "run"]);
    const x = rule({ name: "dup", column: "todo" });
    const y = rule({ name: "dup", column: "todo" });
    expect(a.ruleIssues(y, [x, y], cols).name).toMatch(/already called "dup"/);
  });
  it("renamed column is not an issue", () => {
    const c = [{ orig: "todo", value: "backlog" }];
    expect(a.ruleIssues(rule({ column: "todo" }), [], c)).toEqual({});
  });
  it("invalidCount / filter / counts", () => {
    const rs = [rule({ column: "todo" }), rule({ name: "", column: "todo" })];
    expect(a.invalidCount(rs, cols)).toBe(1);
    expect(a.filterRules(rs, "ECHO")).toHaveLength(2);
    expect(a.filterRules([rule({ name: "ship", column: "done", run: "x" })], "zzz")).toEqual([]);
    expect(a.ruleCount(1)).toBe("1 rule");
    expect(a.ruleCount(0)).toBe("0 rules");
  });
});

describe("last runs and status text", () => {
  const now = new Date("2026-01-01T12:10:00");
  it("picks the newest run per rule; running wins", () => {
    const m = a.lastRuns([
      {
        autos: [
          { name: "r", status: "done", at: "2026-01-01T12:00:00" },
          { name: "q", status: "failed", at: "2026-01-01T12:00:00", exit: 1 },
        ],
      },
      {
        autos: [
          { name: "r", status: "failed", at: "2026-01-01T12:05:00", exit: 2 },
          { name: "q", status: "running", at: "2026-01-01T11:00:00" },
        ],
      },
      { autos: [{ name: "r", status: "done", at: "2026-01-01T11:00:00" }] },
    ]);
    expect(m.get("r").state).toBe("failed");
    expect(m.get("q").state).toBe("running");
    expect(a.statusText(m.get("r"), now)).toBe("failed 5 min ago");
    expect(a.statusText(m.get("q"), now)).toBe("running");
    expect(a.statusText(undefined)).toBe("never run");
  });
});

describe("preview", () => {
  it("renders shell-quoted sample values and props", () => {
    const s = a.sampleFor(
      rule({
        labels: ["bug"],
        props: [
          { key: "o", value: "me" },
          { key: "n", value: "!x" },
        ],
      }),
      "done",
      "main",
    );
    expect(a.previewScript("echo {{ id }} {{ to }} {{ labels }} {{ props.o }} {{ props.n }} {{ nope }}", s, "moved_to")).toBe(
      "echo '000' 'done' 'bug' 'me' '' {{ nope }}",
    );
  });
  it("durationText", () => {
    expect(a.durationText(80)).toBe("80 ms");
    expect(a.durationText(1500)).toBe("1.5 s");
  });
});

describe("automations tab sources", () => {
  const pub = (f: string) => fs.readFileSync(path.join(import.meta.dirname, "../src/web/public", f), "utf8");
  it("never uses innerHTML and keeps a11y hooks", () => {
    for (const f of ["automations.js", "automation-rule.js", "automation-logic.js"]) expect(pub(f)).not.toMatch(/innerHTML/);
    const rule = pub("automation-rule.js");
    expect(rule).toContain("aria-expanded");
    expect(rule).toContain("aria-controls");
    expect(rule).toContain("aria-describedby");
    expect(pub("style.css")).toContain("/* automations tab */");
  });
});
