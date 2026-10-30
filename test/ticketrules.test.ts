import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  createKanban,
  isTicketFile,
  loadConfig,
  scan,
  scanGlobs,
  type KbEvent,
  type TicketRulesInput,
} from "../src/core/index.js";
import { handleApi } from "../src/web/api.js";

const T = { type: "ticket" };
const is = (rules: TicketRulesInput, rel: string, data?: Record<string, unknown>, top?: string) =>
  isTicketFile(rules, rel, data, top);

describe("isTicketFile", () => {
  it("baseline", () => {
    expect(is({}, "a.md", T)).toBe(true);
    expect(is({}, "a.md", { type: "note" })).toBe(false);
    expect(is({}, "a.md", undefined)).toBe(false);
    expect(is({}, "sub/a.md", T, "*.md")).toBe(false);
    expect(is({ baseline: false }, "a.md", T)).toBe(false);
  });
  it("never node_modules/.kb/non-md includes", () => {
    expect(is({}, "node_modules/a.md", T)).toBe(false);
    expect(is({}, ".kb/a.md", T)).toBe(false);
    expect(is({ include: [{ prefix: "a" }] }, "a.txt", {})).toBe(false);
  });
  it("glob / prefix", () => {
    const r = { include: [{ glob: "tasks/**/*.md" }] };
    expect(is(r, "tasks/x/a.md", {}, "*.md")).toBe(true);
    expect(is(r, "other/a.md", {}, "*.md")).toBe(false);
    const p = { include: [{ prefix: "T-" }] };
    expect(is(p, "d/T-1.md", {}, "**/*.md")).toBe(true);
    expect(is(p, "T-d/1.md", {}, "**/*.md")).toBe(false);
    expect(is(p, "d/T-1.md", {}, "*.md")).toBe(false); // outside top glob, no own glob
  });
  it("props equals, negation, list", () => {
    const r = { include: [{ props: { kind: "task" } }] };
    expect(is(r, "a.md", { kind: "task" })).toBe(true);
    expect(is(r, "a.md", { kind: ["x", "task"] })).toBe(true);
    expect(is(r, "a.md", { kind: "other" })).toBe(false);
    expect(is(r, "a.md", {})).toBe(false);
    expect(is({ include: [{ props: { n: 3 } }] }, "a.md", { n: 3 })).toBe(true);
    const neg = { include: [{ props: { kind: "!task" } }] };
    expect(is(neg, "a.md", { kind: "x" })).toBe(true);
    expect(is(neg, "a.md", {})).toBe(true);
    expect(is(neg, "a.md", { kind: "task" })).toBe(false);
  });
  it("has / !has", () => {
    const r = { include: [{ has: ["status"] }] };
    expect(is(r, "a.md", { status: "todo" })).toBe(true);
    expect(is(r, "a.md", {})).toBe(false);
    const n = { include: [{ has: ["!draft"] }] };
    expect(is(n, "a.md", {})).toBe(true);
    expect(is(n, "a.md", { draft: true })).toBe(false);
  });
  it("AND within a rule, OR across rules", () => {
    const and = { include: [{ prefix: "T-", props: { kind: "task" } }] };
    expect(is(and, "T-1.md", { kind: "task" })).toBe(true);
    expect(is(and, "T-1.md", { kind: "x" })).toBe(false);
    expect(is(and, "1.md", { kind: "task" })).toBe(false);
    const or = { include: [{ prefix: "T-" }, { props: { kind: "task" } }] };
    expect(is(or, "T-1.md", {})).toBe(true);
    expect(is(or, "1.md", { kind: "task" })).toBe(true);
    expect(is(or, "1.md", {})).toBe(false);
  });
  it("exclude beats include and baseline", () => {
    expect(is({ exclude: [{ prefix: "_" }] }, "_a.md", T)).toBe(false);
    expect(is({ exclude: [{ props: { type: "ticket" } }] }, "a.md", T)).toBe(false);
    expect(is({ include: [{ glob: "**/*.md" }], exclude: [{ glob: "templates/**" }] }, "templates/a.md", {})).toBe(false);
  });
  it("baseline:false", () => {
    expect(is({ baseline: false, include: [{ prefix: "T-" }] }, "T-1.md", T)).toBe(true);
    expect(is({ baseline: false, include: [{ prefix: "T-" }] }, "1.md", T)).toBe(false);
  });
  it("scanGlobs", () => {
    expect(scanGlobs({ glob: "*.md", tickets: { baseline: true, exclude: [], include: [{ glob: "t/**" }, { prefix: "x" }] } })).toEqual(["*.md", "t/**"]);
  });
});

