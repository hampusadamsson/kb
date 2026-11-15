import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createKanban, idFromFilename, loadConfig } from "../src/core/index.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-tid-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const cfg = (mode?: string, glob = "**/*.md") =>
  fs.writeFileSync(
    path.join(dir, "kanban.yaml"),
    `name: default\ncolumns: [todo, doing]\nglob: "${glob}"\n${mode === undefined ? "" : `ticketId: ${mode}\n`}`,
  );

function put(rel: string, extra = "name: T\nstatus: todo\n", body = "") {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `---\ntype: ticket\n${extra}---\n${body}`);
}

const ids = () =>
  createKanban({ dir })
    .load()
    .tickets.map((t) => String(t.id))
    .sort();

describe("ticketId config", () => {
  it("defaults to props", () => {
    cfg();
    expect(loadConfig(dir).ticketId).toBe("props");
  });
  it("rejects anything else", () => {
    cfg("name");
    expect(() => loadConfig(dir)).toThrow(/ticketId/);
  });
  it("idFromFilename strips the extension and keeps the stem", () => {
    expect(idFromFilename("001-fix-login.md")).toBe("001-fix-login");
    expect(idFromFilename("notes/ABC-1.md")).toBe("ABC-1");
  });
});

describe("ticketId: props (default)", () => {
  it("id comes from the frontmatter, filename is irrelevant", () => {
    cfg();
    put("whatever_name.md", 'id: "007"\nname: T\nstatus: todo\n');
    expect(ids()).toEqual(["007"]);
  });
  it("missing id stays missing (kb fix repairs it)", () => {
    cfg();
    put("007-x.md");
    expect(ids()).toEqual(["undefined"]);
    const changes = createKanban({ dir }).fix({ dryRun: true });
    expect(changes).toHaveLength(1);
  });
});

describe("ticketId: filename", () => {
  it("id is the file name; frontmatter id is ignored", () => {
    cfg("filename");
    put("007-x.md", 'id: "999"\nname: T\nstatus: todo\n');
    expect(ids()).toEqual(["007-x"]);
  });
  it("a missing frontmatter id is not a problem", () => {
    cfg("filename");
    put("a.md");
    const r = createKanban({ dir }).validate();
    expect(r.errors).toEqual([]);
  });
  it("a disagreeing frontmatter id is a warning, not an error (filename wins)", () => {
    cfg("filename");
    put("a.md", 'id: "999"\nname: T\nstatus: todo\n');
    const r = createKanban({ dir }).validate();
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => w.message).join()).toMatch(/frontmatter id .* is ignored/);
  });
  it("duplicate file names in different directories are invalid", () => {
    cfg("filename");
    put("a/001.md");
    put("b/001.md");
    const r = createKanban({ dir }).validate();
    expect(r.errors.map((e) => e.message).join()).toMatch(/duplicate id 001/);
    expect(() => createKanban({ dir }).get("001")).toThrow(/duplicate id/);
  });
  it("kb fix never renames, so it reports no changes", () => {
    cfg("filename");
    put("a/001.md");
    put("b/001.md");
    expect(createKanban({ dir }).fix({ dryRun: true })).toEqual([]);
    expect(createKanban({ dir }).fix()).toEqual([]);
  });
  it("lookup is by file name", () => {
    cfg("filename");
    put("fix-login.md");
    expect(createKanban({ dir }).get("fix-login").path).toBe("fix-login.md");
    expect(() => createKanban({ dir }).get("001")).toThrow(/no ticket/);
  });
});

describe("add with ticketId: filename", () => {
  it("names the file after the id and writes no frontmatter id", () => {
    cfg("filename");
    const kb = createKanban({ dir });
    const r = kb.add({ name: "Fix login" });
    expect(r).toMatchObject({ id: "fix-login", path: "fix-login.md" });
    expect(fs.readFileSync(path.join(dir, "fix-login.md"), "utf8")).not.toMatch(/^id:/m);
  });
  it("--id seeds the file name and is the id", () => {
    cfg("filename");
    const r = createKanban({ dir }).add({ name: "Another", id: "ABC-1" });
    expect(r).toMatchObject({ id: "ABC-1", path: "ABC-1.md" });
  });
  it("--file decides the id", () => {
    cfg("filename");
    const r = createKanban({ dir }).add({ name: "Nested", file: "notes/thing.md" });
    expect(r).toMatchObject({ id: "thing", path: "notes/thing.md" });
  });
  it("rejects an --id that disagrees with --file", () => {
    cfg("filename");
    expect(() => createKanban({ dir }).add({ name: "X", file: "notes/thing.md", id: "other" })).toThrow(/does not match file name/);
  });
  it("rejects an id that is already in use, including in another directory", () => {
    cfg("filename");
    put("001-a.md");
    expect(() => createKanban({ dir }).add({ name: "B", id: "001-a" })).toThrow(/already in use/);
  });
  it("rejects an id containing a path separator", () => {
    cfg("filename");
    expect(() => createKanban({ dir }).add({ name: "X", id: "a/b" })).toThrow(/plain file name/);
  });
});
