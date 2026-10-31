import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { splitFrontmatter } from "../src/core/frontmatter.js";
import { createKanban } from "../src/core/index.js";
import { createAutomationLog } from "../src/automationLog.js";
import { createShellRunner } from "../src/runner.js";
import { startServer, type RunningServer } from "../src/web/server.js";

const main = path.resolve(import.meta.dirname, "../dist/cli/main.js");
let dir: string;
const cfg = (run: string) =>
  `columns: [todo, done]\nglob: "**/*.md"\nautomations:\n  - name: t\n    when: { moved_to: done }\n    run: ${JSON.stringify(run)}\n`;
const setup = (run: string) => {
  fs.writeFileSync(path.join(dir, "kanban.yaml"), cfg(run));
};
beforeEach(() => void (dir = fs.mkdtempSync(path.join(os.tmpdir(), "kbe2e-"))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function kb(args: string[], env: Record<string, string | undefined> = {}) {
  const e = { ...process.env, ...env };
  if (env.KB_AUTOMATION === undefined) delete e.KB_AUTOMATION;
  const r = spawnSync("node", [main, ...args], { cwd: dir, env: e, encoding: "utf8" });
  return { out: r.stdout, err: r.stderr, code: r.status };
}
const idOf = (out: string) => /#(\S+)/.exec(out)![1];
const fmOf = (p: string) => parse(splitFrontmatter(fs.readFileSync(path.join(dir, p), "utf8")).yaml!) as Record<string, any>;
const ticketFile = () => fs.readdirSync(dir).find((f) => f.endsWith(".md"))!;

describe("cli automation e2e", () => {
  it("runs rule on mv", () => {
    setup("echo {{ id }}-{{ name }} > out.txt");
    const a = kb(["add", "hello"]);
    const id = idOf(a.out);
    const m = kb(["mv", id, "done"]);
    expect(m.code).toBe(0);
    expect(m.out).toBe(`#${id} updated\n`);
    expect(fs.readFileSync(path.join(dir, "out.txt"), "utf8")).toBe(`${id}-hello\n`);
    const fm = fmOf(ticketFile());
    expect(fm.automations.t.status).toBe("done");
    const log = createAutomationLog(dir).recent();
    expect(log).toHaveLength(1);
    expect(log[0].rule).toBe("t");
  });
  it.each([
    ["KB_AUTOMATION env", ["mv"], { KB_AUTOMATION: "1" }],
    ["--no-automation", ["--no-automation", "mv"], {}],
    ["mv --no-automation", ["mv", "--no-automation"], {}],
  ])("skips with %s", (_n, _a, env) => {
    setup("echo x > out.txt");
    const id = idOf(kb(["add", "hello"]).out);
    const args =
      _a.includes("--no-automation") && _a[0] === "mv"
        ? ["mv", id, "done", "--no-automation"]
        : _a[0] === "--no-automation"
          ? ["--no-automation", "mv", id, "done"]
          : ["mv", id, "done"];
    expect(kb(args, env).code).toBe(0);
    expect(fs.existsSync(path.join(dir, "out.txt"))).toBe(false);
    expect(fmOf(ticketFile()).automations).toBeUndefined();
  });
  it("failing script: failed status, warning, exit 0", () => {
    setup("exit 3");
    const id = idOf(kb(["add", "hello"]).out);
    const m = kb(["mv", id, "done"]);
    expect(m.code).toBe(0);
    expect(m.err).toContain('warning: automation "t" failed (exit 3)');
    const t = fmOf(ticketFile()).automations.t;
    expect(t.status).toBe("failed");
    expect(t.exit).toBe(3);
    expect(createAutomationLog(dir).recent()[0].result.exitCode).toBe(3);
  });
  it("does not execute injection in names", () => {
    setup("echo {{ name }} > out.txt");
    const id = idOf(kb(["add", "'; touch pwned; '"]).out);
    kb(["mv", id, "done"]);
    expect(fs.existsSync(path.join(dir, "pwned"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "out.txt"), "utf8")).toBe("'; touch pwned; '\n");
  });
});

describe("web automation", () => {
  let server: RunningServer | undefined;
  afterEach(async () => void (await server?.close()));
  const patch = (id: string) =>
    fetch(`${server!.url}/api/tickets/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
  const runs = async () => ((await (await fetch(`${server!.url}/api/automation/log`)).json()) as { runs: any[] }).runs;
  async function poll(): Promise<any[]> {
    for (let i = 0; i < 50; i++) {
      const r = await runs();
      if (r.length) return r;
      await new Promise((r) => setTimeout(r, 100));
    }
    return [];
  }

  it("runs the rule and logs it", async () => {
    setup("echo {{ id }} > out.txt");
    const { id } = createKanban({ dir }).add({ name: "a" });
    server = await startServer({ dir, port: 0, runner: createShellRunner(), log: createAutomationLog(dir) });
    expect((await patch(String(id))).status).toBe(200);
    const r = await poll();
    expect(r).toHaveLength(1);
    expect(r[0].status).toBe("done");
    expect(fs.readFileSync(path.join(dir, "out.txt"), "utf8")).toBe(`${id}\n`);
  });
  it("without a runner nothing runs", async () => {
    setup("echo x > out.txt");
    const { id } = createKanban({ dir }).add({ name: "a" });
    server = await startServer({ dir, port: 0, log: createAutomationLog(dir) });
    expect((await patch(String(id))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(await runs()).toEqual([]);
    expect(fs.existsSync(path.join(dir, "out.txt"))).toBe(false);
  });
});
