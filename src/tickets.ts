import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { columnsFor, type Config } from "./config.js";
import { splitFrontmatter } from "./frontmatter.js";

export const RESERVED = ["type", "id", "name", "status", "board", "labels", "comments"];
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
      const { yaml, body } = splitFrontmatter(fs.readFileSync(abs, "utf8"));
      if (yaml === undefined) continue;
      const doc = parseDocument(yaml);
      if (doc.errors.length) {
        diagnostics.push({ path: rel, message: `frontmatter: ${doc.errors[0].message}` });
        continue;
      }
      const data = doc.toJS();
      if (!data || typeof data !== "object" || Array.isArray(data)) continue;
      if (data.type !== "ticket") continue;
      tickets.push(toTicket(rel, data, body, stat.mtimeMs, config));
    } catch (e) {
      diagnostics.push({ path: rel, message: (e as Error).message });
    }
  }
  return { tickets, diagnostics };
}

function toTicket(
  rel: string,
  data: Record<string, unknown>,
  body: string,
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
  const found = tickets.filter((t) => hasId(t) && String(t.id) === arg);
  if (found.length === 0) throw new Error(`no ticket ${arg}`);
  if (found.length > 1) {
    throw new Error(`duplicate id ${arg}:\n${found.map((t) => `  ${t.path}`).join("\n")}`);
  }
  return found[0];
}

export function duplicates(tickets: Ticket[]): Ticket[][] {
  const groups = new Map<string, Ticket[]>();
  for (const t of tickets) {
    if (!hasId(t)) continue;
    const key = String(t.id);
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

export function nextId(tickets: { id: unknown }[]): number {
  let max = 0;
  for (const t of tickets) {
    if (isInt(t.id) && t.id > max) max = t.id;
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
    const ai = isInt(a.id);
    const bi = isInt(b.id);
    if (ai && bi) return (a.id as number) - (b.id as number);
    if (ai !== bi) return ai ? -1 : 1;
    return String(a.id).localeCompare(String(b.id)) || a.path.localeCompare(b.path);
  });
}
