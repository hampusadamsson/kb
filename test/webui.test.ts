import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS ES module without types
import * as L from "../src/web/public/logic.js";

const any = L as any;

describe("hash state", () => {
  it("parses repeated params and negation", () => {
    expect(any.parseHash("#board=other&text=hi%20there&l=bug&l=urgent&p=priority:high&p=!status:done")).toEqual({
      board: "other",
      text: "hi there",
      labels: ["bug", "urgent"],
      props: ["priority:high", "!status:done"],
    });
  });
  it("empty hash → defaults", () => {
    expect(any.parseHash("")).toEqual({ board: null, text: "", labels: [], props: [] });
  });
  it("round-trips", () => {
    const f = { board: "all", text: "a&b=c", labels: ["!bug", "x y"], props: ["k:v:w", "!k"] };
    const s = any.serializeHash(f);
    expect(s.startsWith("#")).toBe(true);
    expect(any.parseHash(s)).toEqual(f);
    expect(any.serializeHash({ board: null, text: "", labels: [], props: [] })).toBe("");
  });
});

describe("filter query", () => {
  it("maps to label/property/text", () => {
    const q = new URLSearchParams(any.filterQuery({ board: "x", text: "t", labels: ["!a", "b"], props: ["!k:v"] }));
    expect(q.get("text")).toBe("t");
    expect(q.getAll("label")).toEqual(["!a", "b"]);
    expect(q.getAll("property")).toEqual(["!k:v"]);
    expect(q.has("board")).toBe(false);
  });
});

describe("toScalar", () => {
  it("converts numbers and booleans, else string", () => {
    expect(any.toScalar("3")).toBe(3);
    expect(any.toScalar("-2.5")).toBe(-2.5);
    expect(any.toScalar("true")).toBe(true);
    expect(any.toScalar("false")).toBe(false);
    expect(any.toScalar("007")).toBe("007");
    expect(any.toScalar("high")).toBe("high");
    expect(any.toScalar("")).toBe("");
    expect(any.toScalar("1e3")).toBe("1e3");
  });
});

describe("buildPatch", () => {
  const orig = any.snapshot({
    name: "A", status: "todo", board: "main", body: "b", labels: ["x", "y"], props: { p: 1, q: "z" },
  });
  it("is empty when unchanged", () => {
    expect(any.buildPatch(orig, structuredClone(orig))).toEqual({});
  });
  it("sends only changes", () => {
    const cur = structuredClone(orig);
    cur.name = "B";
    cur.status = "done";
    cur.body = "c";
    cur.labels = ["y", "new"];
    cur.props = { p: "2", r: "true" };
    expect(any.buildPatch(orig, cur)).toEqual({
      name: "B",
      status: "done",
      body: "c",
      addLabels: ["new"],
      removeLabels: ["x"],
      setProps: { p: 2, r: true },
      unsetProps: ["q"],
    });
  });
  it("shows stored values as strings so unchanged ones are not resent", () => {
    expect(orig.props).toEqual({ p: "1", q: "z" });
  });
});

describe("misc", () => {
  it("buildCreate", () => {
    expect(
      any.buildCreate({ name: " N ", status: "todo", board: "", body: "", labels: ["a"], props: { n: "5" } }, " hi "),
    ).toEqual({ name: "N", status: "todo", labels: ["a"], properties: { n: 5 }, comment: "hi" });
  });
  it("rowsToProps drops blank keys", () => {
    expect(any.rowsToProps([{ k: " a ", v: "1" }, { k: "", v: "x" }])).toEqual({ a: "1" });
  });
  it("statusOptions keeps unknown current", () => {
    expect(any.statusOptions(["a", "b"], "zz")).toEqual(["a", "b", "zz"]);
    expect(any.statusOptions(["a", "b"], "a")).toEqual(["a", "b"]);
  });
  it("sortedComments oldest first; describeChange", () => {
    expect(any.sortedComments({ b: "2", a: "1" })).toEqual([["a", "1"], ["b", "2"]]);
    expect(any.describeChange({ path: "x.md", from: undefined, to: "003" })).toBe("x.md: id (none) → 003");
    expect(any.describeChange({ path: "x.md", from: 1, to: "001" })).toBe("x.md: id 1 → 001");
  });
});

