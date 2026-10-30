import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init } from "../src/cli/commands/init.js";
import { ls, lsJson, parseLimit } from "../src/cli/commands/ls.js";
import { boards } from "../src/cli/commands/boards.js";
import { show } from "../src/cli/commands/show.js";

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
        "  #1 Fix login   [bug] [ui] priority:high meta:{\"a\":1}",
        "  #4 Write docs",
        "  #? No id",
        "doing (1)",
        "  #2 Refactor",
        "done (0)",
        "unsorted (1)",
        "  #3 Odd",
      ].join("\n"),
    );
    expect(r.warnings.join("\n")).toMatch(/d\.md: unsorted \(unknown status "nope"\)/);
    expect(r.warnings.join("\n")).toMatch(/f\.md: ticket has no id/);
  });
  it("other board uses its columns; all boards listed", () => {
    setup();
    const r = ls(dir);
    expect(r.out).toContain("== other ==\nbacklog (0)\nactive (1)\n  #5 Other one");
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
      "s.md\n#7 Shown\nboard: default\nstatus: doing\nlabels: [bug]\npriority: low\n\nBody text\n\ncomments:\n2025-06-01T14:32  hi",
    );
  });
  it("errors on missing/duplicate", () => {
    setup();
    tk("g.md", "id: 1\nname: dup\nstatus: todo");
    expect(() => show(dir, "99")).toThrow(/no ticket 99/);
    expect(() => show(dir, "1")).toThrow(/duplicate id 1/);
  });
});

describe("string ids", () => {
  it("show/ls display as stored; 1 finds '001'; legacy int sorts numerically", () => {
    setup();
    tk("p.md", 'id: "001"\nname: Padded\nstatus: done');
    tk("q.md", 'id: "002"\nname: Two\nstatus: done');
    tk("r.md", "id: 10\nname: Ten\nstatus: done");
    tk("l.md", "id: 2.5\nname: Odd\nstatus: nope");
    expect(show(dir, "001")).toContain("#001 Padded");
    expect(show(dir, "10")).toContain("#10 Ten");
    expect(() => show(dir, "2")).not.toThrow();
    const out = ls(dir).out;
    expect(out).toContain("done (3)\n  #001 Padded\n  #002 Two\n  #10 Ten");
  });
  it("numeric fallback ambiguity and 001 finding int id", () => {
    setup();
    tk("p.md", 'id: "007"\nname: A\nstatus: done');
    tk("q.md", 'id: "07"\nname: B\nstatus: done');
    expect(() => show(dir, "7")).toThrow(/p\.md[\s\S]*q\.md/);
    expect(show(dir, "007")).toContain("#007 A");
    tk("a.md", "id: 11\nname: Hello\nstatus: doing");
    expect(show(dir, "011")).toContain("#11 Hello");
  });
  it("1 vs '001' is a duplicate in ls", () => {
    setup();
    tk("p.md", 'id: "001"\nname: P\nstatus: done');
    expect(ls(dir).warnings.join("\n")).toMatch(/duplicate id/);
  });
});

describe("cli e2e", () => {
  it("runs built cli", () => {
    execFileSync("npx", ["tsc"], { cwd: process.cwd() });
    const cli = path.resolve("dist/cli/main.js");
    const run = (...a: string[]) => spawnSync("node", [cli, ...a], { cwd: dir, encoding: "utf8" });
    expect(run("ls").status).toBe(1);
    expect(run("ls").stderr).toContain("kb init");
    expect(run("init").status).toBe(0);
    expect(run("init").status).toBe(1);
    tk("a.md", "id: 1\nname: Hello\nstatus: doing");
    expect(run("ls", "--format", "text").stdout).toContain("doing (1)\n  #1 Hello");
    const j = JSON.parse(run("ls").stdout);
    expect(j).toMatchObject({ total: 1, shown: 1, limit: 50, truncated: false });
    expect(j.tickets[0]).toMatchObject({ id: 1, name: "Hello", status: "doing", column: "doing", board: "default", path: "a.md" });
    expect(j.tickets[0].body).toBeUndefined();
    expect(run("ls", "--format", "xml").status).toBe(1);
    expect(run("ls", "--limit", "-1").status).toBe(1);
    expect(run("ls", "--help").stdout).toContain("--board");
    expect(run("show", "1").stdout).toContain("#1 Hello");
  });
});

