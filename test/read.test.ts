import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init } from "../src/commands/init.js";
import { ls } from "../src/commands/ls.js";
import { boards } from "../src/commands/boards.js";
import { show } from "../src/commands/show.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const CONFIG = `columns: [todo, doing, done]
boards:
  other:
    columns: [backlog, active]
`;
function tk(file: string, fm: string, body = "") {
  fs.writeFileSync(path.join(dir, file), `---\ntype: ticket\n${fm}\n---\n${body}\n`);
}
function setup() {
  fs.writeFileSync(path.join(dir, "kanban.yaml"), CONFIG);
  tk("a.md", "id: 4\nname: Write docs\nstatus: todo");
  tk("b.md", "id: 1\nname: Fix login\nstatus: todo\nlabels: [bug, ui]\npriority: high\nmeta: {a: 1}");
  tk("c.md", "id: 2\nname: Refactor\nstatus: doing");
  tk("d.md", "id: 3\nname: Odd\nstatus: nope");
  tk("e.md", "id: 5\nname: Other one\nstatus: active\nboard: other");
  tk("f.md", "name: No id\nstatus: todo");
}

describe("init", () => {
  it("creates and refuses", () => {
    init(dir);
    expect(fs.readFileSync(path.join(dir, "kanban.yaml"), "utf8")).toContain("columns:");
    expect(() => init(dir)).toThrow(/already exists/);
  });
});

describe("ls", () => {
  it("groups, orders, sorts, renders", () => {
    setup();
    const r = ls(dir, { board: "default" });
    expect(r.out).toBe(
      [
        "== default ==",
        "todo (3)",
        "  #001 Fix login   [bug] [ui] priority:high meta:{\"a\":1}",
        "  #004 Write docs",
        "  #? No id",
        "doing (1)",
        "  #002 Refactor",
        "done (0)",
        "unsorted (1)",
        "  #003 Odd",
      ].join("\n"),
    );
    expect(r.warnings.join("\n")).toMatch(/d\.md: unsorted \(unknown status "nope"\)/);
    expect(r.warnings.join("\n")).toMatch(/f\.md: ticket has no id/);
  });
  it("other board uses its columns; all boards listed", () => {
    setup();
    const r = ls(dir);
    expect(r.out).toContain("== other ==\nbacklog (0)\nactive (1)\n  #005 Other one");
    expect(r.out.indexOf("== default ==")).toBeLessThan(r.out.indexOf("== other =="));
    expect(ls(dir, { board: "other" }).out).not.toContain("default");
  });
  it("unknown board errors; missing status warns; duplicates warn", () => {
    setup();
    tk("g.md", "id: 1\nname: dup\nstatus: todo");
    tk("h.md", "id: 9\nname: nostatus");
    expect(() => ls(dir, { board: "zzz" })).toThrow(/unknown board/);
    const w = ls(dir).warnings.join("\n");
    expect(w).toMatch(/duplicate id 1: .*b\.md.*g\.md|duplicate id 1: .*g\.md.*b\.md/);
    expect(w).toMatch(/h\.md: unsorted \(missing status\)/);
  });
  it("no unsorted header when empty; color only when asked", () => {
    fs.writeFileSync(path.join(dir, "kanban.yaml"), CONFIG);
    tk("a.md", "id: 1\nname: x\nstatus: todo");
    expect(ls(dir).out).not.toContain("unsorted");
    expect(ls(dir).out).not.toContain("\x1b");
    expect(ls(dir, { color: true }).out).toContain("\x1b[1m");
  });
  it("errors without config", () => {
    expect(() => ls(dir)).toThrow(/kb init/);
  });
});

describe("boards", () => {
  it("lists", () => {
    setup();
    tk("z.md", "id: 8\nname: z\nstatus: x\nboard: zed");
    expect(boards(dir).split("\n")).toEqual(["default", "other", "zed"]);
  });
});

describe("show", () => {
  it("prints everything", () => {
    setup();
    tk("s.md", "id: 7\nname: Shown\nstatus: doing\nlabels: [bug]\npriority: low\ncomments:\n  2025-06-01T14:32: hi", "Body text");
    const o = show(dir, "7");
    expect(o).toBe(
      "s.md\n#007 Shown\nboard: default\nstatus: doing\nlabels: [bug]\npriority: low\n\nBody text\n\ncomments:\n2025-06-01T14:32  hi",
    );
  });
  it("errors on missing/duplicate", () => {
    setup();
    tk("g.md", "id: 1\nname: dup\nstatus: todo");
    expect(() => show(dir, "99")).toThrow(/no ticket 99/);
    expect(() => show(dir, "1")).toThrow(/duplicate id 1/);
  });
});

describe("cli e2e", () => {
  it("runs built cli", () => {
    execFileSync("npx", ["tsc"], { cwd: process.cwd() });
    const cli = path.resolve("dist/cli.js");
    const run = (...a: string[]) => spawnSync("node", [cli, ...a], { cwd: dir, encoding: "utf8" });
    expect(run("ls").status).toBe(1);
    expect(run("ls").stderr).toContain("kb init");
    expect(run("init").status).toBe(0);
    expect(run("init").status).toBe(1);
    tk("a.md", "id: 1\nname: Hello\nstatus: doing");
    expect(run("ls").stdout).toContain("doing (1)\n  #001 Hello");
    expect(run("ls", "--help").stdout).toContain("--board");
    expect(run("show", "1").stdout).toContain("#001 Hello");
  });
});
