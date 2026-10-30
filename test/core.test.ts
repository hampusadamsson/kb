import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";
import { beforeEach, describe, expect, it } from "vitest";
import { columnsFor, loadConfig, type Config } from "../src/config.js";
import { addComment, createFile, readFile, updateFile } from "../src/frontmatter.js";
import { boardNames, duplicates, findById, nextId, scan, sortTickets } from "../src/tickets.js";
import { filenameFor, parseProperty, slugify } from "../src/util.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-"));
});
const w = (name: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), text);
};
const tk = (id: unknown, extra = "") =>
  `---\ntype: ticket\n${id === undefined ? "" : `id: ${id}\n`}name: T${id}\nstatus: todo\n${extra}---\nbody\n`;
const cfg = (over: Partial<Config> = {}): Config => ({
  name: "default",
  columns: ["todo", "done"],
  glob: "*.md",
  ...over,
});

describe("config", () => {
  it("loads with defaults", () => {
    w("kanban.yaml", "columns: [a, b]\n");
    expect(loadConfig(dir)).toEqual({ name: "default", columns: ["a", "b"], glob: "*.md" });
  });
  it("errors when missing with hint", () => {
    expect(() => loadConfig(dir)).toThrow(/kb init/);
  });
  it("errors on bad schema and bad yaml", () => {
    w("kanban.yaml", "columns: []\n");
    expect(() => loadConfig(dir)).toThrow(/columns/);
    w("kanban.yaml", "columns: [a\n");
    expect(() => loadConfig(dir)).toThrow(/invalid YAML/);
  });
  it("columnsFor uses board override", () => {
    const c = cfg({ boards: { x: { columns: ["q"] } } });
    expect(columnsFor(c, "x")).toEqual(["q"]);
    expect(columnsFor(c, "other")).toEqual(["todo", "done"]);
  });
});

describe("scan", () => {
  it("keeps only tickets, collects parse errors", () => {
    w("1.md", tk(1));
    w("note.md", "---\ntype: note\n---\nhi\n");
    w("plain.md", "no frontmatter\n");
    w("bad.md", "---\ntype: ticket\nfoo: [\n---\n");
    const r = scan(dir, cfg());
    expect(r.tickets.map((t) => t.path)).toEqual(["1.md"]);
    expect(r.diagnostics.map((d) => d.path)).toEqual(["bad.md"]);
  });
  it("glob override and node_modules ignored", () => {
    w("sub/2.md", tk(2));
    w("node_modules/x/3.md", tk(3));
    expect(scan(dir, cfg()).tickets).toHaveLength(0);
    expect(scan(dir, cfg({ glob: "**/*.md" })).tickets.map((t) => t.path)).toEqual(["sub/2.md"]);
  });
  it("board default/override, unsorted, props", () => {
    w("a.md", tk(1, "board: b\nlabels: [x]\npriority: high\n"));
    w("b.md", "---\ntype: ticket\nid: 2\nstatus: nope\n---\n");
    w("c.md", "---\ntype: ticket\nid: 3\n---\n");
    const c = cfg({ boards: { b: { columns: ["todo"] }, z: { columns: ["q"] } } });
    const { tickets } = scan(dir, c);
    const [a, b, d] = tickets;
    expect(a.board).toBe("b");
    expect(a.column).toBe("todo");
    expect(a.labels).toEqual(["x"]);
    expect(a.props).toEqual({ priority: "high" });
    expect(b.board).toBe("default");
    expect(b.column).toBe("unsorted");
    expect(d.column).toBe("unsorted");
    expect(boardNames(tickets, c).sort()).toEqual(["b", "default", "z"]);
  });
  it("reads comments as string keys", () => {
    w("a.md", tk(1, 'comments:\n  2025-06-01T14:32: hi\n  "2025-06-01T14:32:05": yo\n'));
    expect(scan(dir, cfg()).tickets[0].comments).toEqual({
      "2025-06-01T14:32": "hi",
      "2025-06-01T14:32:05": "yo",
    });
  });
});

