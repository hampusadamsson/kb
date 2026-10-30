// Board config management: validated edits of kanban.yaml, with ticket migration.
import fs from "node:fs";
import path from "node:path";
import { isMap, isSeq, parseDocument, Scalar, type Document, type YAMLSeq } from "yaml";
import { z } from "zod";
import { CONFIG_FILE, loadConfig, type Config } from "./config.js";
import { KanbanError } from "./errors.js";
import { updateFile } from "./frontmatter.js";
import { scan, UNSORTED, type Ticket } from "./tickets.js";

/** Editable view of kanban.yaml (defaults filled in). */
export interface ConfigInput {
  name: string;
  columns: string[];
  glob: string;
  boards: Record<string, { columns: string[] }>;
}

export interface ConfigSnapshot {
  config: ConfigInput;
  /** file mtime (ms); pass back to updateConfig to detect concurrent edits */
  mtime: number;
}

/**
 * What was renamed, in terms of the OLD config.
 * columns: key "" = top-level columns, else a board override name → { oldColumn: newColumn }.
 * boards: { oldBoardName: newBoardName } (the default board's rename is implied by `name`).
 */
export interface Renames {
  columns: Record<string, Record<string, string>>;
  boards: Record<string, string>;
}

export interface UpdateConfigOptions {
  renames?: unknown;
  /** only compute the changes */
  dryRun?: boolean;
  /** mtime from getConfig; error "stale" if kanban.yaml changed since */
  mtime?: number;
}

export interface TicketChange {
  path: string;
  id: unknown;
  field: "status" | "board";
  from: string | undefined;
  /** undefined = the key is removed (ticket moves to the default board) */
  to: string | undefined;
}

export interface UpdateConfigResult {
  /** ticket edits made (with dryRun: that would be made) */
  changes: TicketChange[];
  configChanged: boolean;
  mtime: number;
}

// ---- validation ----

const nonEmpty = (what: string) => z.string().trim().min(1, `${what} must not be empty`);
const columnsSchema = z
  .array(nonEmpty("column name"))
  .min(1, "columns must not be empty")
  .refine((c) => new Set(c).size === c.length, "columns must be unique");

const inputSchema = z.object({
  name: nonEmpty("name"),
  glob: nonEmpty("glob"),
  columns: columnsSchema,
  boards: z.record(nonEmpty("board name"), z.object({ columns: columnsSchema })).default({}),
});

const renamesSchema = z.object({
  columns: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  boards: z.record(z.string(), z.string()).default({}),
});

function parseWith<T>(schema: z.ZodType<T>, what: string, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  throw new KanbanError("invalid", `invalid ${what}: ${issues}`);
}

// ---- planning ----

/** Old board name → new board name, including the default board's rename. */
function boardRenames(old: Config, next: ConfigInput, renames: Renames): Record<string, string> {
  const map: Record<string, string> = { ...renames.boards };
  if (next.name !== old.name) map[old.name] ??= next.name;
  return map;
}

/**
 * Ticket edits that keep tickets valid under the new config: column renames rewrite `status`,
 * board renames rewrite an explicit `board`. Throws if a column still in use would disappear.
 */
function planTicketChanges(
  old: Config,
  next: ConfigInput,
  tickets: Ticket[],
  renames: Renames,
  boardRen: Record<string, string>,
): TicketChange[] {
  const existing = new Set([old.name, ...Object.keys(old.boards ?? {}), ...tickets.map((t) => t.board)]);
  for (const [from, to] of Object.entries(boardRen)) {
    if (from !== to && existing.has(to) && !(to in boardRen)) {
      throw new KanbanError("invalid", `cannot rename board "${from}" to "${to}": that board already exists`);
    }
  }

  const changes: TicketChange[] = [];
  const blocked: string[] = [];
  for (const t of tickets) {
    const hadOverride = old.boards?.[t.board] !== undefined;
    const newBoard = boardRen[t.board] ?? t.board;
    const map = renames.columns[hadOverride ? t.board : ""] ?? {};
    const newStatus = t.status !== undefined ? (map[t.status] ?? t.status) : undefined;

    const override = next.boards[newBoard];
    const cols = override?.columns ?? next.columns;
    const inUse = t.column !== UNSORTED && newStatus !== undefined && !cols.includes(newStatus);
    // dropping a board override falls back to the default columns; those tickets just become unsorted
    if (inUse && !(hadOverride && !override)) blocked.push(`${t.path} [${newBoard}: ${newStatus}]`);

    if (newStatus !== t.status) {
      changes.push({ path: t.path, id: t.id, field: "status", from: t.status, to: newStatus });
    }
    if (t.data.board != null && newBoard !== t.board) {
      const to = newBoard === next.name ? undefined : newBoard;
      changes.push({ path: t.path, id: t.id, field: "board", from: t.board, to });
    }
  }
  if (blocked.length) {
    const shown = blocked.slice(0, 10).join(", ") + (blocked.length > 10 ? `, … (+${blocked.length - 10})` : "");
    throw new KanbanError(
      "invalid",
      `cannot remove columns still in use by ${blocked.length} ticket(s): ${shown}. Move or rename them first.`,
    );
  }
  return changes;
}

