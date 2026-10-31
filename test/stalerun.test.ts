import { describe, expect, it } from "vitest";
import { buildAutomationOverview, isStaleRun, STALE_RUNNING_MS } from "../src/core/automation.js";
import type { Config } from "../src/core/config.js";
import type { Ticket } from "../src/core/tickets.js";

const AT = "2026-10-30T10:00:00";
const atMs = new Date(AT).getTime();
const NOW = atMs + 60_000;

const config: Config = {
  name: "default",
  columns: ["todo", "done"],
  glob: "*.md",
  automations: [{ name: "agent", when: { moved_to: "done" }, run: "pi -p hi" }],
};

const ticket = (automations: Record<string, unknown>): Ticket => ({
  path: "a.md",
  id: "1",
  name: "A",
  status: "done",
  column: "done",
  board: "default",
  labels: [],
  comments: {},
  props: {},
  body: "",
  raw: "",
  data: { id: "1", name: "A", status: "done", automations },
  mtime: 0,
});

const running = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  agent: { status: "running", at: AT, runs: 1, ...extra },
});

describe("isStaleRun", () => {
  it("a live pid is never stale, however old the entry", () => {
    const ent = { status: "running", at: AT, pid: 42 };
    const longAfter = atMs + STALE_RUNNING_MS * 100; // hours
    expect(isStaleRun(ent, atMs, longAfter, { isAlive: () => true, localHost: "h" })).toBe(false);
  });

  it("a dead pid is stale even when the entry is recent", () => {
    const ent = { status: "running", at: AT, pid: 42 };
    expect(isStaleRun(ent, atMs, NOW, { isAlive: () => false, localHost: "h" })).toBe(true);
  });

  it("falls back to age when no pid/probe/host match", () => {
    expect(isStaleRun({ at: AT }, atMs, NOW)).toBe(false);
    expect(isStaleRun({ at: AT }, atMs, atMs + STALE_RUNNING_MS + 1)).toBe(true);
    // pid recorded on another host cannot be probed here → age decides
    expect(isStaleRun({ at: AT, pid: 42, host: "other" }, atMs, NOW, { isAlive: () => false, localHost: "here" })).toBe(false);
    expect(
      isStaleRun({ at: AT, pid: 42, host: "other" }, atMs, atMs + STALE_RUNNING_MS + 1, { isAlive: () => true, localHost: "here" }),
    ).toBe(true);
  });
});

describe("buildAutomationOverview liveness", () => {
  it("keeps a long-running run in `live` so it stays killable", () => {
    const longAfter = atMs + STALE_RUNNING_MS * 10;
    const ov = buildAutomationOverview(config, [ticket(running({ pid: 42, pgid: 42, host: "h" }))], ["default"], longAfter, {
      isAlive: () => true,
      localHost: "h",
    });
    expect(ov.live).toHaveLength(1);
    expect(ov.live[0]).toMatchObject({ rule: "agent", pid: 42, pgid: 42 });
    expect(ov.rules[0].counts.stale).toBe(0);
    expect(ov.rules[0].counts.running).toBe(1);
  });

  it("drops a run whose process is gone", () => {
    const ov = buildAutomationOverview(config, [ticket(running({ pid: 42, host: "h" }))], ["default"], NOW, {
      isAlive: () => false,
      localHost: "h",
    });
    expect(ov.live).toEqual([]);
    expect(ov.rules[0].counts.stale).toBe(1);
  });

  it("without a probe, keeps the old age-based behaviour", () => {
    const fresh = buildAutomationOverview(config, [ticket(running({ pid: 42 }))], ["default"], NOW);
    expect(fresh.live).toHaveLength(1);
    const old = buildAutomationOverview(config, [ticket(running({ pid: 42 }))], ["default"], atMs + STALE_RUNNING_MS + 1);
    expect(old.live).toEqual([]);
  });
});