describe("ids", () => {
  const load = () => scan(dir, cfg()).tickets;
  it("findById matches strings; 12 vs '12' duplicate", () => {
    w("a.md", tk(12));
    w("b.md", tk('"12"'));
    w("c.md", tk("ABC-1"));
    const t = load();
    expect(findById(t, "ABC-1").path).toBe("c.md");
    expect(() => findById(t, "99")).toThrow("no ticket 99");
    expect(() => findById(t, "12")).toThrow(/a\.md[\s\S]*b\.md/);
    expect(duplicates(t)).toHaveLength(1);
  });
  it("nextId ignores non-integers", () => {
    expect(nextId([])).toBe(1);
    w("a.md", tk(3));
    w("b.md", tk("X-9"));
    w("c.md", tk(1.5));
    w("d.md", tk(undefined));
    expect(nextId(load())).toBe(4);
  });
  it("sorts ints first numerically, then strings", () => {
    w("a.md", tk(10));
    w("b.md", tk(2));
    w("c.md", tk("b"));
    w("d.md", tk("a"));
    expect(sortTickets(load()).map((t) => String(t.id))).toEqual(["2", "10", "a", "b"]);
  });
});

describe("frontmatter", () => {
  const src = "---\n# top comment\ntype: ticket\nzeta: 1 # inline\nid: 1\nname: X\nstatus: todo\n---\n\n  Body  \r\n\n# h\n";
  it("preserves comments, order, body bytes after set", () => {
    w("t.md", src);
    const f = path.join(dir, "t.md");
    updateFile(f, (d) => d.set("status", "done"));
    const out = fs.readFileSync(f, "utf8");
    expect(out).toBe(src.replace("status: todo", "status: done"));
    expect(readFile(f).body).toBe("\n  Body  \r\n\n# h\n");
  });
  it("delete and setIn work", () => {
    w("t.md", src);
    const f = path.join(dir, "t.md");
    updateFile(f, (d) => {
      d.delete("zeta");
      d.setIn(["labels"], ["a"]);
    });
    const out = fs.readFileSync(f, "utf8");
    expect(out).toContain("# top comment");
    expect(out).not.toContain("zeta");
    expect(out.endsWith("\n# h\n")).toBe(true);
  });
  it("createFile writes parseable ticket", () => {
    const f = path.join(dir, "n/new.md");
    createFile(f, { type: "ticket", id: 1, name: "N: x" }, "hello\n");
    expect(() => createFile(f, {}, "")).toThrow();
    const r = readFile(f);
    expect(r.doc.toJS()).toEqual({ type: "ticket", id: 1, name: "N: x" });
    expect(r.body).toBe("hello\n");
  });
  it("addComment keys and collision", () => {
    const doc = parseDocument("type: ticket\n");
    const now = new Date(2025, 5, 1, 14, 32, 5);
    expect(addComment(doc, "one", now)).toBe("2025-06-01T14:32");
    expect(addComment(doc, "two", now)).toBe("2025-06-01T14:32:05");
    expect(addComment(doc, "three", now)).toBe("2025-06-01T14:32:06");
    const back = parseDocument(doc.toString()).toJS();
    expect(back.comments).toEqual({
      "2025-06-01T14:32": "one",
      "2025-06-01T14:32:05": "two",
      "2025-06-01T14:32:06": "three",
    });
  });
  it("addComment handles tricky text", () => {
    const doc = parseDocument("type: ticket\n");
    addComment(doc, "a: b # c\nline2", new Date(2025, 0, 2, 3, 4));
    expect(parseDocument(doc.toString()).toJS().comments["2025-01-02T03:04"]).toBe("a: b # c\nline2");
  });
});

describe("util", () => {
  it("filenameFor pads and grows", () => {
    expect(filenameFor(1, "Fix login bug")).toBe("001-fix-login-bug.md");
    expect(filenameFor(1234, "x")).toBe("1234-x.md");
    expect(slugify("  Héllo, World!! ")).toBe("hello-world");
  });
  it("parseProperty", () => {
    expect(parseProperty("n:3")).toEqual(["n", 3]);
    expect(parseProperty("b:true")).toEqual(["b", true]);
    expect(parseProperty("p:high")).toEqual(["p", "high"]);
    expect(parseProperty("url:http://x")).toEqual(["url", "http://x"]);
    expect(parseProperty("e:")).toEqual(["e", ""]);
    expect(() => parseProperty("nocolon")).toThrow();
  });
});
