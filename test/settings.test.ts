import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createKanban, KanbanError, type Kanban } from "../src/index.js";

let dir: string;
let kb: Kanban;
const YAML = `# my board
name: default   # the main board
columns: [todo, doing, done]
glob: "*.md"
boards:
  other:
    columns: [backlog, active]
`;
const ticket = (id: string, status: string, extra = "") =>
  `---\ntype: ticket\nid: "${id}"\nname: T${id}\nstatus: ${status}\n${extra}---\nbody\n`;
const write = (f: string, s: string) => fs.writeFileSync(path.join(dir, f), s);
const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");
const cfg = () => kb.getConfig().config;
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof KanbanError ? e.code : "other";
  }
};
const msg = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-set-"));
  write("kanban.yaml", YAML);
  write("1.md", ticket("001", "todo"));
  write("2.md", ticket("002", "doing"));
  write("3.md", ticket("003", "backlog", "board: other\n"));
  kb = createKanban({ dir });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("getConfig / updateConfig", () => {
  it("reads an editable snapshot with defaults", () => {
    const s = kb.getConfig();
    expect(s.config).toEqual({
      name: "default",
      glob: "*.md",
      columns: ["todo", "doing", "done"],
      boards: { other: { columns: ["backlog", "active"] } },
    });
    expect(typeof s.mtime).toBe("number");
  });

  it("no-op update changes nothing on disk", () => {
    const r = kb.updateConfig(cfg());
    expect(r).toMatchObject({ changes: [], configChanged: false });
    expect(read("kanban.yaml")).toBe(YAML);
  });

  it("adds, reorders and keeps YAML comments", () => {
    kb.updateConfig({ ...cfg(), columns: ["todo", "review", "doing", "done"], glob: "**/*.md" });
    const y = read("kanban.yaml");
    expect(y).toContain("# my board");
    expect(y).toContain("# the main board");
    expect(cfg().columns).toEqual(["todo", "review", "doing", "done"]);
    expect(cfg().glob).toBe("**/*.md");
    expect(y).toContain("columns: [todo, review, doing, done]"); // no padding added inside [ ]
  });

  it("renames a column and migrates tickets (not other boards' tickets)", () => {
    const next = { ...cfg(), columns: ["todo", "wip", "done"] };
    const dry = kb.updateConfig(next, { renames: { columns: { "": { doing: "wip" } } }, dryRun: true });
    expect(dry.changes).toEqual([{ path: "2.md", id: "002", field: "status", from: "doing", to: "wip" }]);
    expect(read("2.md")).toContain("status: doing");
    kb.updateConfig(next, { renames: { columns: { "": { doing: "wip" } } } });
    expect(read("2.md")).toContain("status: wip");
    expect(read("3.md")).toContain("status: backlog");
    expect(kb.get("2").column).toBe("wip");
  });

  it("renaming a board-override column only touches that board", () => {
    write("4.md", ticket("004", "active", "board: other\n"));
    write("8.md", ticket("008", "active")); // default board: "active" is not its column, unsorted
    const next = { ...cfg(), boards: { other: { columns: ["backlog", "review"] } } };
    kb.updateConfig(next, { renames: { columns: { other: { active: "review" } } } });
    expect(read("4.md")).toContain("status: review");
    expect(read("8.md")).toContain("status: active");
    expect(read("2.md")).toContain("status: doing");
  });

  it("blocks removing a column that tickets use, listing them", () => {
    const next = { ...cfg(), columns: ["todo", "done"] };
    expect(code(() => kb.updateConfig(next))).toBe("invalid");
    expect(msg(() => kb.updateConfig(next))).toContain("2.md");
    expect(read("kanban.yaml")).toBe(YAML);
  });

  it("allows removing an unused column", () => {
    kb.updateConfig({ ...cfg(), columns: ["todo", "doing"] });
    expect(cfg().columns).toEqual(["todo", "doing"]);
  });

  it("unsorted tickets never block", () => {
    write("5.md", ticket("005", "nonsense"));
    kb.updateConfig({ ...cfg(), columns: ["todo", "doing"] });
    expect(cfg().columns).toEqual(["todo", "doing"]);
  });

  it("renames the default board: tickets with board: <old> are migrated", () => {
    write("6.md", ticket("006", "todo", "board: default\n"));
    kb.updateConfig({ ...cfg(), name: "main" });
    expect(cfg().name).toBe("main");
    expect(read("6.md")).not.toContain("board:"); // now on the default board -> key removed
    expect(read("1.md")).not.toContain("board:");
    expect(read("kanban.yaml")).toContain("# the main board");
  });

  it("renames a board override: key and tickets follow", () => {
    kb.updateConfig(
      { ...cfg(), boards: { ops: { columns: ["backlog", "active"] } } },
      { renames: { boards: { other: "ops" } } },
    );
    expect(Object.keys(cfg().boards)).toEqual(["ops"]);
    expect(read("3.md")).toContain("board: ops");
    expect(kb.get("3").column).toBe("backlog");
  });

  it("refuses a board rename onto an existing board", () => {
    write("7.md", ticket("007", "todo", "board: ops\n"));
    const next = { ...cfg(), boards: { ops: { columns: ["backlog", "active"] } } };
    expect(code(() => kb.updateConfig(next, { renames: { boards: { other: "ops" } } }))).toBe("invalid");
  });

  it("removing a board override is allowed and falls back to default columns", () => {
    kb.updateConfig({ ...cfg(), boards: {} });
    expect(cfg().boards).toEqual({});
    expect(read("kanban.yaml")).not.toContain("boards:");
    expect(kb.get("3").column).toBe("unsorted");
  });

  it("adds a board override", () => {
    kb.updateConfig({ ...cfg(), boards: { ...cfg().boards, extra: { columns: ["a", "b"] } } });
    expect(cfg().boards.extra.columns).toEqual(["a", "b"]);
  });

  it("validates input and writes nothing when invalid", () => {
    for (const bad of [
      { ...cfg(), columns: [] },
      { ...cfg(), columns: ["a", "a"] },
      { ...cfg(), columns: ["a", " "] },
      { ...cfg(), glob: "" },
      { ...cfg(), name: " " },
      { ...cfg(), boards: { x: { columns: [] } } },
      "nope",
    ]) {
      expect(code(() => kb.updateConfig(bad))).toBe("invalid");
    }
    expect(read("kanban.yaml")).toBe(YAML);
  });

  it("detects a stale mtime", () => {
    const { mtime } = kb.getConfig();
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dir, "kanban.yaml"), t, t);
    expect(code(() => kb.updateConfig(cfg(), { mtime }))).toBe("stale");
    expect(code(() => kb.updateConfig(cfg(), { mtime: kb.getConfig().mtime }))).toBeUndefined();
  });

  it("migration preserves ticket formatting and body", () => {
    write("2.md", `---\ntype: ticket\nid: "002"\nname: T2   # keep\nstatus: doing\n---\nbody text\n`);
    kb.updateConfig({ ...cfg(), columns: ["todo", "wip", "done"] }, { renames: { columns: { "": { doing: "wip" } } } });
    expect(read("2.md")).toBe(`---\ntype: ticket\nid: "002"\nname: T2 # keep\nstatus: wip\n---\nbody text\n`);
  });

  it("config errors map to code config when kanban.yaml is missing", () => {
    fs.rmSync(path.join(dir, "kanban.yaml"));
    expect(code(() => kb.getConfig())).toBe("config");
  });
});
