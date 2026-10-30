// Audit event model. UI/process agnostic: core only emits to an injected sink.
import type { Config } from "./config.js";

export type KbEventType =
  | "ticket.created"
  | "ticket.moved"
  | "ticket.renamed"
  | "ticket.labels"
  | "ticket.props"
  | "ticket.body"
  | "ticket.board"
  | "ticket.comment"
  | "ticket.automations-reset"
  | "ids.fixed"
  | "config.updated"
  | "automation.started"
  | "automation.finished"
  | "automation.skipped";

export type KbEventSource = "cli" | "web" | "automation" | "api" | "unknown";

export interface KbEvent {
  /** unique and sortable (time, then per-process counter) */
  id: string;
  /** ISO 8601 with timezone offset, e.g. 2026-10-30T15:16:55.123+01:00 */
  ts: string;
  type: KbEventType;
  source: KbEventSource;
  board?: string;
  ticketId?: string;
  ticketName?: string;
  path?: string;
  /** human one-liner */
  summary: string;
  data: Record<string, unknown>;
}

export interface EventSink {
  emit(e: KbEvent): void;
}

const p2 = (n: number, w = 2) => String(n).padStart(w, "0");

/** Local time as ISO 8601 with explicit offset. */
export function isoWithOffset(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p2(d.getMilliseconds(), 3)}` +
    `${sign}${p2(Math.floor(a / 60))}:${p2(a % 60)}`
  );
}

let counter = 0;
/** Sortable unique id: time (base36, fixed width) - counter - random suffix (cross-process tie-break). */
export function newEventId(d: Date): string {
  counter = (counter + 1) % (36 ** 3);
  const rand = Math.floor(Math.random() * 36 ** 3);
  return `${d.getTime().toString(36).padStart(9, "0")}-${counter.toString(36).padStart(3, "0")}${rand.toString(36).padStart(3, "0")}`;
}

export function clipText(s: string, max = 200): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// ---- config diff ----

interface BoardShape {
  columns: string[];
  automations: unknown[];
}

function shapes(c: Config): Map<string, BoardShape> {
  const m = new Map<string, BoardShape>();
  m.set(c.name, { columns: c.columns, automations: c.automations ?? [] });
  for (const [k, b] of Object.entries(c.boards ?? {})) m.set(k, { columns: b.columns, automations: b.automations ?? [] });
  return m;
}

const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export interface ConfigDiff {
  columns: { added: { board: string; name: string }[]; removed: { board: string; name: string }[]; renamed: { board: string; from: string; to: string }[] };
  boards: { added: string[]; removed: string[]; renamed: { from: string; to: string }[] };
  automations: { added: { board: string; name: string }[]; removed: { board: string; name: string }[]; changed: { board: string; name: string }[] };
}

export function diffConfig(old: Config, next: Config, rawRenames: unknown): ConfigDiff {
  const r = rec(rawRenames);
  const boardRen: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec(r.boards))) if (typeof v === "string") boardRen[k] = v;
  if (old.name !== next.name) boardRen[old.name] ??= next.name;
  const colRen = rec(r.columns);
  const oldS = shapes(old);
  const newS = shapes(next);
  const inv: Record<string, string> = {};
  for (const [f, t] of Object.entries(boardRen)) inv[t] = f;

  const d: ConfigDiff = {
    columns: { added: [], removed: [], renamed: [] },
    boards: { added: [], removed: [], renamed: [] },
    automations: { added: [], removed: [], changed: [] },
  };
  const matched = new Set<string>();
  for (const [name, n] of newS) {
    const oldName = inv[name] ?? name;
    const o = oldS.get(oldName);
    if (!o) {
      d.boards.added.push(name);
      continue;
    }
    matched.add(oldName);
    if (oldName !== name) d.boards.renamed.push({ from: oldName, to: name });
    const cr: Record<string, string> = {};
    for (const [f, t] of Object.entries(rec(colRen[oldName === old.name ? "" : oldName] ?? colRen[oldName] ?? colRen[name]))) if (typeof t === "string") cr[f] = t;
    const renamedFrom = new Set<string>();
    for (const c of n.columns) {
      if (o.columns.includes(c)) continue;
      const from = Object.keys(cr).find((f) => cr[f] === c && o.columns.includes(f));
      if (from) {
        renamedFrom.add(from);
        d.columns.renamed.push({ board: name, from, to: c });
      } else d.columns.added.push({ board: name, name: c });
    }
    for (const c of o.columns) {
      if (!n.columns.includes(c) && !renamedFrom.has(c)) d.columns.removed.push({ board: name, name: c });
    }
    const autoName = (a: unknown) => String(rec(a).name);
    const oa = new Map(o.automations.map((a) => [autoName(a), JSON.stringify(a)]));
    const na = new Map(n.automations.map((a) => [autoName(a), JSON.stringify(a)]));
    for (const [k, v] of na) {
      if (!oa.has(k)) d.automations.added.push({ board: name, name: k });
      else if (oa.get(k) !== v) d.automations.changed.push({ board: name, name: k });
    }
    for (const k of oa.keys()) if (!na.has(k)) d.automations.removed.push({ board: name, name: k });
  }
  for (const name of oldS.keys()) {
    if (!matched.has(name)) {
      d.boards.removed.push(name);
      for (const a of oldS.get(name)!.automations) d.automations.removed.push({ board: name, name: String(rec(a).name) });
    }
  }
  return d;
}

export function summarizeDiff(d: ConfigDiff, migrated: number): string {
  const parts: string[] = [];
  const add = (label: string, n: number) => n && parts.push(`${n} ${label}`);
  add("column(s) added", d.columns.added.length);
  add("column(s) removed", d.columns.removed.length);
  add("column(s) renamed", d.columns.renamed.length);
  add("board(s) added", d.boards.added.length);
  add("board(s) removed", d.boards.removed.length);
  add("board(s) renamed", d.boards.renamed.length);
  add("automation(s) added", d.automations.added.length);
  add("automation(s) removed", d.automations.removed.length);
  add("automation(s) changed", d.automations.changed.length);
  add("ticket(s) migrated", migrated);
  return `config updated${parts.length ? ": " + parts.join(", ") : ""}`;
}
