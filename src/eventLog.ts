import fs from "node:fs";
import path from "node:path";
import type { EventSink, KbEvent } from "./core/events.js";

/** Rotate when events.log exceeds this; one old file (events.1.log) is kept. */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export interface EventQuery {
  /** case-insensitive substring over summary, type, ticketId, ticketName, board and JSON of data */
  q?: string;
  /** exact type(s); a trailing ".*" matches a prefix, e.g. "ticket.*" */
  type?: string | string[];
  ticketId?: string;
  board?: string;
  source?: string;
  /** event id cursor: only events older than this id */
  before?: string;
  /** default 50, max 200 */
  limit?: number;
}

export interface EventPage {
  /** newest first */
  events: KbEvent[];
  nextCursor?: string;
}

export interface EventLog extends EventSink {
  query(q?: EventQuery): EventPage;
}

const isEvent = (v: unknown): v is KbEvent =>
  !!v && typeof v === "object" && typeof (v as KbEvent).id === "string" && typeof (v as KbEvent).type === "string";

/** Max bytes of one log line, so appends stay small (single write) and queries cheap. */
export const MAX_LINE_CHARS = 8000;

/** JSON line for an event; oversized events get clipped text and their data replaced. */
export function boundedLine(e: KbEvent): string {
  const s = JSON.stringify(e);
  if (s.length <= MAX_LINE_CHARS) return s;
  const clip = (v: string | undefined, n: number) => (v !== undefined && v.length > n ? v.slice(0, n) + "…" : v);
  const small: KbEvent = { ...e, summary: clip(e.summary, 300) ?? "", ticketName: clip(e.ticketName, 200), path: clip(e.path, 300), data: { truncated: true } };
  return JSON.stringify(small);
}

/**
 * Append-only JSON-lines log at `<dir>/.kb/events.log`.
 * v1 reads: whole file(s) are read per query (max ~2 x 5 MB thanks to rotation) and parsed lazily
 * from the end, stopping once a page is full. Corrupt lines are skipped.
 */
export function createEventLog(dir: string): EventLog {
  const folder = path.join(dir, ".kb");
  const file = path.join(folder, "events.log");
  const old = path.join(folder, "events.1.log");

  const rotateIfNeeded = (): void => {
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, old);
    } catch {
      // ignore
    }
  };

  const linesOf = (f: string): string[] => {
    try {
      return fs.readFileSync(f, "utf8").split("\n");
    } catch {
      return [];
    }
  };

  return {
    emit(e) {
      try {
        fs.mkdirSync(folder, { recursive: true });
        rotateIfNeeded();
        fs.appendFileSync(file, boundedLine(e) + "\n");
      } catch {
        // logging must never break a command
      }
    },
    query(f = {}) {
      const limit = Math.min(Math.max(Math.trunc(f.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
      const types = f.type === undefined ? undefined : Array.isArray(f.type) ? f.type : [f.type];
      const needle = f.q?.toLowerCase();
      const wants = (e: KbEvent): boolean => {
        if (f.before !== undefined && !(e.id < f.before)) return false;
        if (types && !types.some((t) => (t.endsWith(".*") ? e.type.startsWith(t.slice(0, -1)) : t === e.type))) return false;
        if (f.ticketId !== undefined && e.ticketId !== f.ticketId) return false;
        if (f.board !== undefined && e.board !== f.board) return false;
        if (f.source !== undefined && e.source !== f.source) return false;
        if (needle !== undefined) {
          const hay = [e.summary, e.type, e.ticketId, e.ticketName, e.board, JSON.stringify(e.data)].join("\n").toLowerCase();
          if (!hay.includes(needle)) return false;
        }
        return true;
      };
      // File order can differ slightly from id order (concurrent processes), so collect all matches
      // and sort by id; otherwise the id cursor could skip or repeat events.
      const all: KbEvent[] = [];
      for (const f2 of [old, file]) {
        for (const line of linesOf(f2)) {
          if (!line) continue;
          let v: unknown;
          try {
            v = JSON.parse(line);
          } catch {
            continue;
          }
          if (isEvent(v) && wants(v)) all.push(v);
        }
      }
      all.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      const events = all.slice(0, limit);
      return { events, nextCursor: all.length > limit ? events[events.length - 1].id : undefined };
    },
  };
}
