import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { automationExposureWarning, runWeb, type WebIO } from "../src/cli/commands/web.js";
import { createKanban } from "../src/core/index.js";
import type { RunningServer } from "../src/web/server.js";

const dirs: string[] = [];
const servers: { close(): Promise<void> }[] = [];
function tmp(init = true): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "kbweb-"));
  dirs.push(d);
  if (init) createKanban({ dir: d }).init();
  return d;
}
function io() {
  const out: string[] = [], err: string[] = [], opened: string[] = [];
  const i: WebIO = { out: (s) => out.push(s), err: (s) => err.push(s), opener: (u) => opened.push(u) };
  return { i, out, err, opened };
}
async function start(dir: string, o: Parameters<typeof runWeb>[1], i: WebIO): Promise<RunningServer> {
  const s = await runWeb(dir, o, i);
  servers.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("runWeb", () => {
  it("prints URL, no warning on loopback, opener respects --no-open", async () => {
    const t = io();
    const s = await start(tmp(), { port: 0, open: false }, t.i);
    expect(t.out).toEqual([`kb web running at http://127.0.0.1:${s.port}`]);
    expect(t.err).toEqual([]);
    expect(t.opened).toEqual([]);
  });
  it("opens browser by default", async () => {
    const t = io();
    const s = await start(tmp(), { port: 0 }, t.i);
    expect(t.opened).toEqual([`http://127.0.0.1:${s.port}`]);
  });
  it("warns on non-loopback host", async () => {
    const t = io();
    const s = await start(tmp(), { host: "0.0.0.0", port: 0, open: false }, t.i);
    expect(t.out[0]).toBe(`kb web running at http://localhost:${s.port}`);
    expect(t.out[1]).toBe(`listening on 0.0.0.0:${s.port}`);
    expect(t.err[0]).toBe(`warning: no auth — anyone who can reach 0.0.0.0:${s.port} can read and edit your tickets`);
  });
  it("warns about unauthenticated automations on non-loopback", async () => {
    const t = io();
    await start(tmp(), { host: "0.0.0.0", port: 0, open: false }, t.i);
    expect(t.err[1]).toBe(automationExposureWarning("0.0.0.0", true));
    const q = io();
    await start(tmp(), { host: "0.0.0.0", port: 0, open: false, automation: false }, q.i);
    expect(q.err).toHaveLength(1);
  });
  it("automationExposureWarning decides", () => {
    expect(automationExposureWarning("127.0.0.1", true)).toBeUndefined();
    expect(automationExposureWarning("localhost", true)).toBeUndefined();
    expect(automationExposureWarning("0.0.0.0", false)).toBeUndefined();
    expect(automationExposureWarning("0.0.0.0", true)).toBe(
      "warning: listening on 0.0.0.0 without authentication; automations can run commands on this machine. Use --no-automation to disable.",
    );
  });
  it("shutdown closes and returns", async () => {
    const s = await runWeb(tmp(), { port: 0, open: false }, io().i);
    await s.shutdown(200);
  });
  it("errors without config", async () => {
    await expect(runWeb(tmp(false), { port: 0, open: false }, io().i)).rejects.toThrow(/kb init/);
  });
  it("errors on invalid port", async () => {
    for (const p of ["abc", "-1", "70000", "1.5", ""]) {
      await expect(runWeb(tmp(), { port: p, open: false }, io().i)).rejects.toThrow(/invalid port/);
    }
  });
  it("busy port: explicit errors, default auto-increments", async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const busy = (blocker.address() as net.AddressInfo).port;
    try {
      await expect(runWeb(tmp(), { port: busy, open: false }, io().i)).rejects.toThrow(/in use/);
      // auto-increment path: server default start is 4747; occupy it if free
      const b2 = net.createServer();
      const got = await new Promise<boolean>((r) => {
        b2.once("error", () => r(false));
        b2.listen(4747, "127.0.0.1", () => r(true));
      });
      try {
        const s = await start(tmp(), { open: false }, io().i);
        if (got) expect(s.port).toBeGreaterThan(4747);
        else expect(s.port).toBeGreaterThanOrEqual(4747);
      } finally {
        if (got) await new Promise((r) => b2.close(r));
      }
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });
});

describe("kb web e2e", () => {
  it("serves and exits 0 on SIGINT", async () => {
    const dir = tmp();
    const main = path.resolve(import.meta.dirname, "../dist/cli/main.js");
    const child = spawn(process.execPath, [main, "web", "--no-open", "--port", "0"], { cwd: dir });
    let out = "";
    const url = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout: " + out)), 10000);
      child.stdout.on("data", (d: Buffer) => {
        out += d;
        const m = /running at (http:\/\/\S+)/.exec(out);
        if (m) { clearTimeout(t); resolve(m[1]); }
      });
      child.on("exit", () => reject(new Error("exited early: " + out)));
    });
    expect(url).not.toMatch(/:0$/);
    const res = await fetch(`${url}/api/board`);
    expect(res.status).toBe(200);
    const exit = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    child.kill("SIGINT");
    expect(await exit).toBe(0);
  }, 20000);
});
