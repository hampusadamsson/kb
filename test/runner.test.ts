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
    expect(x.error).toBe("timeout after 0.2s");
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
  it("never rejects on bad cwd", async () => {
    const x = await r.run("true", { cwd: "/nonexistent-dir-xyz", env: {} });
    expect(x.exitCode).toBeNull();
    expect(x.error).toBeTruthy();
  });
});
