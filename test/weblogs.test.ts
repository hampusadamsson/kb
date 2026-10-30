import { describe, expect, it } from "vitest";
import * as L from "../src/web/public/logs-logic.js";

const ev = (id: string, type = "ticket.moved", data: any = {}) => ({ id, ts: "2026-01-01T10:00:00.000+00:00", type, source: "cli", summary: "s", data });

describe("logs-logic", () => {
  it("maps filters to type params", () => {
    expect(L.typeParam("all")).toBe("");
    expect(L.typeParam("tickets")).toBe("ticket.*");
    expect(L.typeParam("moves")).toBe("ticket.moved");
    expect(L.typeParam("automations")).toBe("automation.*");
    expect(L.typeParam("ids")).toBe("ids.fixed");
    expect(L.typeParam("nope")).toBe("");
  });
  it("builds query strings", () => {
    expect(L.buildQuery({})).toBe("limit=50");
    const p = new URLSearchParams(L.buildQuery({ q: " foo ", type: "tickets", source: "web", board: "b", before: "x1" }));
    expect(Object.fromEntries(p)).toEqual({ q: "foo", type: "ticket.*", source: "web", board: "b", before: "x1", limit: "50" });
    expect(L.buildQuery({ source: "all", board: "all", type: "all", q: "  " })).toBe("limit=50");
    expect(L.isUnfiltered({ q: " ", type: "all", source: "all" })).toBe(true);
    expect(L.isUnfiltered({ type: "moves" })).toBe(false);
  });
  it("merges by id newest first without duplicates", () => {
    const cur = [ev("c"), ev("b"), ev("a")];
    expect(L.mergeById(cur, [ev("e"), ev("d"), ev("c")]).map((e) => e.id)).toEqual(["e", "d", "c", "b", "a"]);
    expect(L.mergeById(cur, [])).toEqual(cur);
    expect(L.appendPage(cur, [ev("a"), ev("0")]).map((e) => e.id)).toEqual(["c", "b", "a", "0"]);
  });
  it("picks pill classes", () => {
    expect(L.pillClass(ev("1", "ticket.labels"))).toBe("ticket");
    expect(L.pillClass(ev("1", "config.updated"))).toBe("config");
    expect(L.pillClass(ev("1", "ids.fixed"))).toBe("ids");
    expect(L.pillClass(ev("1", "automation.finished", { status: "done" }))).toBe("auto-ok");
    expect(L.pillClass(ev("1", "automation.finished", { status: "failed" }))).toBe("auto-fail");
    expect(L.pillClass(ev("1", "automation.skipped"))).toBe("auto-skip");
    expect(L.pillClass(ev("1", "automation.started"))).toBe("auto-start");
  });
  it("formats relative and absolute time", () => {
    const now = new Date(2026, 0, 1, 12, 0, 0);
    const at = (ms: number) => new Date(+now - ms).toISOString();
    expect(L.relativeTime(at(10_000), now)).toBe("just now");
    expect(L.relativeTime(at(2 * 60_000), now)).toBe("2 min ago");
    expect(L.relativeTime(at(2 * 3600_000), now)).toBe("2 h ago");
    expect(L.relativeTime(new Date(2025, 11, 31, 20).toISOString(), now)).toBe("yesterday");
    expect(L.relativeTime(new Date(2025, 11, 20, 20).toISOString(), now)).toBe("2025-12-20");
    expect(L.relativeTime("junk", now)).toBe("");
    expect(L.absoluteTime(new Date(2026, 0, 1, 9, 5, 7).toISOString())).toBe("2026-01-01 09:05:07");
  });
  it("formats data entries", () => {
    expect(L.dataEntries({ a: 1, b: "x", c: null, d: { k: [1] }, e: "l1\nl2" })).toEqual([
      { key: "a", value: "1", pre: false },
      { key: "b", value: "x", pre: false },
      { key: "c", value: "null", pre: false },
      { key: "d", value: '{\n  "k": [\n    1\n  ]\n}', pre: true },
      { key: "e", value: "l1\nl2", pre: true },
    ]);
    expect(L.dataEntries(undefined)).toEqual([]);
  });
  it("texts", () => {
    expect(L.countText(1)).toBe("Showing 1 event");
    expect(L.countText(50)).toBe("Showing 50 events");
    expect(L.noMatchText({ q: "zz", type: "moves", source: "web" })).toBe('No events match "zz", moves, source web.');
  });
});
