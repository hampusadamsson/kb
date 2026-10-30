import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { ls } from "../src/commands/ls.js";
import { add, comment, edit, mv, set, type Io } from "../src/commands/write.js";
import { splitFrontmatter } from "../src/frontmatter.js";

let dir: string;
let warns: string[];
let stdin = "";
let io: Io;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-"));
  fs.writeFileSync(
    path.join(dir, "kanban.yaml"),
    "columns: [todo, doing, done]\nglob: \"**/*.md\"\nboards:\n  other:\n    columns: [backlog, active]\n",
  );
  warns = [];
  stdin = "";
  io = { warn: (m) => warns.push(m), readStdin: () => stdin };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");
const fm = (f: string) => parse(splitFrontmatter(read(f)).yaml!) as Record<string, unknown>;

describe("add", () => {
  it("defaults", () => {
    expect(add(dir, "Fix login bug", {}, io)).toBe("#001 001-fix-login-bug.md");
    expect(read("001-fix-login-bug.md")).toBe(
      "---\ntype: ticket\nid: 1\nname: Fix login bug\nstatus: todo\n---\n",
    );
    expect(add(dir, undefined, { name: "Two" }, io)).toBe("#002 002-two.md");
  });
  it("name errors", () => {
    expect(() => add(dir, undefined, {}, io)).toThrow(/name required/);
    expect(() => add(dir, "a", { name: "b" }, io)).toThrow(/differing|different/);
    expect(() => add(dir, "a", { name: "a" }, io)).not.toThrow();
  });
  it("all flags", () => {
    stdin = "from stdin";
    add(dir, "Full", {
      status: "doing", label: ["bug", "ui"], property: ["n:3", "ok:true", "t:hello"],
      body: "-", comment: "first", file: "sub/dir/x.md", id: "ABC-1", board: "other",
    }, io);
    const d = fm("sub/dir/x.md");
    expect(Object.keys(d)).toEqual(["type", "id", "name", "status", "board", "labels", "n", "ok", "t", "comments"]);
    expect(d).toMatchObject({ id: "ABC-1", board: "other", labels: ["bug", "ui"], n: 3, ok: true, t: "hello" });
    expect(Object.values(d.comments as object)).toEqual(["first"]);
    expect(splitFrontmatter(read("sub/dir/x.md")).body).toBe("from stdin\n");
    expect(warns[0]).toMatch(/unsorted/);
  });
  it("board default not written; numeric id stored as number", () => {
    add(dir, "A", { board: "default", id: "7" }, io);
    const d = fm("007-a.md");
    expect(d.board).toBeUndefined();
    expect(d.id).toBe(7);
    expect(add(dir, "B", {}, io)).toMatch(/^#008 /);
  });
  it("leading-zero id stays a string", () => {
    expect(add(dir, "A", { id: "007" }, io)).toBe("#007 007-a.md");
    expect(fm("007-a.md").id).toBe("007");
    add(dir, "B", { id: "0" }, io);
    expect(fm("000-b.md").id).toBe(0);
  });
  it("long comment is not folded; CRLF preserved on mv", () => {
    const long = "word ".repeat(40).trim();
    add(dir, "A", { comment: long }, io);
    expect(read("001-a.md").split("\n").some((l) => l.includes(long))).toBe(true);
    fs.writeFileSync(
      path.join(dir, "c.md"),
      "---\r\ntype: ticket\r\nid: 9\r\nname: C\r\nstatus: todo\r\n---\r\nbody\r\nmore\r\n",
    );
    mv(dir, "9", "done", io);
    const t = read("c.md");
    const fmText = t.slice(0, t.indexOf("---\r\nbody") + 5);
    expect(fmText.replace(/\r\n/g, "")).not.toContain("\n");
    expect(t).toContain("status: done\r\n");
    expect(t.endsWith("body\r\nmore\r\n")).toBe(true);
  });
  it("string id filename, dup id, reserved prop", () => {
    expect(add(dir, "A", { id: "ABC-1" }, io)).toBe("#ABC-1 abc-1-a.md");
    expect(() => add(dir, "B", { id: "ABC-1" }, io)).toThrow(/already in use/);
    expect(() => add(dir, "B", { property: ["id:3"] }, io)).toThrow(/reserved/);
    expect(() => add(dir, "B", { property: ["type:x"] }, io)).toThrow(/reserved/);
  });
  it("shows in ls", () => {
    add(dir, "Visible", {}, io);
    expect(ls(dir, { color: false }).out).toContain("Visible");
  });
});

describe("set", () => {
  const seed = () =>
    fs.writeFileSync(
      path.join(dir, "a.md"),
      "---\ntype: ticket\nid: 1\nname: Orig   # keep\nstatus: todo\nlabels: [bug, ui]\nprio:   high\n---\n\nBody here\n",
    );
  it("labels, props, unset, name; preserves formatting and body", () => {
    seed();
    expect(set(dir, "1", { label: ["bug", "new"], unlabel: ["ui"], property: ["prio:low", "x:1"], name: "New" }, io)).toBe("#001 updated");
    const text = read("a.md");
    expect(text).toContain("# keep");
    expect(text.endsWith("---\n\nBody here\n")).toBe(true);
    expect(fm("a.md")).toMatchObject({ name: "New", labels: ["bug", "new"], prio: "low", x: 1 });
    expect(fs.existsSync(path.join(dir, "a.md"))).toBe(true);
    set(dir, "1", { unset: ["prio"], unlabel: ["bug", "new"] }, io);
    const d = fm("a.md");
    expect(d.prio).toBeUndefined();
    expect(d.labels).toBeUndefined();
    set(dir, "1", { label: ["z"] }, io);
    expect(fm("a.md").labels).toEqual(["z"]);
  });
  it("body replace, comment, board", () => {
    seed();
    stdin = "new body";
    set(dir, "1", { body: "-", comment: "hi", board: "other" }, io);
    expect(splitFrontmatter(read("a.md")).body).toBe("new body\n");
    expect(fm("a.md").board).toBe("other");
    expect(warns[0]).toMatch(/unsorted/);
    set(dir, "1", { board: "default" }, io);
    expect(fm("a.md").board).toBeUndefined();
    expect(Object.values(fm("a.md").comments as object)).toEqual(["hi"]);
  });
  it("refusals", () => {
    seed();
    expect(() => set(dir, "1", {}, io)).toThrow(/no changes/);
    expect(() => set(dir, "1", { unset: ["id"] }, io)).toThrow();
    expect(() => set(dir, "1", { unset: ["type"] }, io)).toThrow();
    expect(() => set(dir, "1", { property: ["id:2"] }, io)).toThrow(/reserved/);
    expect(() => set(dir, "1", { property: ["type:x"] }, io)).toThrow(/reserved/);
    expect(() => set(dir, "9", { name: "x" }, io)).toThrow(/no ticket/);
  });
  it("mv", () => {
    seed();
    expect(mv(dir, "1", "done", io)).toBe("#001 updated");
    expect(fm("a.md").status).toBe("done");
    expect(warns).toEqual([]);
    mv(dir, "1", "nope", io);
    expect(warns[0]).toMatch(/not a column/);
    expect(ls(dir, { color: false }).out).toContain("unsorted");
  });
});

describe("comment & edit", () => {
  it("comment key format and collision", () => {
    add(dir, "A", {}, io);
    const now = new Date(2024, 0, 2, 3, 4, 5);
    expect(comment(dir, "1", "one", now)).toBe("2024-01-02T03:04");
    expect(comment(dir, "1", "two", now)).toBe("2024-01-02T03:04:05");
    expect(Object.values(fm("001-a.md").comments as object)).toEqual(["one", "two"]);
  });
  it("edit uses EDITOR", () => {
    add(dir, "A", {}, io);
    const script = path.join(dir, "ed.sh");
    fs.writeFileSync(script, '#!/bin/sh\necho edited >> "$1"\n', { mode: 0o755 });
    const old = { v: process.env.VISUAL, e: process.env.EDITOR };
    process.env.VISUAL = "false"; // must be ignored
    process.env.EDITOR = script;
    try {
      edit(dir, "1");
      expect(read("001-a.md")).toContain("edited");
      add(dir, "B", { edit: true }, io);
      expect(read("002-b.md")).toContain("edited");
    } finally {
      if (old.v !== undefined) process.env.VISUAL = old.v;
      if (old.e !== undefined) process.env.EDITOR = old.e; else delete process.env.EDITOR;
    }
  });
});
