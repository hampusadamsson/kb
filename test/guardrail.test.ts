import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createKanban, type KbEvent } from "../src/core/index.js";
import { AUTOMATION_RUN_LIMIT, entryRuns, totalRuns, type AutomationRunner } from "../src/core/automation.js";
import { readFile } from "../src/core/frontmatter.js";
import { startServer } from "../src/web/server.js";

let dir: string;
let evs: KbEvent[];
const runner: AutomationRunner = { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
const cfg = (guard = "") => `columns: [todo, done]\nautomations:\n  - name: r\n    when: { moved_to: done }\n    run: "true"\n${guard}`;
const mk = () => createKanban({ dir, runner, events: { emit: (e) => void evs.push(e) } });
const autos = (f: string) => (readFile(path.join(dir, f)).doc.toJS() as any).automations;
const file = () => fs.readdirSync(dir).find((f) => f.endsWith(".md"))!;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-guard-"));
  evs = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

async function bounce(k: ReturnType<typeof mk>, id: string, n: number) {
  for (let i = 0; i < n; i++) {
    k.move(id, "todo");
    k.move(id, "done");
    await k.settled();
  }
}

describe("loop guardrail", () => {
  it("helpers", () => {
    expect(AUTOMATION_RUN_LIMIT).toBe(15);
    expect(entryRuns({ status: "done" })).toBe(1);
    expect(entryRuns({ runs: 4 })).toBe(4);
    expect(totalRuns({ a: { runs: 3 }, b: { status: "done" } })).toBe(4);
    expect(totalRuns(undefined)).toBe(0);
  });

  it("counts runs, blocks at the limit with skipped status + event", async () => {
    fs.writeFileSync(path.join(dir, "kanban.yaml"), cfg());
    const k = mk();
    const { id } = k.add({ name: "A" });
    await bounce(k, id, 3);
    expect(autos(file()).r).toMatchObject({ status: "done", runs: 3 });
    await bounce(k, id, 12);
    expect(autos(file()).r.runs).toBe(15);
    evs = [];
    await bounce(k, id, 1);
    const e = autos(file()).r;
    expect(e).toMatchObject({ status: "skipped", runs: 15, reason: "guardrail: 15 automation runs on this ticket" });
    const sk = evs.filter((x) => x.type === "automation.skipped");
    expect(sk).toHaveLength(1);
    expect(sk[0].data).toMatchObject({ rule: "r", reason: "guardrail", runs: 15 });
    expect(evs.some((x) => x.type === "automation.started")).toBe(false);
  });

  it("guard: false keeps running; entries without runs count as 1", async () => {
    fs.writeFileSync(path.join(dir, "kanban.yaml"), cfg("    guard: false\n"));
    const k = mk();
    const { id } = k.add({ name: "A" });
    await bounce(k, id, 17);
    expect(autos(file()).r).toMatchObject({ status: "done", runs: 17 });
  });

  it("back-compat entry without runs", async () => {
    fs.writeFileSync(path.join(dir, "kanban.yaml"), cfg());
    const k = mk();
    const { id } = k.add({ name: "A" });
    const f = path.join(dir, file());
    const extra = Array.from({ length: 15 }, (_, i) => `  old${i}: { status: done, at: "2026-01-01T00:00:00" }\n`).join("");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("---\n", `---\nautomations:\n${extra}`));
    // the first '---' replaced above is the opening one
    await bounce(k, id, 1);
    expect(autos(file()).r.status).toBe("skipped");
  });

  it("reset clears history, emits event, triggers nothing", async () => {
    fs.writeFileSync(path.join(dir, "kanban.yaml"), cfg());
    const k = mk();
    const { id } = k.add({ name: "A" });
    await bounce(k, id, 2);
    evs = [];
    k.update(id, { resetAutomations: true });
    await k.settled();
    expect(autos(file())).toBeUndefined();
    expect(evs.map((e) => e.type)).toEqual(["ticket.automations-reset"]);
    await bounce(k, id, 1);
    expect(autos(file()).r.runs).toBe(1);
  });

  it("guard serializes only when false; settings round-trip", () => {
    fs.writeFileSync(path.join(dir, "kanban.yaml"), cfg());
    const k = mk();
    const c = k.getConfig().config as any;
    expect(c.automations[0].guard).toBeUndefined();
    k.updateConfig({ ...c, automations: [{ ...c.automations[0], guard: false }] });
    expect(fs.readFileSync(path.join(dir, "kanban.yaml"), "utf8")).toContain("guard: false");
    expect((k.getConfig().config as any).automations[0].guard).toBe(false);
    const c2 = k.getConfig().config as any;
    k.updateConfig({ ...c2, automations: [{ ...c2.automations[0], guard: undefined }] });
    expect(fs.readFileSync(path.join(dir, "kanban.yaml"), "utf8")).not.toContain("guard");
  });

  it("API PATCH resetAutomations", async () => {
    fs.writeFileSync(path.join(dir, "kanban.yaml"), cfg());
    fs.writeFileSync(
      path.join(dir, "1.md"),
      `---\ntype: ticket\nid: 1\nname: A\nstatus: todo\nautomations:\n  r: { status: done, runs: 3 }\n---\nb\n`,
    );
    const srv = await startServer({ dir, port: 0 });
    try {
      const r = await fetch(srv.url + "/api/tickets/1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resetAutomations: true }),
      });
      expect(r.status).toBe(200);
      expect(autos("1.md")).toBeUndefined();
    } finally {
      await srv.close();
    }
  });

  it("CLI kb set --reset-automations", () => {
    fs.writeFileSync(path.join(dir, "kanban.yaml"), cfg());
    fs.writeFileSync(
      path.join(dir, "1.md"),
      `---\ntype: ticket\nid: 1\nname: A\nstatus: todo\nautomations:\n  r: { status: done, runs: 3 }\n---\nb\n`,
    );
    const main = path.resolve(import.meta.dirname, "../dist/cli/main.js");
    const r = spawnSync("node", [main, "set", "1", "--reset-automations"], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(autos("1.md")).toBeUndefined();
  });
});

describe("loop guardrail: two rules on one ticket", () => {
  it("counts every run of rules firing together (no lost increments)", async () => {
    fs.writeFileSync(
      path.join(dir, "kanban.yaml"),
      `columns: [todo, done]\nautomations:\n  - name: r1\n    when: { moved_to: done }\n    run: "true"\n  - name: r2\n    when: { moved_to: done }\n    run: "true"\n`,
    );
    const k = mk();
    const { id } = k.add({ name: "A" });
    await bounce(k, id, 4);
    const a = autos(file());
    expect(a.r1.runs).toBe(4);
    expect(a.r2.runs).toBe(4);
  });

  it("never exceeds the limit when several rules fire in one dispatch", async () => {
    const rules = [1, 2, 3, 4].map((i) => `  - name: r${i}\n    when: { moved_to: done }\n    run: "true"\n`).join("");
    fs.writeFileSync(path.join(dir, "kanban.yaml"), `columns: [todo, done]\nautomations:\n${rules}`);
    const k = mk();
    const { id } = k.add({ name: "A" });
    await bounce(k, id, 6);
    expect(totalRuns(autos(file()))).toBe(AUTOMATION_RUN_LIMIT);
  });
});
