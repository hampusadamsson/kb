import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { complete } from "../src/cli/commands/complete.js";
import { generate } from "../src/cli/completion.js";
import { buildProgram } from "../src/cli/program.js";

const main = path.resolve(import.meta.dirname, "../dist/cli/main.js");
const has = (sh: string): boolean => spawnSync(sh, ["-c", "true"]).status === 0;

describe("generated scripts cover the program", () => {
  const p = buildProgram();
  const cmds = p.commands.filter((c) => c.name() !== "__complete");
  for (const shell of ["bash", "zsh"]) {
    it(`${shell} has every command and option`, () => {
      const s = generate(p, shell);
      expect(s).not.toContain("__complete_");
      for (const c of cmds) {
        expect(s).toContain(c.name());
        for (const o of c.options) {
          if (o.long) expect(s).toContain(o.long);
          if (o.short) expect(s).toContain(o.short);
        }
      }
      for (const o of p.options) expect(s).toContain(o.long!);
    });
  }
  it("bash assigns COMPREPLY per line so spaces survive; zsh has no escaper", () => {
    const b = generate(p, "bash");
    // one array element per output line, no word-splitting round trip
    expect(b).toContain('COMPREPLY+=("$l")');
    expect(b).toContain('done < <(kb __complete "$@" 2>/dev/null)');
    expect(b).not.toContain("COMPREPLY=($(_kb_dyn");
    expect(b).not.toContain("_kb_esc"); // no longer needed: nothing re-splits the values
    const z = generate(p, "zsh");
    expect(z).not.toContain("_kb_esc");
  });

  it.skipIf(!has("bash"))("bash keeps a space-containing dynamic candidate as ONE word", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kbcsh-"));
    try {
      const stub = path.join(dir, "kb");
      fs.writeFileSync(stub, "#!/bin/sh\nprintf '%s\\n' \"Board Name\"\n", { mode: 0o755 });
      const script = path.join(dir, "kb.bash");
      fs.writeFileSync(script, generate(p, "bash"));
      // `_kb` is the real generated function; only the `kb` binary is stubbed.
      const driver = [
        `source ${JSON.stringify(script)}`,
        'COMP_WORDS=(kb add --board "Bo")',
        "COMP_CWORD=3",
        "_kb",
        'printf \'%s\\n\' "${#COMPREPLY[@]}" "${COMPREPLY[@]}"',
      ].join("\n");
      const r = spawnSync("bash", ["-c", driver], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("1\nBoard Name\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("zsh has descriptions; unknown shell throws", () => {
    const s = generate(p, "zsh");
    for (const c of cmds) expect(s).toContain(c.description().replace(/'/g, "'\\''"));
    expect(() => generate(p, "fish")).toThrow(/unknown shell/);
  });
});

describe("__complete", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kbc-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tk = (f: string, fm: string) => fs.writeFileSync(path.join(dir, f), `---\ntype: ticket\n${fm}\n---\n`);

  it("computes kinds", () => {
    fs.writeFileSync(path.join(dir, "kanban.yaml"), "columns: [todo, done]\nboards:\n  other:\n    columns: [backlog, active]\n");
    tk("a.md", "id: 1\nname: A b\nstatus: todo\nlabels: [bug]\npriority: high");
    tk("b.md", "id: 2\nname: B\nstatus: active\nboard: other\nlabels: [ui]");
    expect(complete(dir, "ids").sort()).toEqual(["1", "2"]);
    expect(complete(dir, "ids", "named")).toContain("1:A b");
    expect(complete(dir, "ids", "named")).toContain("2:B");
    expect(complete(dir, "columns", "1")).toEqual(["todo", "done"]);
    expect(complete(dir, "columns", "2")).toEqual(["backlog", "active"]);
    expect(complete(dir, "columns").sort()).toEqual(["active", "backlog", "done", "todo"]);
    expect(complete(dir, "boards").length).toBe(2);
    expect(complete(dir, "labels")).toEqual(["bug", "ui"]);
    expect(complete(dir, "propkeys")).toEqual(["priority:"]);
  });

  it("returns raw names in named ids", () => {
    fs.writeFileSync(path.join(dir, "kanban.yaml"), "columns: [todo]\n");
    const name = 'Fix $HOME `x` "q" it\'s C:\\tmp';
    tk("a.md", `id: 1\nname: ${JSON.stringify(name)}\nstatus: todo`);
    // values are unescaped: shell layers (bash COMPREPLY per line, zsh compadd -a) quote them
    expect(complete(dir, "ids", "named")).toEqual([`1:${name}`]);
  });

  it("is silent without kanban.yaml", () => {
    expect(complete(dir, "ids")).toEqual([]);
    const r = spawnSync("node", [main, "__complete", "ids"], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
  });
});

describe("completion e2e (dist)", () => {
  const kb = (...a: string[]) => spawnSync("node", [main, ...a], { encoding: "utf8" });
  it("prints scripts", () => {
    expect(kb("completion", "zsh").stdout).toContain("compdef _kb kb");
    expect(kb("completion", "bash").stdout).toContain("complete -F _kb kb");
    expect(kb("--help").stdout).not.toContain("__complete");
    expect(kb("completion", "--help").stdout).toContain("source <(kb completion zsh)");
  });
  it("unknown shell exits 1", () => {
    const r = kb("completion", "fish");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^error: /);
  });
  it.skipIf(!has("bash"))("bash -n passes", () => {
    const r = spawnSync("bash", ["-n"], { input: kb("completion", "bash").stdout, encoding: "utf8" });
    expect(r.status).toBe(0);
  });
  it.skipIf(!has("zsh"))("zsh sources cleanly", () => {
    const r = spawnSync("zsh", ["-fc", `autoload -U compinit; compinit -u; source <(node ${main} completion zsh)`], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});
