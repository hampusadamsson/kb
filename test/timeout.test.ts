import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createKanban, type KbEvent } from "../src/core/index.js";
import { automationSchema } from "../src/core/config.js";
import type { AutomationRunner } from "../src/core/automation.js";
import { createShellRunner } from "../src/runner.js";
import { LiveRuns } from "../src/liveRuns.js";
import { startServer, type RunningServer } from "../src/web/server.js";
import { fmtTimeout } from "../src/cli/commands/automations.js";
import * as L from "../src/web/public/logic.js";
import * as A from "../src/web/public/automation-logic.js";
import * as V from "../src/web/public/live-logic.js";

const cwd = process.cwd();
const rule = (extra: object) => ({ name: "r", when: { moved_to: "done" }, run: "true", ...extra });
let dir: string;
let srv: RunningServer | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-timeout-"));
});
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});
const yaml = () => fs.readFileSync(path.join(dir, "kanban.yaml"), "utf8");

describe("schema", () => {
  it("accepts 0..86400 integers and absent", () => {
    expect(automationSchema.parse(rule({})).timeout).toBeUndefined();
    for (const t of [0, 1, 30, 86400]) expect(automationSchema.parse(rule({ timeout: t })).timeout).toBe(t);
  });
  it("rejects bad values with a clear message", () => {
    for (const t of [-1, 1.5, "30", "abc", null, 86401, NaN]) {
      const r = automationSchema.safeParse(rule({ timeout: t }));
      expect(r.success, String(t)).toBe(false);
      expect(JSON.stringify(r.error!.issues)).toContain("whole number of seconds from 0 to 86400");
    }
  });
});

describe("yaml round trip", () => {
  const base = "# top\ncolumns: [todo, done]\nautomations:\n  - name: r # keep\n    when: { moved_to: done }\n    run: \"true\"\n";
  it("writes only > 0, removes 0, keeps comments", () => {
    fs.writeFileSync(path.join(dir, "kanban.yaml"), base);
    const k = createKanban({ dir });
    const c = k.getConfig().config as any;
    k.updateConfig({ ...c, automations: [{ ...c.automations[0], timeout: 0 }] });
    expect(yaml()).toBe(base);
    k.updateConfig({ ...c, automations: [{ ...c.automations[0], timeout: 45 }] });
    expect(yaml()).toContain("timeout: 45");
    expect(yaml()).toContain("# keep");
    expect(yaml()).toContain("# top");
    const c2 = k.getConfig().config as any;
    expect(c2.automations[0].timeout).toBe(45);
    k.updateConfig({ ...c2, automations: [{ ...c2.automations[0], timeout: 0 }] });
    expect(yaml()).not.toContain("timeout");
    expect(yaml()).toContain("# keep");
  });
  it("rejects invalid values on save", () => {
    fs.writeFileSync(path.join(dir, "kanban.yaml"), base);
    const k = createKanban({ dir });
    const c = k.getConfig().config as any;
    for (const t of [-1, 1.5, "abc"]) {
      expect(() => k.updateConfig({ ...c, automations: [{ ...c.automations[0], timeout: t }] })).toThrow(/timeout/);
    }
    expect(yaml()).toBe(base);
  });
  it("config.updated reports a changed timeout", () => {
    fs.writeFileSync(path.join(dir, "kanban.yaml"), base);
    const evs: KbEvent[] = [];
    const k = createKanban({ dir, events: { emit: (e) => void evs.push(e) } });
    const c = k.getConfig().config as any;
    k.updateConfig({ ...c, automations: [{ ...c.automations[0], timeout: 10 }] });
    expect((evs.find((e) => e.type === "config.updated")!.data as any).automations.changed).toEqual([{ board: "default", name: "r" }]);
  });
});

