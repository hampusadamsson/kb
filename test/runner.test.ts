import { describe, expect, it } from "vitest";
import { createShellRunner } from "../src/runner.js";

const cwd = process.cwd();
const r = createShellRunner({ timeoutMs: 5000 });

describe("shell runner", () => {
  it("captures stdout", async () => {
    expect(await r.run("echo hi", { cwd, env: {} })).toMatchObject({ exitCode: 0, stdout: "hi\n", stderr: "" });
  });
  it("exit code and stderr", async () => {
    const x = await r.run("echo bad >&2; exit 3", { cwd, env: {} });
    expect(x.exitCode).toBe(3);
    expect(x.stderr).toBe("bad\n");
    expect(x.error).toBeUndefined();
  });
  it("times out", async () => {
    const t0 = Date.now();
    const x = await createShellRunner({ timeoutMs: 200 }).run("sleep 5", { cwd, env: {} });
    expect(x.exitCode).toBeNull();
    expect(x.error).toBe("timed out after 0.2s");
    expect(Date.now() - t0).toBeLessThan(3000);
  });
  it("caps output", async () => {
    const x = await r.run("head -c 200000 /dev/zero | tr '\\0' a", { cwd, env: {} });
    expect(x.stdout.length).toBeLessThan(70000);
    expect(x.stdout).toContain("[output truncated]");
  });
  it("passes env and cwd", async () => {
    const x = await r.run('echo "$KB_AUTOMATION $FOO"; pwd', { cwd: "/tmp", env: { KB_AUTOMATION: "1", FOO: "bar" } });
    expect(x.stdout.split("\n")[0]).toBe("1 bar");
    expect(x.stdout).toMatch(/tmp/);
  });
  it("handles a 2MB command", async () => {
    const x = await r.run(`printf %s '${"x".repeat(2_000_000)}' | wc -c`, { cwd, env: {} });
    expect(x.error).toBeUndefined();
    expect(x.stdout.trim()).toBe("2000000");
  });
  it("returns promptly when a script backgrounds a process", async () => {
    const t0 = Date.now();
    const x = await createShellRunner({ timeoutMs: 3000 }).run("sleep 2 &", { cwd, env: {} });
    expect(x.exitCode).toBe(0);
    expect(x.error).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it("keeps output written before exit", async () => {
    const x = await r.run("echo a; echo b >&2; sleep 2 &", { cwd, env: {} });
    expect(x).toMatchObject({ exitCode: 0, stdout: "a\n", stderr: "b\n" });
  });
  it("killAll kills running scripts", async () => {
    const k = createShellRunner({ timeoutMs: 10000 });
    const t0 = Date.now();
    const p = k.run("sleep 5", { cwd, env: {} });
    await new Promise((res) => setTimeout(res, 150));
    k.killAll();
    const x = await p;
    expect(x.exitCode).toBeNull();
    expect(x.error).toMatch(/killed by SIGKILL/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it("never rejects on bad cwd", async () => {
    const x = await r.run("true", { cwd: "/nonexistent-dir-xyz", env: {} });
    expect(x.exitCode).toBeNull();
    expect(x.error).toBeTruthy();
  });
});
