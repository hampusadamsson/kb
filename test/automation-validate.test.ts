import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createKanban } from "../src/index.js";

let dir: string;
const NOW = new Date(2025, 0, 1, 12, 0, 0);
const w = (f: string, s: string) => fs.writeFileSync(path.join(dir, f), s);
const stamp = (d: Date) => d.toISOString();
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-av-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const check = (yaml: string) => {
  w("kanban.yaml", yaml);
  return createKanban({ dir, now: () => NOW }).validate();
};
const rules = (...r: string[]) => `columns: [todo, done]\nautomations:\n${r.map((x) => `  - ${x}`).join("\n")}\n`;
const msgs = (v: ReturnType<typeof check>) => v.errors.map((e) => e.message);

describe("validate automations", () => {
  it("accepts a good config", () => {
    const v = check(rules("{ name: a, when: { moved_to: done }, run: 'echo {{id}} {{props.x}}' }"));
    expect(v.errors).toEqual([]);
  });
  it("unknown column", () => {
    const m = msgs(check(rules("{ name: a, when: { moved_to: nope }, run: ls }")));
    expect(m).toHaveLength(1);
    expect(m[0]).toContain('"a"');
    expect(m[0]).toContain('"default"');
    expect(m[0]).toContain("nope");
  });
  it("created_in unknown column on another board", () => {
    const y =
      "columns: [todo]\nboards:\n  o:\n    columns: [a]\n    automations:\n      - { name: z, when: { created_in: todo }, run: ls }\n";
    const m = msgs(check(y));
    expect(m[0]).toContain('board "o"');
  });
  it("duplicate, blank name, blank run", () => {
    const m = msgs(
      check(
        rules(
          "{ name: a, when: { moved_to: done }, run: ls }",
          "{ name: a, when: { moved_to: done }, run: ls }",
          "{ name: ' ', when: { moved_to: done }, run: ls }",
          "{ name: b, when: { moved_to: done }, run: ' ' }",
        ),
      ),
    );
    expect(m.some((x) => x.includes("duplicate") && x.includes('"a"'))).toBe(true);
    expect(m.some((x) => x.includes("empty name"))).toBe(true);
    expect(m.some((x) => x.includes("empty run") && x.includes('"b"'))).toBe(true);
  });
  it("unknown template variable", () => {
    const m = msgs(check(rules("{ name: a, when: { moved_to: done }, run: 'echo {{bogus}}' }")));
    expect(m).toHaveLength(1);
    expect(m[0]).toContain("bogus");
  });
});

describe("validate placeholder context", () => {
  it.each([`echo "{{ name }}"`, "echo '{{ name }}'", "echo `{{ name }}`", "cat <<EOF\n{{ name }}\nEOF"])("rejects %s", (run) => {
    const m = msgs(check(rules(`{ name: a, when: { moved_to: done }, run: ${JSON.stringify(run)} }`)));
    expect(m).toHaveLength(1);
    expect(m[0]).toContain('board "default" automation "a"');
    expect(m[0]).toContain("must not be inside");
  });
  it("accepts bare", () => {
    expect(check(rules("{ name: a, when: { moved_to: done }, run: 'echo $(x {{ name }})' }")).errors).toEqual([]);
  });
});

describe("stale running", () => {
  const tk = (status: string, at: Date) =>
    w(
      "1.md",
      `---\ntype: ticket\nid: "001"\nname: T\nstatus: todo\nautomations:\n  r:\n    status: ${status}\n    at: "${stamp(at)}"\n---\n`,
    );
  const run = () => {
    w("kanban.yaml", "columns: [todo, done]\n");
    return createKanban({ dir, now: () => NOW }).validate();
  };
  it("warns when old", () => {
    tk("running", new Date(NOW.getTime() - 6 * 60_000));
    const v = run();
    expect(v.errors).toEqual([]);
    expect(v.warnings).toHaveLength(1);
    expect(v.warnings[0].path).toBe("1.md");
    expect(v.warnings[0].message).toContain('"r"');
    expect(v.warnings[0].message).toContain('"default"');
  });
  it("no warning when fresh or done", () => {
    tk("running", new Date(NOW.getTime() - 60_000));
    expect(run().warnings).toEqual([]);
    tk("done", new Date(NOW.getTime() - 60 * 60_000));
    expect(run().warnings).toEqual([]);
  });
});
