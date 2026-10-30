import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { KbEvent } from "../src/core/index.js";
import { createEventLog } from "../src/eventLog.js";

let dir: string;
beforeEach(() => void (dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-evlog-"))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

let n = 0;
const ev = (o: Partial<KbEvent> = {}): KbEvent => {
  n++;
  return {
    id: String(n).padStart(8, "0"),
    ts: "2026-01-01T00:00:00.000+00:00",
    type: "ticket.moved",
    source: "cli",
    summary: `event ${n}`,
    data: {},
    ...o,
  };
};

describe("event log", () => {
  it("appends and queries newest first; creates .kb", () => {
    const log = createEventLog(dir);
    expect(log.query().events).toEqual([]);
    const a = ev();
    const b = ev();
    log.emit(a);
    log.emit(b);
    expect(fs.existsSync(path.join(dir, ".kb", "events.log"))).toBe(true);
    expect(log.query().events.map((e) => e.id)).toEqual([b.id, a.id]);
  });

  it("supports trailing .* prefix wildcard in type", () => {
    const log = createEventLog(dir);
    const a = ev({ type: "ticket.moved" });
    const b = ev({ type: "config.updated" });
    const c = ev({ type: "ticket.labels" });
    for (const e of [a, b, c]) log.emit(e);
    expect(log.query({ type: "ticket.*" }).events.map((e) => e.id)).toEqual([c.id, a.id]);
    expect(log.query({ type: ["config.*", "ticket.moved"] }).events.map((e) => e.id)).toEqual([b.id, a.id]);
    expect(log.query({ type: "ticket" }).events).toEqual([]);
  });

  it("paginates with cursor across many events", () => {
    const log = createEventLog(dir);
    const all = Array.from({ length: 130 }, () => ev());
    for (const e of all) log.emit(e);
    const seen: string[] = [];
    let before: string | undefined;
    let pages = 0;
    do {
      const r = log.query({ limit: 50, before });
      seen.push(...r.events.map((e) => e.id));
      before = r.nextCursor;
      pages++;
    } while (before);
    expect(pages).toBe(3);
    expect(seen).toEqual(all.map((e) => e.id).reverse());
    expect(log.query({ limit: 130 }).nextCursor).toBeUndefined();
    expect(log.query({ limit: 9999 }).events).toHaveLength(130);
  });

  it("searches across fields case-insensitively", () => {
    const log = createEventLog(dir);
    log.emit(ev({ summary: "plain" }));
    log.emit(ev({ ticketName: "Needle Name" }));
    log.emit(ev({ board: "Haystack" }));
    log.emit(ev({ ticketId: "ABC9" }));
    log.emit(ev({ data: { deep: { v: "Zed" } } }));
    log.emit(ev({ type: "ticket.comment" }));
    const q = (s: string) => log.query({ q: s }).events.length;
    expect(q("needle")).toBe(1);
    expect(q("HAYSTACK")).toBe(1);
    expect(q("abc9")).toBe(1);
    expect(q("zed")).toBe(1);
    expect(q("ticket.comment")).toBe(1);
    expect(q("plain")).toBe(1);
    expect(q("nothing-here")).toBe(0);
  });

  it("filters by type(s), ticket, board, source", () => {
    const log = createEventLog(dir);
    log.emit(ev({ type: "ticket.created", ticketId: "1", board: "x", source: "web" }));
    log.emit(ev({ type: "ticket.moved", ticketId: "1", board: "y" }));
    log.emit(ev({ type: "ticket.moved", ticketId: "2", board: "x", source: "automation" }));
    expect(log.query({ type: "ticket.moved" }).events).toHaveLength(2);
    expect(log.query({ type: ["ticket.moved", "ticket.created"] }).events).toHaveLength(3);
    expect(log.query({ ticketId: "1" }).events).toHaveLength(2);
    expect(log.query({ board: "x" }).events).toHaveLength(2);
    expect(log.query({ source: "automation" }).events).toHaveLength(1);
    expect(log.query({ board: "x", source: "web" }).events).toHaveLength(1);
  });

  it("rotates at 5 MB and reads across both files", () => {
    const log = createEventLog(dir);
    const big = "z".repeat(7000);
    const all: KbEvent[] = [];
    for (let i = 0; i < 800; i++) {
      const e = ev({ data: { pad: big } });
      all.push(e);
      log.emit(e);
    }
    const folder = path.join(dir, ".kb");
    expect(fs.existsSync(path.join(folder, "events.1.log"))).toBe(true);
    expect(fs.statSync(path.join(folder, "events.log")).size).toBeGreaterThan(0);
    const seen: string[] = [];
    let before: string | undefined;
    for (;;) {
      const r = log.query({ limit: 200, before });
      seen.push(...r.events.map((e) => e.id));
      if (!r.nextCursor) break;
      before = r.nextCursor;
    }
    expect(seen).toEqual(all.map((e) => e.id).reverse());
  });

  it("tolerates corrupt lines", () => {
    const log = createEventLog(dir);
    const a = ev();
    log.emit(a);
    fs.appendFileSync(path.join(dir, ".kb", "events.log"), "{not json\n\n[1,2]\n{\"x\":1}\n");
    const b = ev();
    log.emit(b);
    expect(log.query().events.map((e) => e.id)).toEqual([b.id, a.id]);
  });
});

describe("event log robustness", () => {
  it("cursor pagination is correct when file order differs from id order", () => {
    const log = createEventLog(dir);
    const ids = ["b", "a", "d", "c", "f", "e"].map((s) => s.padStart(8, "0"));
    for (const id of ids) log.emit(ev({ id }));
    const seen: string[] = [];
    let before: string | undefined;
    for (;;) {
      const r = log.query({ before, limit: 2 });
      seen.push(...r.events.map((e) => e.id));
      if (!r.nextCursor) break;
      before = r.nextCursor;
    }
    expect(seen).toEqual([...ids].sort().reverse());
  });

  it("clips oversized events to a bounded line", () => {
    const log = createEventLog(dir);
    log.emit(ev({ summary: "x".repeat(50_000), data: { big: "y".repeat(50_000) } }));
    const line = fs.readFileSync(path.join(dir, ".kb", "events.log"), "utf8");
    expect(line.length).toBeLessThan(2000);
    expect(log.query().events[0].data).toEqual({ truncated: true });
  });
});