describe("ls filters", () => {
  const tickets = (o: Parameters<typeof ls>[1]) => ls(dir, o).out.split("\n").filter((l) => l.startsWith("  #")).map((l) => l.trim().split(" ")[0]);
  beforeEach(() => {
    fs.writeFileSync(path.join(dir, "kanban.yaml"), CONFIG);
    tk("a.md", "id: 1\nname: Alpha\nstatus: todo\nlabels: [bug, ui]\npriority: high\nsize: 3\ntags: [x, y]", "Login broken");
    tk("b.md", "id: 2\nname: Beta\nstatus: doing\nlabels: [bug]\npriority: low");
    tk("c.md", "id: 3\nname: Gamma\nstatus: todo", "wip notes");
    tk("d.md", "id: 4\nname: Odd\nstatus: nope\nlabels: [ui]");
    tk("e.md", "id: 5\nname: Other\nstatus: active\nboard: other\nlabels: [bug]");
  });
  it("labels", () => {
    expect(tickets({ labels: ["bug"] })).toEqual(["#1", "#2", "#5"]);
    expect(tickets({ labels: ["bug", "ui"] })).toEqual(["#1"]);
    expect(tickets({ labels: ["!bug"] })).toEqual(["#3", "#4"]);
  });
  it("properties", () => {
    expect(tickets({ props: ["priority:high"] })).toEqual(["#1"]);
    expect(tickets({ props: ["size:3"] })).toEqual(["#1"]);
    expect(tickets({ props: ["tags:y"] })).toEqual(["#1"]);
    expect(tickets({ props: ["priority"] })).toEqual(["#1", "#2"]);
    expect(tickets({ props: ["!priority:low"] })).toEqual(["#1", "#3", "#4", "#5"]);
    expect(tickets({ props: ["!priority"] })).toEqual(["#3", "#4", "#5"]);
    expect(tickets({ props: ["status:todo"] })).toEqual(["#1", "#3"]);
  });
  it("text", () => {
    expect(tickets({ text: "ALPHA" })).toEqual(["#1"]);
    expect(tickets({ text: "login" })).toEqual(["#1"]);
    expect(tickets({ text: "priority: low" })).toEqual(["#2"]);
    expect(tickets({ text: "!wip" })).toEqual(["#1", "#2", "#4", "#5"]);
  });
  it("combined with board, omission, counts, warnings", () => {
    expect(tickets({ labels: ["bug"], board: "default", props: ["!priority:low"] })).toEqual(["#1"]);
    const r = ls(dir, { labels: ["bug"] });
    expect(r.out).toContain("todo (1)");
    expect(r.out).toContain("== other ==");
    const r2 = ls(dir, { props: ["priority"] });
    expect(r2.out).not.toContain("== other ==");
    expect(r2.warnings.join("\n")).toContain("d.md: unsorted");
    expect(r2.out).not.toContain("unsorted");
  });
  it("no match prints nothing; no filters unchanged", () => {
    expect(ls(dir, { text: "zzzz" }).out).toBe("");
    expect(ls(dir, {}).out).toBe(ls(dir).out);
    expect(ls(dir).out).toContain("== other ==");
  });
});

describe("ls json", () => {
  beforeEach(() => fs.writeFileSync(path.join(dir, "kanban.yaml"), CONFIG));
  const mk = (n: number) => {
    for (let i = 1; i <= n; i++) tk(`t${i}.md`, `id: ${i}\nname: T${i}\nstatus: todo\nlabels: [x]\npriority: p${i % 2}`, `body ${i}`);
  };

  it("is a flat list with metadata, no body by default", () => {
    mk(3);
    const r = lsJson(dir);
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({ total: 3, shown: 3, limit: 50, truncated: false });
    expect(j.tickets.map((t: any) => t.id)).toEqual([1, 2, 3]);
    expect(j.tickets[0]).toEqual({ id: 1, name: "T1", board: "default", status: "todo", column: "todo", labels: ["x"], props: { priority: "p1" }, path: "t1.md" });
    expect(r.warnings).toEqual([]);
  });

  it("--full adds body and comments", () => {
    mk(1);
    const t = JSON.parse(lsJson(dir, { full: true }).out).tickets[0];
    expect(t.body).toBe("body 1\n");
    expect(t.comments).toEqual({});
  });

  it("limits to 50 by default and warns", () => {
    mk(52);
    const r = lsJson(dir);
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({ total: 52, shown: 50, limit: 50, truncated: true });
    expect(j.tickets).toHaveLength(50);
    expect(r.warnings.join("\n")).toMatch(/showing 50 of 52 tickets \(limit 50\).*--limit/);
  });

  it("limit can be overridden; 0 = unlimited; exactly at the limit does not warn", () => {
    mk(52);
    expect(JSON.parse(lsJson(dir, { limit: 10 }).out).tickets).toHaveLength(10);
    expect(lsJson(dir, { limit: 10 }).warnings.join()).toMatch(/showing 10 of 52/);
    const all = lsJson(dir, { limit: 0 });
    expect(JSON.parse(all.out)).toMatchObject({ shown: 52, truncated: false });
    expect(all.warnings).toEqual([]);
    expect(lsJson(dir, { limit: 52 }).warnings).toEqual([]);
  });

  it("applies filters before the limit; includes unsorted and id-less tickets with null", () => {
    mk(3);
    tk("odd.md", "name: NoId\nstatus: nope");
    expect(JSON.parse(lsJson(dir, { labels: ["x"], limit: 2 }).out)).toMatchObject({ total: 3, shown: 2 });
    const odd = JSON.parse(lsJson(dir, { text: "NoId" }).out).tickets[0];
    expect(odd).toMatchObject({ id: null, column: "unsorted", status: "nope" });
  });

  it("empty result is valid JSON", () => {
    expect(JSON.parse(lsJson(dir, { text: "zzzz" }).out)).toEqual({ total: 0, shown: 0, limit: 50, truncated: false, tickets: [] });
  });

  it("parseLimit", () => {
    expect(parseLimit(undefined)).toBe(50);
    expect(parseLimit("0")).toBe(0);
    expect(parseLimit("7")).toBe(7);
    expect(() => parseLimit("x")).toThrow(/--limit/);
    expect(() => parseLimit("-1")).toThrow(/--limit/);
  });
});
