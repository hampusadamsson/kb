import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createKanban } from "../src/core/index.js";

const CLI = path.resolve(import.meta.dirname, "../dist/cli/main.js");
const NOW = new Date("2026-03-01T12:00:00");
const iso = (minAgo: number): string => {
  const d = new Date(NOW.getTime() - minAgo * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const CONFIG = `name: main
columns: [todo, review, done]
automations:
  - name: lint
    when: { moved_to: review }
    run: echo lint
  - name: off
    when: { created_in: todo }
    run: echo off
    timeout: 300
    enabled: false
    guard: false
boards:
  other:
    columns: [a, b]
    automations:
      - name: pi
        when: { moved_to: b }
        run: ${"x".repeat(300)}
  bare:
    columns: [a]
`;
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-auto-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const tk = (file: string, fm: string) => fs.writeFileSync(path.join(dir, file), `---\ntype: ticket\n${fm}\n---\n`);
const cfg = (c = CONFIG) => fs.writeFileSync(path.join(dir, "kanban.yaml"), c);
const ov = (board?: string) => createKanban({ dir, now: () => NOW }).automationOverview({ board });
const entry = (rule: string, status: string, min: number, extra = "") =>
  `automations:\n  ${rule}: { status: ${status}, at: "${iso(min)}", runs: 1${extra} }`;

describe("automationOverview", () => {
  it("excludes stale from live; counts; last run", () => {
    cfg();
    tk("a.md", `id: 1\nname: A\nstatus: review\n${entry("lint", "running", 1)}`);
    tk("b.md", `id: 2\nname: B\nstatus: review\n${entry("lint", "running", 10)}`);
    tk("c.md", `id: 3\nname: C\nstatus: review\n${entry("lint", "done", 30, ", exit: 0")}`);
    tk("d.md", `id: 4\nname: D\nstatus: review\n${entry("lint", "failed", 20, ", exit: 2, error: boom")}`);
    tk("e.md", `id: 5\nname: E\nstatus: review\n${entry("lint", "skipped", 40)}`);
    const o = ov("main");
    expect(o.live.map((l) => l.ticket.id)).toEqual([1]);
    expect(o.live[0]).toMatchObject({ rule: "lint", board: "main", elapsedMs: 60_000 });
    const lint = o.rules.find((r) => r.name === "lint")!;
    expect(lint.running).toBe(1);
    expect(lint.counts).toEqual({ done: 1, failed: 1, skipped: 1, running: 1, stale: 1 });
    expect(lint.lastRun).toMatchObject({ ticketId: 1, status: "running" });
  });
  it("last run picks newest; failure carries exit/error", () => {
    cfg();
    tk("c.md", `id: 3\nname: C\nstatus: review\n${entry("lint", "done", 30, ", exit: 0")}`);
    tk("d.md", `id: 4\nname: D\nstatus: review\n${entry("lint", "failed", 20, ", exit: 2, error: boom")}`);
    expect(ov().rules.find((r) => r.name === "lint")!.lastRun).toMatchObject({ ticketId: 4, status: "failed", exit: 2, error: "boom" });
  });
  it("disabled rules, per-board rules not inherited, run clipped", () => {
    cfg();
    const o = ov();
    expect(o.rules.map((r) => `${r.board}/${r.name}`)).toEqual(["main/lint", "main/off", "other/pi"]);
    expect(o.rules[1]).toMatchObject({ enabled: false, guard: false });
    expect(ov("bare").rules).toEqual([]);
    expect(o.rules[2].run.length).toBe(201);
    expect(o.rules[0].lastRun).toBeNull();
  });
  it("unknown board throws", () => {
    cfg();
    expect(() => ov("nope")).toThrow(/unknown board/);
  });
});

describe("kb automations (dist)", () => {
  const kb = (...a: string[]) => spawnSync("node", [CLI, ...a], { cwd: dir, encoding: "utf8" });
  const snap = (d = dir): string[] =>
    fs
      .readdirSync(d, { withFileTypes: true })
      .flatMap((e) =>
        e.isDirectory()
          ? snap(path.join(d, e.name))
          : [`${path.join(d, e.name)}:${fs.statSync(path.join(d, e.name)).mtimeMs}:${fs.readFileSync(path.join(d, e.name), "utf8")}`],
      );
  const nowIso = (minAgo: number) =>
    iso(minAgo).replace(/.*/, () => {
      const d = new Date(Date.now() - minAgo * 60_000);
      const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    });
  const real = (rule: string, status: string, min: number) =>
    `automations:\n  ${rule}: { status: ${status}, at: "${nowIso(min)}", runs: 1 }`;

  it("live empty, JSON and text", () => {
    cfg();
    tk("a.md", "id: 1\nname: A\nstatus: todo");
    const r = kb("automations");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ live: [], count: 0 });
    expect(r.stderr).toBe("");
    expect(kb("automations", "--format", "text").stdout).toBe("No automations running.\n");
  });
  it("fresh running listed; stale not, but 'stale' in --all; read-only", () => {
    cfg();
    tk("a.md", `id: 1\nname: A\nstatus: review\n${real("lint", "running", 1)}`);
    tk("b.md", `id: 2\nname: B\nstatus: review\n${real("lint", "running", 20)}`);
    const before = snap();
    const live = JSON.parse(kb("automations", "--live").stdout);
    expect(live.count).toBe(1);
    expect(live.live[0]).toMatchObject({ rule: "lint", board: "main", ticket: { id: 1, name: "A", path: "a.md" } });
    expect(kb("automations", "--format", "text").stdout).toMatch(/^RULE +BOARD +TICKET +ELAPSED +STARTED +PID\nlint +main +#1 A +1m /);
    const all = JSON.parse(kb("automations", "--all").stdout);
    expect(all.count).toBe(3);
    const lint = all.automations.find((a: any) => a.name === "lint");
    expect(lint).toMatchObject({ running: 1, counts: { running: 1, stale: 1 }, enabled: true, when: { moved_to: "review" } });
    expect(lint.lastRun.ticketId).toBe(1);
    const txt = kb("automations", "--all", "--format", "text").stdout;
    expect(txt).toMatch(/^NAME +BOARD +ON +WHEN +TIMEOUT +RUNNING +LAST\n/);
    expect(txt).toMatch(/lint +main +yes +moved_to review +- +1 +running 1m ago #1/);
    expect(txt).toMatch(/off +main +no +created_in todo +5m /);
    expect(lint).toMatchObject({ timeout: 0 });
    expect(all.automations.find((a: any) => a.name === "off").timeout).toBe(300);
    expect(snap()).toEqual(before);
  });
  it("board filter", () => {
    cfg();
    const all = JSON.parse(kb("automations", "--all", "-b", "other").stdout);
    expect(all.automations.map((a: any) => a.name)).toEqual(["pi"]);
    expect(kb("automations", "--board", "nope").status).toBe(1);
  });
  it("both flags exit 1", () => {
    cfg();
    const r = kb("automations", "--live", "--all");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^error: /);
  });
  it("no automations configured", () => {
    cfg("columns: [todo]\n");
    expect(kb("automations", "--all", "--format", "text").stdout).toBe("No automations configured.\nsee the README (Automations)\n");
    expect(JSON.parse(kb("automations", "--all").stdout)).toEqual({ automations: [], count: 0 });
    expect(fs.existsSync(path.join(dir, ".kb"))).toBe(false);
  });

  // `ls` is the same command, reachable with and without the verb; `kill` needs a selector.
  it("ls verb behaves like the bare command", () => {
    cfg();
    tk("a.md", `id: 1\nname: A\nstatus: review\n${real("lint", "running", 1)}`);
    const strip = (s: string): string => s.replace(/"elapsedMs": \d+/, '"elapsedMs": 0');
    expect(strip(kb("automations", "ls").stdout)).toBe(strip(kb("automations").stdout));
    expect(kb("automations", "ls", "--format", "text").stdout).toMatch(/^RULE +BOARD +TICKET +ELAPSED +STARTED +PID\n/);
    expect(JSON.parse(kb("automations", "ls").stdout).count).toBe(1);
    expect(strip(kb("automations", "ls", "--all").stdout)).toBe(strip(kb("automations", "--all").stdout));
  });
  it("kill requires a selector and reports an empty board", () => {
    cfg();
    const none = kb("automations", "kill");
    expect(none.status).toBe(1);
    expect(none.stderr).toMatch(/nothing selected: pass -t\/--ticket <id>, -r\/--rule <name>, or -a\/--all/);
    const empty = kb("automations", "kill", "--all");
    expect(empty.status).toBe(1);
    expect(empty.stderr).toBe("error: no automations running\n");
  });
  it("kill --dry-run lists targets and signals nothing", () => {
    cfg();
    tk("a.md", `id: 1\nname: A\nstatus: review\n${real("lint", "running", 1)}`);
    const before = snap();
    const r = kb("automations", "kill", "--all", "--dry-run", "--format", "text");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("would kill 1 automation:\n  lint on #1 A (no pid)\n");
    expect(JSON.parse(kb("automations", "kill", "-t", "1", "--dry-run").stdout)).toMatchObject({ dryRun: true, count: 1 });
    expect(snap()).toEqual(before);
  });
  it("kill refuses an entry with no pid, exit 1", () => {
    cfg();
    tk("a.md", `id: 1\nname: A\nstatus: review\n${real("lint", "running", 1)}`);
    const r = kb("automations", "kill", "-t", "1", "--format", "text");
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^cannot kill lint on #1 A: no pid recorded/);
  });
  it("kill options need the kill action; unknown action is an error", () => {
    cfg();
    expect(kb("automations", "ls", "-t", "1").stderr).toMatch(/kill options .* need 'kb automations kill'/);
    const bad = kb("automations", "frobnicate");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toBe('error: unknown action "frobnicate" (expected ls or kill)\n');
  });
});
