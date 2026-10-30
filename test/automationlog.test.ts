import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAutomationLog } from "../src/automationLog.js";
import type { AutomationRecord } from "../src/core/automation.js";

let dir: string;
beforeEach(() => void (dir = fs.mkdtempSync(path.join(os.tmpdir(), "kblog-"))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const rec = (n: number, out = ""): AutomationRecord => ({
  board: "main", rule: `r${n}`, ticketId: n, path: "a.md",
  event: { type: "moved_to", to: "done" }, command: "x",
  startedAt: "s", finishedAt: "f", status: "done",
  result: { exitCode: 0, stdout: out, stderr: out },
});
const file = () => path.join(dir, ".kb", "automation.log");

describe("automation log", () => {
  it("empty when no file", () => expect(createAutomationLog(dir).recent()).toEqual([]));
  it("appends newest last, recent newest first", () => {
    const l = createAutomationLog(dir);
    for (let i = 1; i <= 3; i++) l.append(rec(i));
    expect(l.recent().map((r) => r.rule)).toEqual(["r3", "r2", "r1"]);
    expect(l.recent(2).map((r) => r.rule)).toEqual(["r3", "r2"]);
    expect(fs.readFileSync(file(), "utf8").trim().split("\n")[2]).toContain("r3");
  });
  it("truncates output to 4KB", () => {
    const l = createAutomationLog(dir);
    l.append(rec(1, "x".repeat(10000)));
    const r = l.recent()[0];
    expect(r.result.stdout.length).toBeLessThan(4200);
    expect(r.result.stderr).toContain("[truncated]");
  });
  it("rotates past 256KB keeping last 200", () => {
    const l = createAutomationLog(dir);
    for (let i = 0; i < 400; i++) l.append(rec(i, "y".repeat(500)));
    const lines = fs.readFileSync(file(), "utf8").trim().split("\n");
    expect(lines.length).toBeLessThan(400);
    expect(lines.length).toBeGreaterThanOrEqual(200);
    expect(fs.statSync(file()).size).toBeLessThan(256 * 1024 + 2048);
    expect(l.recent(1)[0].rule).toBe("r399");
  });
  it("tolerates corrupt lines", () => {
    const l = createAutomationLog(dir);
    l.append(rec(1));
    fs.appendFileSync(file(), "{not json\n\n");
    l.append(rec(2));
    expect(l.recent().map((r) => r.rule)).toEqual(["r2", "r1"]);
  });
});