describe("runner", () => {
  it("has no timeout by default", async () => {
    const reg = new LiveRuns();
    const p = createShellRunner({ registry: reg }).run("sleep 2", { cwd, env: {} });
    expect(reg.list()[0]?.timeoutMs ?? null).toBeNull();
    expect(await p).toMatchObject({ exitCode: 0 });
  });
  it("timeout kills the group incl. background child, error text, exit null", async () => {
    const reg = new LiveRuns();
    const t0 = Date.now();
    const marker = path.join(dir, "bg");
    const p = createShellRunner({ registry: reg }).run(`(sleep 30; touch ${marker}) & sleep 30`, { cwd, env: {}, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(reg.list()[0].timeoutMs).toBe(1000);
    const x = await p;
    expect(x).toMatchObject({ exitCode: null, error: "timed out after 1s", timedOut: true });
    expect(Date.now() - t0).toBeLessThan(3500);
    expect(reg.list()).toEqual([]);
  });
});

describe("dispatch", () => {
  it("passes the rule's timeout and emits timedOut data", async () => {
    fs.writeFileSync(path.join(dir, "kanban.yaml"), "columns: [todo, done]\nautomations:\n  - name: a\n    when: { moved_to: done }\n    run: x\n    timeout: 7\n  - name: b\n    when: { moved_to: done }\n    run: y\n");
    const seen: Record<string, unknown> = {};
    const runner: AutomationRunner = {
      run: async (cmd, o) => {
        seen[cmd] = o.timeoutMs;
        return cmd === "'x'" || cmd === "x" ? { exitCode: null, stdout: "", stderr: "", error: "timed out after 7s", timedOut: true } : { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const evs: KbEvent[] = [];
    const k = createKanban({ dir, runner, events: { emit: (e) => void evs.push(e) } });
    const t = k.add({ name: "T" });
    k.move(String(t.id ?? (t as any).ticket?.id ?? "1"), "done");
    await k.settled();
    expect(seen).toEqual({ x: 7000, y: undefined });
    const fin = evs.filter((e) => e.type === "automation.finished");
    expect(fin.find((e) => (e.data as any).rule === "a")!.data).toMatchObject({ status: "failed", exit: null, error: "timed out after 7s", timedOut: true, timeoutSeconds: 7 });
    expect((fin.find((e) => (e.data as any).rule === "b")!.data as any).timedOut).toBeUndefined();
  });
});

describe("test endpoint", () => {
  const call = async (body: unknown) => {
    const r = await fetch(srv!.url + "/api/automation/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as any };
  };
  beforeEach(() => fs.writeFileSync(path.join(dir, "kanban.yaml"), "columns: [todo, done]\n"));
  it("without timeout runs to the end; with timeout kills; validates", async () => {
    const live = new LiveRuns();
    srv = await startServer({ dir, port: 0, runner: createShellRunner({ registry: live }), live });
    const slow = call({ run: "sleep 1.5; echo ok" });
    await new Promise((r) => setTimeout(r, 300));
    expect(live.list()[0].timeoutMs).toBeNull();
    expect((await slow).json.result).toMatchObject({ exitCode: 0, stdout: "ok\n" });
    const t = await call({ run: "sleep 30", timeout: 1 });
    expect(t.json.result).toMatchObject({ exitCode: null, error: "timed out after 1s" });
    for (const bad of [-1, 1.5, "abc", 90000]) expect((await call({ run: "true", timeout: bad })).status).toBe(400);
    expect((await call({ run: "true", timeout: 0 })).status).toBe(200);
  }, 15000);
});

describe("ui helpers", () => {
  it("parseTimeout / label / payload / checkRules", () => {
    expect(L.parseTimeout("")).toEqual({ seconds: 0, error: "" });
    expect(L.parseTimeout("30").seconds).toBe(30);
    for (const bad of ["-1", "1.5", "abc", "86401"]) expect(L.parseTimeout(bad).error).not.toBe("");
    expect(L.timeoutLabel(30)).toBe("30s");
    expect(L.timeoutLabel(300)).toBe("5m");
    expect(L.timeoutLabel(0)).toBe("");
    expect(fmtTimeout(0)).toBe("-");
    expect(fmtTimeout(90)).toBe("90s");
    expect(fmtTimeout(7200)).toBe("2h");
    const cols = [{ orig: "done", value: "done" }];
    const r = { ...L.newRule(cols), name: "x", run: "true", column: "done" };
    expect("timeout" in L.testBody(r, "b")).toBe(false);
    expect("timeout" in L.testBody({ ...r, timeout: "0" }, "b")).toBe(false);
    expect(L.testBody({ ...r, timeout: "12" }, "b").timeout).toBe(12);
    expect(L.checkRules("b", [{ ...r, timeout: "-1" }], cols)).toMatch(/Timeout/);
    expect(L.checkRules("b", [{ ...r, timeout: "5" }], cols)).toBe("");
  });
  it("form round trip omits 0/empty, keeps value", () => {
    const f = L.configToForm({ name: "m", glob: "*.md", columns: ["done"], automations: [{ name: "a", when: { moved_to: "done" }, run: "x", timeout: 30 }, { name: "b", when: { moved_to: "done" }, run: "x" }], boards: {} });
    expect(f.automations.map((r: any) => r.timeout)).toEqual(["30", ""]);
    const p = L.formToPayload(f) as any;
    expect(p.config.automations.map((r: any) => r.timeout)).toEqual([30, undefined]);
    f.automations[0].timeout = "0";
    const p2 = L.formToPayload(f) as any;
    expect("timeout" in p2.config.automations[0]).toBe(false);
  });
  it("summary, issues, live text", () => {
    const cols = [{ orig: "done", value: "done" }];
    const r = { ...L.newRule(cols), name: "x", run: "true", column: "done" };
    expect(A.ruleSummary(r)).not.toContain("timeout");
    expect(A.ruleSummary({ ...r, timeout: "30" })).toContain("· timeout 30s");
    expect(A.ruleSummary({ ...r, timeout: "0" })).not.toContain("timeout");
    expect(A.ruleIssues({ ...r, timeout: "1.5" }, [], cols).timeout).toBeTruthy();
    expect(A.ruleIssues({ ...r, timeout: "" }, [], cols).timeout).toBeUndefined();
    expect(V.timeoutText(5000, null)).toBe("no timeout");
    expect(V.timeoutText(5000, 30000)).toMatch(/left/);
    expect(V.hasTimeout(null)).toBe(false);
  });
});