let dir: string;
const write = (f: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
  fs.writeFileSync(path.join(dir, f), s);
};
const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");
const tk = (id: string, extra = "") => `---\ntype: ticket\nid: "${id}"\nname: N${id}\nstatus: todo\n${extra}---\nbody\n`;
const cfg = (tickets = "") => write("kanban.yaml", `# keep me\ncolumns: [todo, doing, done]\nglob: "*.md"\n${tickets}`);
const paths = () => scan(dir, loadConfig(dir)).tickets.map((t) => t.path);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-rules-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("scan with rules", () => {
  beforeEach(() => {
    cfg(`tickets:
  include:
    - name: tasks
      glob: "tasks/**/*.md"
  exclude:
    - prefix: "_"
    - props: { type: daily }
`);
    write("1.md", tk("001"));
    write("_draft.md", tk("002"));
    write("daily.md", "---\ntype: daily\n---\n");
    write("tasks/a/plain.md", "---\nstatus: doing\n---\nhello\n");
    write("tasks/nofm.md", "just text\n");
    write("tasks/note.txt", "x");
    write("tasks/node_modules/x.md", tk("9"));
  });

  it("classifies", () => {
    expect(paths()).toEqual(["1.md", "tasks/a/plain.md", "tasks/nofm.md"]);
  });

  it("name falls back to filename; missing id/status warn", () => {
    const kb = createKanban({ dir });
    const r = kb.load();
    expect(r.tickets.find((t) => t.path === "tasks/nofm.md")!.name).toBe("nofm");
    expect(r.tickets.find((t) => t.path === "tasks/a/plain.md")!.name).toBe("plain");
    expect(r.warnings.some((w) => w.kind === "unsorted" && w.path === "tasks/nofm.md")).toBe(true);
    expect(r.warnings.some((w) => w.kind === "missing-id" && w.path === "tasks/nofm.md")).toBe(true);
  });

  it("fix + mv on a file without frontmatter creates frontmatter and keeps the body", () => {
    const kb = createKanban({ dir });
    kb.fix();
    const t = kb.load().tickets.find((x) => x.path === "tasks/nofm.md")!;
    expect(t.id).toBeDefined();
    kb.update(String(t.id), { status: "doing" });
    const raw = read("tasks/nofm.md");
    expect(raw).toMatch(/^---\n[\s\S]*status: doing[\s\S]*---\njust text\n$/);
    expect(raw).not.toContain("type:");
    expect(kb.get(String(t.id)).column).toBe("doing");
  });
});

describe("invalid yaml", () => {
  it("reports only decidable cases", () => {
    cfg(`tickets:
  include:
    - { glob: "inc/*.md" }
    - { props: { kind: task } }
  exclude:
    - { prefix: "_" }
`);
    write("inc/bad.md", "---\na: [\n---\n");
    write("props.md", "---\nkind: task\na: [\n---\n");
    write("_x.md", "---\ntype: ticket\na: [\n---\n");
    write("decl.md", "---\ntype: ticket\na: [\n---\n");
    write("note.md", "---\na: [\n---\n");
    const d = createKanban({ dir }).load().diagnostics.map((x) => x.path).sort();
    expect(d).toEqual(["decl.md", "inc/bad.md"]);
  });
});

