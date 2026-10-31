import { describe, expect, it } from "vitest";
import * as L from "../src/web/public/live-logic.js";

describe("live-logic", () => {
  it("formatElapsed", () => {
    expect(L.formatElapsed(0)).toBe("00:00");
    expect(L.formatElapsed(65_900)).toBe("01:05");
    expect(L.formatElapsed(3_725_000)).toBe("1:02:05");
    expect(L.formatElapsed(-5)).toBe("00:00");
    expect(L.formatElapsed(NaN)).toBe("00:00");
  });
  it("progressFraction", () => {
    expect(L.progressFraction(15_000, 30_000)).toBe(0.5);
    expect(L.progressFraction(40_000, 30_000)).toBe(1);
    expect(L.progressFraction(10, 0)).toBe(0);
    expect(L.progressFraction(-1, 30_000)).toBe(0);
  });
  it("timeoutText", () => {
    expect(L.timeoutText(5_000, 30_000)).toBe("00:25 left");
    expect(L.timeoutText(31_000, 30_000)).toBe("timing out");
  });
  it("sortRuns newest first, stable, no mutation", () => {
    const a = { runId: "a", startedAt: "2026-01-01T10:00:00+01:00" };
    const b = { runId: "b", startedAt: "2026-01-01T10:00:05+01:00" };
    const c = { runId: "c", startedAt: "2026-01-01T10:00:05+01:00" };
    const input = [a, b, c];
    expect(L.sortRuns(input).map((r) => r.runId)).toEqual(["b", "c", "a"]);
    expect(input[0]).toBe(a);
  });
  it("labels and texts", () => {
    const r = { runId: "1", kind: "rule", rule: "build", ticketId: "7" };
    expect(L.runTitle(r)).toBe("build");
    expect(L.runTitle({ kind: "test" })).toBe("Test run");
    expect(L.killLabel(r)).toBe("Kill automation build on #7");
    expect(L.killConfirm(r)).toBe(
      'Kill automation "build" on #7? The process and its children are terminated; the ticket is marked failed.',
    );
    expect(L.liveLabel(0)).toBe("Live");
    expect(L.liveLabel(2)).toBe("Live (2)");
  });
  it("announce", () => {
    const a = { runId: "a", kind: "rule", rule: "x" };
    const b = { runId: "b", kind: "test" };
    expect(L.announce([], [a])).toBe("x started");
    expect(L.announce([a], [])).toBe("x finished");
    expect(L.announce([a], [a])).toBe("");
    expect(L.announce([a], [b])).toBe("1 started, 1 finished");
  });
});
