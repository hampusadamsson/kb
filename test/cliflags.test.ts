import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProgram } from "../src/cli/program.js";
import { useColor } from "../src/cli/format.js";

const main = path.resolve(import.meta.dirname, "../dist/cli/main.js");
const kb = (...a: string[]) => spawnSync("node", [main, ...a], { encoding: "utf8" });
const sub = (n: string) => buildProgram().commands.find((c) => c.name() === n)!;

describe("mcp flags", () => {
  it("declares --no-automation like mv/web do", () => {
    const flags = (n: string) => sub(n).options.map((o) => o.long);
    expect(flags("mcp")).toContain("--no-automation");
    expect(flags("mv")).toContain("--no-automation");
    expect(flags("web")).toContain("--no-automation");
    const c = sub("mcp");
    c.parseOptions(["--no-automation"]);
    expect(c.opts().automation).toBe(false);
  });

  it("accepts --no-automation on the cli", () => {
    // Without the flag commander rejects the invocation; with it we reach the config check.
    const r = kb("mcp", "--dir", path.join(os.tmpdir(), "kb-does-not-exist"), "--no-automation");
    expect(r.stderr).not.toMatch(/unknown option/);
    expect(r.stderr).toContain("kanban.yaml not found");
    expect(r.status).toBe(1);
  });
});

describe("ls --limit/--full are json-only", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kbflags-"));
    fs.writeFileSync(path.join(dir, "kanban.yaml"), "columns: [todo, done]\n");
    fs.writeFileSync(path.join(dir, "a.md"), "---\ntype: ticket\nid: 1\nname: A\nstatus: todo\n---\n");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (...a: string[]) => spawnSync("node", [main, ...a], { cwd: dir, encoding: "utf8" });

  it("rejects a bad --limit in both formats", () => {
    for (const f of ["json", "text"]) {
      const r = run("ls", "--format", f, "--limit", "abc");
      expect(r.status, f).toBe(1);
      expect(r.stderr, f).toMatch(/^error: --limit must be a non-negative integer/);
    }
  });

  it("rejects --full and --limit with --format text", () => {
    const full = run("ls", "--format", "text", "--full");
    expect(full.status).toBe(1);
    expect(full.stderr).toMatch(/^error: --full and --limit only apply to --format json/);
    const limit = run("ls", "--format", "text", "--limit", "5");
    expect(limit.status).toBe(1);
    expect(limit.stderr).toMatch(/^error: --full and --limit only apply to --format json/);
    expect(run("ls", "--format", "text").status).toBe(0);
  });

  it("still applies --limit and --full to json", () => {
    const j = JSON.parse(run("ls", "--limit", "1", "--full").stdout);
    expect(j).toMatchObject({ limit: 1, shown: 1 });
    expect(j.tickets[0].body).toBeTypeOf("string");
  });
});

describe("ls warnings", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kbwarn-"));
    fs.writeFileSync(path.join(dir, "kanban.yaml"), "columns: [todo, done]\n");
    for (const f of ["a.md", "b.md"]) fs.writeFileSync(path.join(dir, f), "---\ntype: ticket\nid: 1\nname: A\nstatus: todo\n---\n");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("prints formatted text, never [object Object]", () => {
    for (const args of [["ls"], ["ls", "--format", "text"]]) {
      const r = spawnSync("node", [main, ...args], { cwd: dir, encoding: "utf8" });
      expect(r.stderr).toContain("warning: duplicate id 1: a.md, b.md");
      expect(r.stderr).not.toContain("[object Object]");
    }
  });
});

describe("NO_COLOR", () => {
  const saved = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const tty = (v: boolean | undefined): void => {
    Object.defineProperty(process.stdout, "isTTY", { value: v, configurable: true });
  };
  const restore = (): void => {
    if (saved) Object.defineProperty(process.stdout, "isTTY", saved);
    else Reflect.deleteProperty(process.stdout, "isTTY");
  };
  afterEach(() => {
    restore();
    delete process.env.NO_COLOR;
  });

  it("empty NO_COLOR= disables colour on a tty", () => {
    tty(true);
    delete process.env.NO_COLOR;
    expect(useColor()).toBe(true);
    process.env.NO_COLOR = "";
    expect(useColor()).toBe(false);
    process.env.NO_COLOR = "1";
    expect(useColor()).toBe(false);
  });

  it("colour stays off without a tty", () => {
    tty(undefined);
    delete process.env.NO_COLOR;
    expect(useColor()).toBe(false);
  });
});