describe("schema", () => {
  const bad = (tickets: unknown, re: RegExp) => {
    cfg();
    expect(() => createKanban({ dir }).updateConfig({ ...createKanban({ dir }).getConfig().config, tickets })).toThrow(re);
  };
  it("rejects bad rules", () => {
    bad({ include: [{ name: "e" }] }, /include\[0\] "e".*at least one condition/);
    bad({ include: [{ glob: "/abs/*.md" }] }, /relative/);
    bad({ exclude: [{ glob: "../x/*.md" }] }, /\.\./);
    bad({ include: [{ prefix: "a/b" }] }, /slash/);
    bad({ baseline: "no" }, /baseline/);
  });
  it("loadConfig rejects too", () => {
    cfg("tickets:\n  include:\n    - {}\n");
    expect(() => loadConfig(dir)).toThrow(/condition/);
  });
});

describe("settings", () => {
  it("round-trips, keeps comments, removes default", () => {
    cfg();
    const kb = createKanban({ dir });
    const c = kb.getConfig().config;
    expect(c.tickets).toBeUndefined();
    const tickets = { baseline: true, include: [{ name: "t", glob: "tasks/*.md", props: { kind: "task" } }], exclude: [{ prefix: "_" }] };
    kb.updateConfig({ ...c, tickets });
    expect(read("kanban.yaml")).toContain("# keep me");
    const snap = kb.getConfig().config;
    expect(snap.tickets).toEqual(tickets);
    kb.updateConfig({ ...snap, tickets: { baseline: true, include: [], exclude: [] } });
    expect(read("kanban.yaml")).not.toContain("tickets");
    expect(read("kanban.yaml")).toContain("# keep me");
    expect(kb.getConfig().config.tickets).toBeUndefined();
  });
  it("omitted tickets keeps current rules; dryRun parity", () => {
    cfg("tickets:\n  exclude:\n    - prefix: _\n");
    write("1.md", tk("1"));
    write("_2.md", tk("2"));
    const kb = createKanban({ dir });
    const { tickets: _t, ...rest } = kb.getConfig().config;
    kb.updateConfig(rest);
    expect(read("kanban.yaml")).toContain("prefix: _");
    const before = read("kanban.yaml");
    const dry = kb.updateConfig({ ...rest, tickets: { baseline: true, include: [], exclude: [] } }, { dryRun: true });
    expect(dry.ticketScope).toEqual({ gained: 1, lost: 0 });
    expect(read("kanban.yaml")).toBe(before);
    const real = kb.updateConfig({ ...rest, tickets: { baseline: true, include: [], exclude: [] } });
    expect(real.configChanged).toBe(true);
  });
  it("invalid glob", () => {
    cfg();
    const kb = createKanban({ dir });
    expect(() => kb.updateConfig({ ...kb.getConfig().config, tickets: { include: [{ name: "x", glob: "[" }] } })).toThrow(/include\[0\] "x"/);
  });
});

describe("previewTicketRules", () => {
  it("diffs against the current scan", () => {
    cfg();
    write("1.md", tk("1"));
    write("_2.md", tk("2"));
    write("t/a.md", "---\nx: 1\n---\n");
    const kb = createKanban({ dir });
    const p = kb.previewTicketRules({ include: [{ glob: "t/*.md" }], exclude: [{ prefix: "_" }] });
    expect(p).toMatchObject({ total: 2, newlyIncluded: ["t/a.md"], newlyExcluded: ["_2.md"], unchanged: 1 });
    expect(kb.previewTicketRules({})).toMatchObject({ total: 2, newlyIncluded: [], newlyExcluded: [] });
    expect(() => kb.previewTicketRules({ include: [{}] })).toThrow(/condition/);
  });
  it("caps lists at 50", () => {
    cfg();
    for (let i = 0; i < 60; i++) write(`n${i}.md`, "x\n");
    const p = createKanban({ dir }).previewTicketRules({ include: [{ prefix: "n" }] });
    expect(p.newlyIncluded).toHaveLength(50);
    expect(p.gained).toBe(60);
  });
});