describe("settings form logic", async () => {
  const L = await import("../src/web/public/logic.js");
  const cfg = { name: "default", glob: "*.md", columns: ["todo", "doing", "done"], boards: { other: { columns: ["a", "b"] } } };

  it("round-trips an untouched form with no renames", () => {
    const f = L.configToForm(cfg);
    const p = L.formToPayload(f);
    expect(p.config).toEqual({ ...cfg, tickets: { baseline: true, include: [], exclude: [] } });
    expect(p.renames).toEqual({ columns: {}, boards: {} });
    expect(L.formDirty(f, cfg)).toBe(false);
  });

  it("detects column renames, board renames and board column renames", () => {
    const f = L.configToForm(cfg);
    f.columns[1].value = " wip ";
    f.columns.push({ orig: null, value: "review" });
    f.boards[0].name = "ops";
    f.boards[0].columns[0].value = "backlog";
    const p = L.formToPayload(f);
    expect(p.config.columns).toEqual(["todo", "wip", "done", "review"]);
    expect(p.renames).toEqual({ columns: { "": { doing: "wip" }, other: { a: "backlog" } }, boards: { other: "ops" } });
    expect(Object.keys(p.config.boards)).toEqual(["ops"]);
    expect(L.formDirty(f, cfg)).toBe(true);
  });

  it("blank rows are removals, not renames; new boards have no rename", () => {
    const f = L.configToForm(cfg);
    f.columns[2].value = "  ";
    f.boards.push({ orig: null, name: "new", columns: [{ orig: null, value: "x" }] });
    const p = L.formToPayload(f);
    expect(p.config.columns).toEqual(["todo", "doing"]);
    expect(p.renames.columns).toEqual({});
    expect(p.renames.boards).toEqual({});
    expect(p.config.boards.new).toEqual({ columns: ["x"] });
  });

  it("checkForm reports friendly errors", () => {
    const base = () => L.configToForm(cfg);
    expect(L.checkForm(base())).toBe("");
    let f = base(); f.name = " "; expect(L.checkForm(f)).toMatch(/name/);
    f = base(); f.glob = ""; expect(L.checkForm(f)).toMatch(/Glob/);
    f = base(); f.columns = []; expect(L.checkForm(f)).toMatch(/Columns/);
    f = base(); f.columns[0].value = "doing"; expect(L.checkForm(f)).toMatch(/Duplicate column "doing"/);
    f = base(); f.boards.push({ orig: null, name: "other", columns: [{ orig: null, value: "z" }] }); expect(L.checkForm(f)).toMatch(/Duplicate board/);
    f = base(); f.boards[0].columns = []; expect(L.checkForm(f)).toMatch(/at least one column/);
  });

  it("moveItem and describeTicketChange", () => {
    expect(L.moveItem([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    expect(L.moveItem([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
    expect(L.moveItem([1, 2, 3], 2, 1)).toEqual([1, 2, 3]);
    expect(L.describeTicketChange({ path: "a.md", field: "status", from: "doing", to: "wip" })).toBe("a.md: status doing → wip");
    expect(L.describeTicketChange({ path: "a.md", field: "board", from: "x", to: undefined })).toBe("a.md: board x → (default board)");
  });
});

describe("automation form logic", async () => {
  const L = await import("../src/web/public/logic.js");
  const rule = { name: "r", when: { moved_to: "done", labels: ["bug"], props: { n: 1, k: "v" } }, run: "echo {{ id }}" };
  const cfg = () => ({
    name: "default", glob: "*.md", columns: ["todo", "done"], automations: [structuredClone(rule)],
    boards: { b: { columns: ["x", "y"], automations: [{ name: "q", when: { created_in: "x" }, run: "true", enabled: false }] } },
  });

  it("round-trips rules (typed props kept) and omits empty automations", () => {
    const f = L.configToForm(cfg());
    expect(L.formToPayload(f).config).toEqual({ ...cfg(), tickets: { baseline: true, include: [], exclude: [] } });
    expect(L.formDirty(f, cfg())).toBe(false);
    const plain = { name: "default", glob: "*.md", columns: ["todo"], boards: {} };
    expect(L.formToPayload(L.configToForm(plain)).config).toEqual({ ...plain, tickets: { baseline: true, include: [], exclude: [] } });
  });

  it("retargets rules on column rename and edits props", () => {
    const f = L.configToForm(cfg());
    f.columns[1].value = "shipped";
    f.boards[0].columns[0].value = "ex";
    f.automations[0].props[0].value = "2";
    const p = L.formToPayload(f).config;
    expect(p.automations[0].when.moved_to).toBe("shipped");
    expect(p.automations[0].when.props).toEqual({ n: "2", k: "v" });
    expect(p.boards.b.automations[0].when.created_in).toBe("ex");
    expect(L.checkForm(f)).toBe("");
  });

  it("checkForm: removed column, blanks, duplicates", () => {
    let f = L.configToForm(cfg());
    f.columns[1].value = "";
    expect(L.checkForm(f)).toMatch(/Cannot remove column "done": used by automation "r"/);
    f = L.configToForm(cfg()); f.automations[0].name = " "; expect(L.checkForm(f)).toMatch(/no name/);
    f = L.configToForm(cfg()); f.automations[0].run = " "; expect(L.checkForm(f)).toMatch(/empty script/);
    f = L.configToForm(cfg()); f.automations.push({ ...L.newRule(f.columns), name: "r", run: "x" }); expect(L.checkForm(f)).toMatch(/Duplicate automation name "r"/);
    f = L.configToForm(cfg()); f.automations[0].column = "nope"; expect(L.checkForm(f)).toMatch(/"nope"/);
  });

  it("test helpers", () => {
    expect(L.testBody({ run: "x", event: "created_in" }, "b")).toEqual({ run: "x", event: "created_in", board: "b" });
    expect(L.describeTestRun({ command: "echo 1", result: { exitCode: 0, stdout: "1\n", stderr: "" } })).toBe("$ echo 1\nexit: 0\n--- stdout ---\n1");
    expect(L.describeAutomations({ r: { status: "done", at: "T" } })).toEqual(["r: done at T"]);
    expect(L.describeAutomations(undefined)).toEqual([]);
  });
});

describe("automation status helpers", () => {
  const now = new Date(2026, 9, 30, 15, 20, 0);
  it("automationState", () => {
    const s = any.automationState;
    expect(s({ status: "done", exit: 0 })).toBe("done");
    expect(s({ status: "done" })).toBe("done");
    expect(s({ status: "done", exit: 2 })).toBe("failed");
    expect(s({ status: "done", error: "x" })).toBe("failed");
    expect(s({ status: "failed" })).toBe("failed");
    expect(s({ status: "running" })).toBe("running");
    expect(s({ status: "skipped", reason: "guardrail: 15 automation runs on this ticket" })).toBe("skipped");
    expect(s({ status: "weird" })).toBe("unknown");
    expect(s({})).toBe("unknown");
    expect(s(null)).toBe("unknown");
    expect(s("done")).toBe("unknown");
    expect(s([])).toBe("unknown");
  });
  it("relativeTime", () => {
    const r = (iso: any) => any.relativeTime(iso, now);
    expect(r("2026-10-30T15:19:40")).toBe("just now");
    expect(r("2026-10-30T15:18:00")).toBe("2 min ago");
    expect(r("2026-10-30T12:20:00")).toBe("3 h ago");
    expect(r("2026-10-29T23:59:00")).toBe("yesterday");
    expect(r("2026-10-29T15:00:00")).toBe("yesterday");
    expect(r("2026-10-28T15:00:00")).toBe("2026-10-28");
    expect(r("2026-10-31T15:00:00")).toBe("2026-10-31"); // future
    expect(r("2026-10-30T15:20:30")).toBe("just now"); // slight clock skew
    expect(r(undefined)).toBe("");
    expect(r("garbage")).toBe("");
    expect(any.relativeTime("2026-10-30T00:05:00", new Date(2026, 9, 30, 0, 10))).toBe("5 min ago");
    // 23h ago but previous calendar day → yesterday
    expect(any.relativeTime("2026-10-29T23:30:00", new Date(2026, 9, 30, 0, 10))).toBe("40 min ago");
    expect(any.relativeTime("2026-10-29T10:00:00", new Date(2026, 9, 30, 0, 10))).toBe("yesterday");
  });
  it("parses timezone-less strings as local time", () => {
    const d = any.parseLocal("2026-10-30T15:16:55");
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([2026, 9, 30, 15, 16, 55]);
    expect(any.absoluteTime("2026-10-30T15:16:55")).toBe("2026-10-30 15:16:55");
  });
  it("summarizeAutomations", () => {
    const m = {
      a: { status: "done", at: "2026-10-30T10:00:00", exit: 0 },
      b: { status: "done", at: "2026-10-30T11:00:00", exit: 0 },
      c: { status: "failed", at: "2026-10-30T09:00:00", exit: 1, error: "boom" },
      d: { status: "running", at: "2026-10-30T12:00:00" },
      e: { status: "nope" },
      f: { status: "done" },
    };
    const s = any.summarizeAutomations(m);
    expect(s.total).toBe(6);
    expect(s.counts).toEqual({ failed: 1, running: 1, skipped: 0, done: 3, unknown: 1 });
    expect(s.worst).toBe("failed");
    expect(s.list.map((i: any) => i.name)).toEqual(["d", "c", "b", "a", "f", "e"]);
    expect(s.worstFirst.map((i: any) => i.name)).toEqual(["c", "d", "b", "a", "f", "e"]);
    expect(any.automationsText(s)).toBe("6 automations: 1 failed, 1 running, 3 done, 1 unknown");
    expect(any.summarizeAutomations(undefined)).toMatchObject({ total: 0, worst: null });
    expect(any.automationsText(any.summarizeAutomations({ a: { status: "done" } }))).toBe("1 automation: 1 done");
    expect(any.summarizeAutomations([{ name: "x", status: "failed" }]).worst).toBe("failed");
  });
  it("skipped entries: summary, text, label", () => {
    const sum = any.summarizeAutomations({ a: { status: "skipped", at: "2026-10-30T10:00:00" }, b: { status: "done" } });
    expect(sum.counts.skipped).toBe(1);
    expect(any.automationsText(sum)).toBe("2 automations: 1 skipped, 1 done");
    expect(any.automationLabel(sum.list[0], now)).toContain("skipped (guardrail)");
    expect(sum.worst).toBe("skipped");
  });
  it("form round-trip keeps guard (default on, omitted; false preserved)", () => {
    const cfg = { name: "d", glob: "*.md", columns: ["todo", "done"], boards: {}, automations: [
      { name: "a", when: { moved_to: "done" }, run: "x" },
      { name: "b", when: { moved_to: "done" }, run: "y", guard: false },
    ] };
    const f = any.configToForm(cfg);
    expect(f.automations.map((r: any) => r.guard)).toEqual([true, false]);
    expect(any.formToPayload(f).config).toEqual({ ...cfg, tickets: { baseline: true, include: [], exclude: [] } });
    expect(any.newRule(f.columns).guard).toBe(true);
    f.automations[0].guard = false;
    expect(any.formToPayload(f).config.automations[0].guard).toBe(false);
    expect(any.dirtyTabs(f, cfg).automations).toBe(true);
  });
  it("runningText lists running rule names (no cap)", () => {
    const s = any.summarizeAutomations({ a: { status: "running" }, b: { status: "done" }, c: { status: "running" }, d: { status: "running" }, e: { status: "running" } });
    expect(any.runningText(s)).toBe("running: a, c, d, e");
    expect(s.worstFirst).toHaveLength(5);
    expect(any.runningText(any.summarizeAutomations({ a: { status: "done" } }))).toBe("");
  });
  it("issueSummary", () => {
    expect(any.issueSummary({ errors: [], warnings: [] }, [])).toEqual({ text: "No issues", level: "ok", count: 0 });
    expect(any.issueSummary({ errors: [{}, {}], warnings: [{}] }, [])).toEqual({ text: "2 errors, 1 warning", level: "error", count: 3 });
    expect(any.issueSummary({ errors: [], warnings: [{}] }, [{}])).toEqual({ text: "2 warnings", level: "warning", count: 2 });
    expect(any.issueSummary(null)).toMatchObject({ level: "ok" });
  });
  it("hasFixableIdIssues", () => {
    expect(any.hasFixableIdIssues({ errors: [{ message: "missing id" }], warnings: [] })).toBe(true);
    expect(any.hasFixableIdIssues({ errors: [{ message: "duplicate id 3 (a, b)" }], warnings: [] })).toBe(true);
    expect(any.hasFixableIdIssues({ errors: [{ message: "missing status" }], warnings: [] }, [{ kind: "unsorted" }])).toBe(false);
    expect(any.hasFixableIdIssues({ errors: [], warnings: [] }, [{ kind: "missing-id" }])).toBe(true);
  });
  it("nextTab", () => {
    const t = ["config", "automations", "live", "logs"];
    expect(any.nextTab(t, "config", "ArrowRight")).toBe("automations");
    expect(any.nextTab(t, "logs", "ArrowRight")).toBe("config");
    expect(any.nextTab(t, "config", "ArrowLeft")).toBe("logs");
    expect(any.nextTab(t, "automations", "Home")).toBe("config");
    expect(any.nextTab(t, "automations", "End")).toBe("logs");
    expect(any.nextTab(t, "automations", "x")).toBeNull();
    expect(any.nextTab([], "a", "End")).toBeNull();
  });
  it("errorTab groups automation errors; dirtyTabs splits changes", () => {
    expect(any.errorTab("Automations: An automation has no name.")).toBe("automations");
    expect(any.errorTab("Glob must not be empty.")).toBe("config");
    const cfg = { name: "d", glob: "*.md", columns: ["a", "b"], boards: { x: { columns: ["a"] } } };
    const f = any.configToForm(cfg);
    expect(any.dirtyTabs(f, cfg)).toEqual({ config: false, automations: false });
    f.boards[0].columns[0].value = "z";
    expect(any.dirtyTabs(f, cfg)).toEqual({ config: true, automations: false });
    f.automations.push(any.newRule(f.columns));
    expect(any.dirtyTabs(f, cfg).automations).toBe(true);
    f.automations[0].name = "r";
    f.automations[0].run = "echo";
    f.name = "d";
    expect(any.checkForm(f)).toBe("");
    f.automations[0].run = "";
    expect(any.checkForm(f)).toMatch(/^Automations: /);
  });
  it("automationLabel", () => {
    const i = any.summarizeAutomations({ "log-review": { status: "done", at: "2026-10-30T15:18:00", exit: 0 } }).list[0];
    expect(any.automationLabel(i, now)).toBe("log-review: done 2 min ago (exit 0)");
  });
});
