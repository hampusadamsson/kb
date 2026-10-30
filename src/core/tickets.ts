import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { columnsFor, type Config } from "./config.js";
import { KanbanError } from "./errors.js";
import { splitFrontmatter, YAML_OPTS } from "./frontmatter.js";
import { parsePropertyFilter, splitNegation } from "./parse.js";

export const RESERVED = ["type", "id", "name", "status", "board", "labels", "comments", "automations"];
export const UNSORTED = "unsorted";

export interface Ticket {
  /** path relative to config dir */
  path: string;
  id: unknown;
  name: string;
  /** raw status, if any */
  status: string | undefined;
  /** resolved column: status if valid for the board, else "unsorted" */
  column: string;
  board: string;
  labels: string[];
  comments: Record<string, string>;
  props: Record<string, unknown>;
  body: string;
  /** entire raw file content */
  raw: string;
  data: Record<string, unknown>;
  mtime: number;
}

export interface Diagnostic {
  path: string;
  message: string;
}

export interface ScanResult {
  tickets: Ticket[];
  diagnostics: Diagnostic[];
}

const TICKET_TYPE_RE = /^type:\s*["']?ticket["']?\s*$/m;

export function scan(cwd: string, config: Config): ScanResult {
  const tickets: Ticket[] = [];
  const diagnostics: Diagnostic[] = [];
  const files = fs
    .globSync(config.glob, { cwd })
    .filter((f) => !f.split(path.sep).includes("node_modules"))
    .sort();

  for (const rel of files) {
    const abs = path.join(cwd, rel);
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile()) continue;
      const raw = fs.readFileSync(abs, "utf8");
      const { yaml, body } = splitFrontmatter(raw);
      if (yaml === undefined) continue;
      const doc = parseDocument(yaml, YAML_OPTS);
      if (doc.errors.length) {
        // Unparseable: only report if it declares itself a ticket; other notes are ignored.
        if (TICKET_TYPE_RE.test(yaml)) {
          diagnostics.push({ path: rel, message: `frontmatter: ${doc.errors[0].message}` });
        }
        continue;
      }
      const data = doc.toJS();
      if (!data || typeof data !== "object" || Array.isArray(data)) continue;
      if (data.type !== "ticket") continue;
      tickets.push(toTicket(rel, data, body, raw, stat.mtimeMs, config));
    } catch (e) {
      diagnostics.push({ path: rel, message: (e as Error).message });
    }
  }
  return { tickets, diagnostics };
}

/** Does a path (relative to the config dir) match the config's ticket glob? */
export function matchesTicketGlob(config: Config, rel: string): boolean {
  return path.matchesGlob(rel.split(path.sep).join("/"), config.glob);
}

function toTicket(
  rel: string,
  data: Record<string, unknown>,
  body: string,
  raw: string,
  mtime: number,
  config: Config,
): Ticket {
  const board = data.board != null ? String(data.board) : config.name;
  const status = data.status != null ? String(data.status) : undefined;
  const column =
    status !== undefined && columnsFor(config, board).includes(status) ? status : UNSORTED;

  const labels = Array.isArray(data.labels) ? data.labels.map(String) : [];
  const comments: Record<string, string> = {};
  const c = data.comments;
  if (c && typeof c === "object" && !Array.isArray(c)) {
    for (const [k, v] of Object.entries(c)) comments[k] = String(v);
  }
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (!RESERVED.includes(k)) props[k] = v;

  return {
    path: rel,
    id: data.id,
    name: data.name != null ? String(data.name) : "",
    status,
    column,
    board,
    labels,
    comments,
    props,
    body,
    raw,
    data,
    mtime,
  };
}

/** Default board, configured boards, then boards found on tickets. */
export function boardNames(tickets: Ticket[], config: Config): string[] {
  const names = new Set<string>([config.name, ...Object.keys(config.boards ?? {})]);
  for (const t of tickets) names.add(t.board);
  return [...names];
}

export function findById(tickets: Ticket[], arg: string): Ticket {
  let found = tickets.filter((t) => hasId(t) && String(t.id) === arg);
  if (found.length === 0) {
    const n = numericId(arg);
    if (n !== undefined) found = tickets.filter((t) => hasId(t) && numericId(t.id) === n);
  }
  if (found.length === 0) throw new KanbanError("not-found", `no ticket ${arg}`);
  if (found.length > 1) {
    throw new KanbanError("ambiguous", `duplicate id ${arg}:\n${found.map((t) => `  ${t.path}`).join("\n")}`);
  }
  return found[0];
}

export function duplicates(tickets: Ticket[]): Ticket[][] {
  const groups = new Map<string, Ticket[]>();
  for (const t of tickets) {
    if (!hasId(t)) continue;
    const key = idKey(t.id);
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/** Number for integers and digit-only strings, else undefined. */
export function numericId(id: unknown): number | undefined {
  if (isInt(id)) return id;
  if (typeof id === "string" && /^\d+$/.test(id)) return Number(id);
  return undefined;
}

/** Equal keys = duplicate ids (same string, or both numeric and equal). */
export function idKey(id: unknown): string {
  const n = numericId(id);
  return n !== undefined ? `n:${n}` : `s:${String(id)}`;
}

export function nextId(tickets: { id: unknown }[]): number {
  let max = 0;
  for (const t of tickets) {
    const n = numericId(t.id);
    if (n !== undefined && n > max) max = n;
  }
  return max + 1;
}

export const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
export const hasId = (t: { id: unknown }): boolean => t.id !== undefined && t.id !== null;

/** Default board first, then the rest sorted. */
export function orderedBoards(tickets: Ticket[], config: Config): string[] {
  return [config.name, ...boardNames(tickets, config).filter((b) => b !== config.name).sort()];
}

export function sortTickets(tickets: Ticket[]): Ticket[] {
  return [...tickets].sort((a, b) => {
    const an = numericId(a.id);
    const bn = numericId(b.id);
    if (an !== undefined && bn !== undefined) {
      return an - bn || String(a.id).localeCompare(String(b.id)) || a.path.localeCompare(b.path);
    }
    if ((an !== undefined) !== (bn !== undefined)) return an !== undefined ? -1 : 1;
    return String(a.id).localeCompare(String(b.id)) || a.path.localeCompare(b.path);
  });
}

export interface Filters {
  text?: string;
  labels?: string[];
  props?: string[];
}

export const hasFilters = (f: Filters): boolean =>
  !!f.text || !!f.labels?.length || !!f.props?.length;

/** All filters AND together; a leading "!" negates a single filter. */
export function matches(t: Ticket, f: Filters): boolean {
  if (f.text) {
    const [n, text] = splitNegation(f.text);
    if (t.raw.toLowerCase().includes(text.toLowerCase()) === n) return false;
  }
  for (const l of f.labels ?? []) {
    const [n, label] = splitNegation(l);
    if (t.labels.includes(label) === n) return false;
  }
  for (const p of f.props ?? []) {
    const [n, spec] = splitNegation(p);
    const { key, value: want } = parsePropertyFilter(spec);
    const v = t.data[key];
    let ok: boolean;
    if (want === undefined) ok = v !== undefined && v !== null;
    else {
      ok = Array.isArray(v) ? v.some((e) => String(e) === want) : v != null && String(v) === want;
    }
    if (ok === n) return false;
  }
  return true;
}