describe("validate", () => {
  it("warns on baseline false without include; errors on invalid glob in file", () => {
    cfg("tickets:\n  baseline: false\n");
    expect(createKanban({ dir }).validate().warnings.some((w) => /no tickets can exist/.test(w.message))).toBe(true);
    cfg('tickets:\n  include:\n    - { name: a, glob: "[" }\n');
    expect(createKanban({ dir }).validate().errors.some((e) => /invalid glob/.test(e.message))).toBe(true);
    cfg("tickets:\n  include:\n    - { name: a, prefix: x }\n    - { name: a, prefix: y }\n");
    expect(createKanban({ dir }).validate().warnings.some((w) => /duplicate rule name/.test(w.message))).toBe(true);
  });
});

describe("add", () => {
  it("warns when -f is outside scanned area", () => {
    cfg();
    const r = createKanban({ dir }).add({ name: "x", file: "sub/x.md" });
    expect(r.warnings.some((w) => w.kind === "not-scanned")).toBe(true);
    cfg('tickets:\n  include:\n    - { glob: "sub/*.md" }\n');
    const r2 = createKanban({ dir }).add({ name: "y", file: "sub/y.md" });
    expect(r2.warnings.some((w) => w.kind === "not-scanned")).toBe(false);
    expect(read("sub/y.md")).toContain("type: ticket");
  });
});

describe("events", () => {
  it("config.updated carries ticketRules diff", () => {
    cfg();
    const evs: KbEvent[] = [];
    const kb = createKanban({ dir, events: { emit: (e: KbEvent) => void evs.push(e) } });
    kb.updateConfig({ ...kb.getConfig().config, tickets: { baseline: false, include: [{ name: "a", prefix: "x" }], exclude: [] } });
    const e = evs.find((x) => x.type === "config.updated")!;
    expect((e.data as any).ticketRules).toEqual({
      baselineChanged: true,
      include: { added: 1, removed: 0, changed: 0 },
      exclude: { added: 0, removed: 0, changed: 0 },
    });
  });
});

describe("api", () => {
  it("GET/PUT/preview", async () => {
    cfg();
    write("t/a.md", "x\n");
    const kb = createKanban({ dir });
    const call = (method: string, p: string, body?: unknown) =>
      handleApi(kb, { method, path: p, query: new URLSearchParams(), body: (body ?? {}) as Record<string, unknown> });
    const tickets = { include: [{ glob: "t/*.md" }] };
    const pv = await call("POST", "/api/config/preview-tickets", { tickets });
    expect(pv.status).toBe(200);
    expect((pv.body as any).newlyIncluded).toEqual(["t/a.md"]);
    expect((await call("POST", "/api/config/preview-tickets", {})).status).toBe(400);
    expect((await call("POST", "/api/config/preview-tickets", { tickets: { include: [{}] } })).status).toBe(400);
    expect((await call("GET", "/api/config/preview-tickets")).status).toBe(405);
    const g = (await call("GET", "/api/config")).body as any;
    const dry = await call("PUT", "/api/config", { config: { ...g.config, tickets }, dryRun: true });
    expect((dry.body as any).ticketScope).toEqual({ gained: 1, lost: 0 });
    expect(read("kanban.yaml")).not.toContain("t/*.md");
    const put = await call("PUT", "/api/config", { config: { ...g.config, tickets } });
    expect(put.status).toBe(200);
    expect(((await call("GET", "/api/config")).body as any).config.tickets.include[0].glob).toBe("t/*.md");
    const badPut = await call("PUT", "/api/config", { config: { ...g.config, tickets: { exclude: [{ prefix: "a/" }] } } });
    expect(badPut.status).toBe(400);
  });
});

describe("cli e2e", () => {
  it("kb ls with include rule", () => {
    execFileSync("npx", ["tsc"], { cwd: process.cwd() });
    cfg('tickets:\n  include:\n    - { glob: "tasks/*.md", props: { kind: task } }\n');
    write("tasks/a.md", "---\nkind: task\nid: \"7\"\nstatus: doing\n---\n");
    write("tasks/b.md", "---\nkind: other\n---\n");
    const r = spawnSync("node", [path.resolve("dist/cli/main.js"), "ls", "--format", "text"], { cwd: dir, encoding: "utf8" });
    expect(r.stdout).toContain("a");
    expect(r.stdout).toContain("#7");
    expect(r.stdout).not.toContain("b");
  });
});
