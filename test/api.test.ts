import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createKanban, KanbanError, type Kanban } from "../src/index.js";
import { handleApi } from "../src/api/api.js";

let dir: string;
let kb: Kanban;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-api-"));
  fs.writeFileSync(
    path.join(dir, "kanban.yaml"),
    'columns: [todo, doing, done]\nglob: "**/*.md"\nboards:\n  other:\n    columns: [backlog, active]\n',
  );
  kb = createKanban({ dir, now: () => new Date(2026, 0, 2, 3, 4, 5) });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof KanbanError ? e.code : "other";
  }
};

describe("Kanban core API", () => {
  it("init", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "kb-api-"));
    try {
      const k = createKanban({ dir: d });
      expect(code(() => k.load())).toBe("config");
      k.init();
      expect(k.load().config.columns).toEqual(["todo", "doing", "done"]);
      expect(code(() => k.init())).toBe("exists");
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("add → list → update → move → comment → get", () => {
    const a = kb.add({ name: "Fix login", labels: ["bug"], properties: { priority: "high" }, body: "details" });
    expect(a).toEqual({ id: "001", path: "001-fix-login.md", warnings: [] });
    const b = kb.add({ name: "Other", board: "other", status: "weird" });
    expect(b.warnings).toMatchObject([{ kind: "unsorted" }]);

    const l = kb.list();
    expect(l.boards.map((x) => x.name)).toEqual(["default", "other"]);
    const todo = l.boards[0].columns.find((c) => c.name === "todo")!;
    expect(todo.tickets.map((t) => t.name)).toEqual(["Fix login"]);
    expect(l.boards[1].unsorted.map((t) => t.name)).toEqual(["Other"]);
    expect(l.warnings).toMatchObject([{ kind: "unsorted", path: "002-other.md" }]);
    expect(kb.boards()).toEqual(["default", "other"]);

    expect(
      kb.update("1", { name: "Renamed", addLabels: ["ui"], removeLabels: ["bug"], setProps: { x: 1 }, unsetProps: ["priority"] }).id,
    ).toBe("001");
    let t = kb.get("1");
    expect(t).toMatchObject({ name: "Renamed", labels: ["ui"], props: { x: 1 } });
    expect(t.body).toContain("details");

    kb.move("1", "doing");
    expect(kb.get("001").column).toBe("doing");
    expect(kb.move("1", "nope").warnings).toHaveLength(1);

    expect(kb.comment("1", "hello")).toBe("2026-01-02T03:04");
    expect(kb.comment("1", "again")).toBe("2026-01-02T03:04:05");
    t = kb.get("1");
    expect(Object.values(t.comments)).toEqual(["hello", "again"]);
    expect(kb.pathOf("1")).toBe(path.join(dir, "001-fix-login.md"));
  });

  it("typed errors", () => {
    kb.add({ name: "A" });
    expect(code(() => kb.get("99"))).toBe("not-found");
    expect(code(() => kb.add({ name: "B", id: "1" }))).toBe("exists");
    expect(code(() => kb.add({ name: "" }))).toBe("invalid");
    expect(code(() => kb.add({ name: "B", properties: { id: 3 } }))).toBe("invalid");
    expect(code(() => kb.update("1", {}))).toBe("invalid");
    expect(code(() => kb.list({ board: "zzz" }))).toBe("not-found");
    fs.writeFileSync(path.join(dir, "dup.md"), '---\ntype: ticket\nid: "001"\nname: D\nstatus: todo\n---\n');
    expect(code(() => kb.get("001"))).toBe("ambiguous");
  });

  it("add rejects an unknown board", () => {
    expect(code(() => kb.add({ name: "X", board: "todo/typo" }))).toBe("invalid");
    expect(() => kb.add({ name: "X", board: "todo/typo" })).toThrow(/unknown board "todo\/typo" \(known: default, other\)/);
    // nothing was written
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".md"))).toEqual([]);
    // known boards (default and configured) still work
    expect(kb.add({ name: "D", board: "default" }).id).toBe("001");
    expect(kb.add({ name: "O", board: "other", status: "backlog" }).id).toBe("002");
  });

  it("update rejects a label that is both added and removed", () => {
    kb.add({ name: "A", labels: ["bug"] });
    const file = path.join(dir, "001-a.md");
    const before = fs.readFileSync(file, "utf8");
    const mtime = fs.statSync(file).mtimeMs;
    expect(code(() => kb.update("1", { addLabels: ["ui", "new"], removeLabels: ["new", "bug"] }))).toBe("invalid");
    expect(() => kb.update("1", { addLabels: ["ui", "new"], removeLabels: ["new"] })).toThrow(/labels both added and removed: new/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
    expect(kb.get("1").labels).toEqual(["bug"]);
  });

  it("fix API requires an explicit boolean and reports dry-run vs applied", async () => {
    fs.writeFileSync(path.join(dir, "noid.md"), "---\ntype: ticket\nname: N\nstatus: todo\n---\n");
    const call = (body: Record<string, unknown>) => handleApi(kb, { method: "POST", path: "/api/fix", query: new URLSearchParams(), body });

    const empty = await call({});
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ dryRun: true, applied: false, hint: "pass dryRun:false to apply" });
    expect((empty.body as { changes: unknown[] }).changes).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, "noid.md"), "utf8")).not.toContain("id:");

    const typo = await call({ dryrun: true });
    expect(typo.status).toBe(200);
    expect(typo.body).toMatchObject({ dryRun: true, applied: false });

    const bad = await call({ dryRun: "yes" });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: "invalid" });

    const applied = await call({ dryRun: false });
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ dryRun: false, applied: true });
    expect((applied.body as { changes: unknown[] }).changes).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, "noid.md"), "utf8")).toContain("id:");
  });

  it("filters", () => {
    kb.add({ name: "One", labels: ["bug"], properties: { priority: "high" } });
    kb.add({ name: "Two", labels: ["ui"], properties: { priority: "low" } });
    kb.add({ name: "Three", board: "other", status: "active" });
    const names = (f: Parameters<Kanban["list"]>[0]) =>
      kb
        .list(f)
        .boards.flatMap((b) => [...b.columns.flatMap((c) => c.tickets), ...b.unsorted])
        .map((t) => t.name);
    expect(names({ labels: ["bug"] })).toEqual(["One"]);
    expect(names({ labels: ["!bug"] })).toEqual(["Two", "Three"]);
    expect(names({ props: ["priority:high"] })).toEqual(["One"]);
    expect(names({ props: ["!priority"] })).toEqual(["Three"]);
    expect(names({ text: "two" })).toEqual(["Two"]);
    expect(names({ board: "other" })).toEqual(["Three"]);
    expect(kb.list({ labels: ["nope"] }).boards).toEqual([]);
  });

  it("validate and fix", () => {
    kb.add({ name: "A" });
    expect(kb.validate()).toMatchObject({ errors: [], warnings: [] });
    fs.writeFileSync(path.join(dir, "dup.md"), "---\ntype: ticket\nid: 1\nname: D\nstatus: todo\n---\n");
    fs.writeFileSync(path.join(dir, "noid.md"), "---\ntype: ticket\nname: N\nstatus: nope\n---\n");
    const v = kb.validate();
    expect(v.errors.map((e) => e.message)).toEqual(
      expect.arrayContaining(["missing id", 'status "nope" is not a column of board "default"']),
    );
    expect(v.errors.length).toBe(4);
    expect(
      kb
        .load()
        .warnings.map((w) => w.kind)
        .sort(),
    ).toEqual(["duplicate-id", "missing-id", "unsorted"]);

    const dry = kb.fix({ dryRun: true });
    expect(dry).toHaveLength(2);
    expect(dry.every((c) => c.path && c.to)).toBe(true);
    expect(kb.validate().errors.length).toBe(4);

    const real = kb.fix();
    expect(real).toEqual(dry);
    expect(kb.validate().errors.map((e) => e.message)).toEqual(['status "nope" is not a column of board "default"']);
    expect(kb.fix()).toEqual([]);
  });
});
