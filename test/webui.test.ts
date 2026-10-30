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
    expect(p.config).toEqual(cfg);
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
