import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createShellRunner } from "../src/runner.js";
import { createAutomationLog } from "../src/automationLog.js";
import { startServer, type RunningServer } from "../src/web/server.js";

let dir: string;
let srv: RunningServer | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-webauto-"));
  fs.writeFileSync(path.join(dir, "kanban.yaml"), "columns: [todo, done]\n");
});
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

const start = async (runner = true) => {
  srv = await startServer({ dir, port: 0, runner: runner ? createShellRunner() : undefined, log: createAutomationLog(dir) });
};
const call = async (method: string, body?: unknown) => {
  const r = await fetch(srv!.url + "/api/automation/test", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as any };
};

describe("POST /api/automation/test", () => {
  it("renders and runs with the sample ticket", async () => {
    await start();
    const r = await call("POST", { run: "echo {{ id }} {{ name }} $KB_AUTOMATION; pwd" });
    expect(r.status).toBe(200);
    expect(r.json.command).toBe("echo '000' 'Sample ticket' $KB_AUTOMATION; pwd");
    expect(r.json.result.exitCode).toBe(0);
    expect(r.json.result.stdout).toContain("000 Sample ticket 1");
    expect(r.json.result.stdout).toContain(fs.realpathSync(dir));
    expect(fs.existsSync(path.join(dir, ".kb", "automation.log"))).toBe(false);
  });

  it("quotes a hostile sample name", async () => {
    await start();
    const name = "x'; touch pwned; echo '";
    const r = await call("POST", { run: "echo {{ name }}", sample: { name } });
    expect(r.status).toBe(200);
    expect(r.json.command).toBe(`echo 'x'\\''; touch pwned; echo '\\'''`);
    expect(r.json.result.stdout.trim()).toBe(name);
    expect(fs.existsSync(path.join(dir, "pwned"))).toBe(false);
  });

  it("400 on unknown variable and empty run", async () => {
    await start();
    expect((await call("POST", { run: "echo {{ nope }}" })).status).toBe(400);
    expect((await call("POST", { run: "  " })).status).toBe(400);
    expect((await call("POST", {})).status).toBe(400);
  });

  it("503 disabled without a runner", async () => {
    await start(false);
    const r = await call("POST", { run: "echo hi" });
    expect(r.status).toBe(503);
    expect(r.json.code).toBe("disabled");
  });

  it("405 on wrong method", async () => {
    await start();
    expect((await call("GET")).status).toBe(405);
  });
});

describe("test-run concurrency", () => {
  it("rejects a 3rd concurrent test run with 429 busy", async () => {
    await start();
    const slow = () => call("POST", { run: "sleep 1" });
    const a = slow(),
      b = slow();
    await new Promise((r) => setTimeout(r, 300));
    const c = await call("POST", { run: "echo hi" });
    expect(c.status).toBe(429);
    expect(c.json.code).toBe("busy");
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
    expect((await call("POST", { run: "echo hi" })).status).toBe(200);
  });
});
