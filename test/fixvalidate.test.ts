import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fix } from "../src/cli/commands/fix.js";
import { validate } from "../src/cli/commands/validate.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-"));
  fs.writeFileSync(path.join(dir, "kanban.yaml"), "columns: [todo, done]\nboards:\n  other:\n    columns: [a, b]\n");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

let t0 = 1_700_000_000;
function put(name: string, text: string, age?: number) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, text);
  const s = age ?? t0++;
  fs.utimesSync(f, s, s);
}
const read = (n: string) => fs.readFileSync(path.join(dir, n), "utf8");
const tk = (extra: string, body = "") => `---\ntype: ticket\n${extra}---\n${body}`;

describe("validate", () => {
  it("clean", () => {
    put("a.md", tk("id: 1\nstatus: todo\n"));
    put("b.md", tk("id: 2\nstatus: a\nboard: other\n"));
    const r = validate(dir);
    expect(r).toMatchObject({ out: "ok", errors: 0, warnings: 0 });
  });
  it("detects errors", () => {
    put("noid.md", tk("status: todo\n"));
    put("d1.md", tk("id: 12\nstatus: todo\n"));
    put("d2.md", tk('id: "12"\nstatus: todo\n'));
    put("nostatus.md", tk("id: 3\n"));
    put("badstatus.md", tk("id: 4\nstatus: a\n"));
    put("labels.md", tk("id: 5\nstatus: todo\nlabels: x\n"));
    put("comments.md", tk("id: 6\nstatus: todo\ncomments: [a]\n"));
    put("broken.md", "---\ntype: ticket\nid: [\n---\n");
    const r = validate(dir);
    expect(r.errors).toBe(8);
    for (const m of [
      "error: noid.md: missing id",
      "error: d1.md: duplicate id 12",
      "error: d2.md: duplicate id 12",
      "error: nostatus.md: missing status",
      "error: badstatus.md: status",
      "error: labels.md: labels is not a list",
      "error: comments.md: comments is not a map",
      "error: broken.md:",
    ])
      expect(r.out).toContain(m);
    expect(r.out).toContain("8 errors, 0 warnings");
  });
  it("board warning only", () => {
    put("a.md", tk("id: 1\nstatus: todo\nboard: nope\n"));
    const r = validate(dir);
    expect(r.errors).toBe(0);
    expect(r.warnings).toBe(1);
    expect(r.out).toContain("warning: a.md:");
  });
  it("invalid config", () => {
    fs.writeFileSync(path.join(dir, "kanban.yaml"), "columns: []\n");
    const r = validate(dir);
    expect(r.errors).toBe(1);
    expect(r.out).toContain("error: kanban.yaml: invalid config");
  });
});

describe("fix", () => {
  it("filename prefix", () => {
    put("042-foo.md", tk("status: todo\n"));
    expect(fix(dir)).toBe("042-foo.md: id (none) -> 042");
    expect(read("042-foo.md")).toBe(tk('id: "042"\nstatus: todo\n'));
  });
  it("prefix taken / no prefix", () => {
    put("a.md", tk("id: 7\nstatus: todo\n"));
    put("07-x.md", tk("status: todo\n"));
    put("y.md", tk("status: todo\n"));
    const out = fix(dir).split("\n");
    expect(out).toEqual(["07-x.md: id (none) -> 008", "y.md: id (none) -> 009"]);
  });
  it("duplicates keep oldest, 12 vs '12'", () => {
    put("new.md", tk("id: 12\nstatus: todo\n"), 2000);
    put("old.md", tk('id: "12"\nstatus: todo\n'), 1000);
    expect(fix(dir)).toBe("new.md: id 12 -> 013");
    expect(read("old.md")).toContain('id: "12"');
    expect(read("new.md")).toContain('id: "013"');
  });
  it("dry-run writes nothing; idempotent; validate passes", () => {
    put("a.md", tk("status: todo\n"));
    put("b.md", tk("id: 1\nstatus: todo\n"));
    put("c.md", tk("id: 1\nstatus: todo\n"));
    const before = ["a.md", "b.md", "c.md"].map(read);
    const out = fix(dir, true);
    expect(out.split("\n").every((l) => l.startsWith("(dry-run) "))).toBe(true);
    expect(["a.md", "b.md", "c.md"].map(read)).toEqual(before);
    expect(validate(dir).errors).toBe(3);
    fix(dir);
    expect(fix(dir)).toBe("nothing to fix");
    expect(validate(dir).out).toBe("ok");
  });
  it("preserves formatting and body; id after type", () => {
    put("a.md", "---\ntype: ticket\n# note\nstatus: todo\nfoo: 'bar'\n---\n# Body\n\ntext  \n");
    fix(dir);
    expect(read("a.md")).toBe("---\ntype: ticket\nid: \"001\"\n# note\nstatus: todo\nfoo: 'bar'\n---\n# Body\n\ntext  \n");
  });
  it("1 vs '001' duplicates: validate errors, fix repairs", () => {
    put("a.md", tk("id: 1\nstatus: todo\n"), 1000);
    put("b.md", tk('id: "001"\nstatus: todo\n'), 2000);
    expect(validate(dir).errors).toBe(2);
    expect(fix(dir)).toBe("b.md: id 001 -> 002");
    expect(validate(dir).out).toBe("ok");
  });
  it("skips parse errors", () => {
    put("broken.md", "---\ntype: ticket\nid: [\n---\n");
    expect(fix(dir)).toBe("nothing to fix");
  });
});