// ---- writing ----

const same = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

function setColumns(doc: Document, at: string[], cols: string[]): void {
  const node = doc.getIn(at, true);
  if (isSeq(node)) {
    node.items = cols.map((c) => doc.createNode(c));
    return;
  }
  const seq = doc.createNode(cols) as YAMLSeq;
  seq.flow = true;
  doc.setIn(at, seq);
}

/** Apply the new config to the parsed kanban.yaml (comments and unrelated keys are kept). */
function applyConfigToDoc(doc: Document, old: Config, next: ConfigInput, boardRen: Record<string, string>): boolean {
  let changed = false;
  if (next.name !== old.name) (doc.set("name", next.name), (changed = true));
  if (next.glob !== old.glob) (doc.set("glob", next.glob), (changed = true));
  if (!same(next.columns, old.columns)) (setColumns(doc, ["columns"], next.columns), (changed = true));

  // renamed board overrides keep their position in the file
  const keyAfter = (k: string) => (boardRen[k] !== undefined && boardRen[k] in next.boards ? boardRen[k] : k);
  const boardsNode = doc.get("boards", true);
  if (isMap(boardsNode)) {
    for (const pair of boardsNode.items) {
      const k = String((pair.key as Scalar).value ?? pair.key);
      if (keyAfter(k) !== k) (pair.key = new Scalar(keyAfter(k)), (changed = true));
    }
  }
  const before: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(old.boards ?? {})) before[keyAfter(k)] = v.columns;

  for (const [name, b] of Object.entries(next.boards)) {
    if (!(name in before) || !same(b.columns, before[name])) {
      setColumns(doc, ["boards", name, "columns"], b.columns);
      changed = true;
    }
  }
  for (const name of Object.keys(before)) {
    if (!(name in next.boards)) (doc.deleteIn(["boards", name]), (changed = true));
  }
  if (Object.keys(next.boards).length === 0 && doc.has("boards")) (doc.delete("boards"), (changed = true));
  return changed;
}

function applyTicketChanges(dir: string, changes: TicketChange[]): void {
  const byPath = new Map<string, TicketChange[]>();
  for (const c of changes) byPath.set(c.path, [...(byPath.get(c.path) ?? []), c]);
  for (const [rel, list] of byPath) {
    updateFile(path.join(dir, rel), (doc) => {
      for (const c of list) {
        if (c.to === undefined) doc.delete(c.field);
        else doc.set(c.field, c.to);
      }
    });
  }
}

// ---- entry points (used by Kanban) ----

export function getConfigSnapshot(dir: string): ConfigSnapshot {
  const c = loadConfig(dir);
  const boards: ConfigInput["boards"] = {};
  for (const [k, v] of Object.entries(c.boards ?? {})) boards[k] = { columns: [...v.columns] };
  return {
    config: { name: c.name, columns: [...c.columns], glob: c.glob, boards },
    mtime: fs.statSync(path.join(dir, CONFIG_FILE)).mtimeMs,
  };
}

export function updateConfigFile(dir: string, raw: unknown, opts: UpdateConfigOptions = {}): UpdateConfigResult {
  const next = parseWith(inputSchema, "config", raw) as ConfigInput;
  const renames = parseWith(renamesSchema, "renames", opts.renames ?? {});
  const file = path.join(dir, CONFIG_FILE);
  const old = loadConfig(dir);
  const mtime = fs.statSync(file).mtimeMs;
  if (opts.mtime !== undefined && opts.mtime !== mtime) {
    throw new KanbanError("stale", `${CONFIG_FILE} changed on disk`);
  }

  const { tickets } = scan(dir, old);
  const boardRen = boardRenames(old, next, renames);
  const changes = planTicketChanges(old, next, tickets, renames, boardRen);
  const doc = parseDocument(fs.readFileSync(file, "utf8"));
  const configChanged = applyConfigToDoc(doc, old, next, boardRen);

  if (opts.dryRun) return { changes, configChanged, mtime };
  // tickets first: if a write fails midway, repeating the request still finds the rest to migrate
  applyTicketChanges(dir, changes);
  if (configChanged) fs.writeFileSync(file, doc.toString({ lineWidth: 0, flowCollectionPadding: false }));
  return { changes, configChanged, mtime: fs.statSync(file).mtimeMs };
}
