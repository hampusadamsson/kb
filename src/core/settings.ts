// Board config management: validated edits of kanban.yaml, with ticket migration.
import fs from "node:fs";
import path from "node:path";
import { isMap, isSeq, parseDocument, Scalar, type Document, type YAMLSeq } from "yaml";
import { z } from "zod";
import { automationProblems } from "./automation.js";
import { automationSchema, columnsFor, CONFIG_FILE, loadConfig, type Automation, type Config } from "./config.js";
import { KanbanError } from "./errors.js";
import { updateFile, YAML_OPTS } from "./frontmatter.js";
import { scan, UNSORTED, type Ticket } from "./tickets.js";

/** Editable view of kanban.yaml (defaults filled in). */
export interface ConfigInput {
  name: string;
  columns: string[];
  glob: string;
  automations?: Automation[];
  boards: Record<string, { columns: string[]; automations?: Automation[] }>;
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
  automations: z.array(automationSchema).optional(),
  boards: z
    .record(nonEmpty("board name"), z.object({ columns: columnsSchema, automations: z.array(automationSchema).optional() }))
    .default({}),
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

/** Follow column renames in automations the client left on the old column name. */
function rewriteRenamedColumns(old: Config, next: ConfigInput, renames: Renames, boardRen: Record<string, string>): void {
  const oldOf: Record<string, string> = {};
  for (const [from, to] of Object.entries(boardRen)) oldOf[to] = from;
  const fix = (rules: Automation[] | undefined, map: Record<string, string> | undefined, cols: string[]) => {
    if (!rules || !map) return;
    for (const r of rules) {
      for (const k of ["moved_to", "created_in"] as const) {
        const c = r.when[k];
        if (c !== undefined && !cols.includes(c) && map[c] !== undefined) r.when[k] = map[c];
      }
    }
  };
  fix(next.automations, renames.columns[""], next.columns);
  for (const [name, b] of Object.entries(next.boards)) {
    const o = oldOf[name] ?? name;
    if (o in (old.boards ?? {})) fix(b.automations, renames.columns[o], b.columns);
  }
}

/** Automations whose column was removed from their board (by the new board name). */
function automationBlocks(old: Config, next: ConfigInput, boardRen: Record<string, string>): string[] {
  const reverse: Record<string, string> = {};
  for (const [from, to] of Object.entries(boardRen)) reverse[to] = from;
  const out: string[] = [];
  for (const board of [next.name, ...Object.keys(next.boards)]) {
    const rules = board === next.name ? next.automations : next.boards[board]?.automations;
    const oldName = board === next.name ? old.name : (reverse[board] ?? board);
    const known = oldName === old.name || oldName in (old.boards ?? {});
    const oldCols = known ? columnsFor(old, oldName) : [];
    const cols = next.boards[board]?.columns ?? next.columns;
    for (const r of rules ?? []) {
      const col = r.when.moved_to ?? r.when.created_in;
      if (col !== undefined && !cols.includes(col) && oldCols.includes(col)) {
        out.push(`cannot remove column "${col}": used by automation "${r.name}" on board "${board}"`);
      }
    }
  }
  return out;
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
  autoBlocked: string[] = [],
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
  if (blocked.length || autoBlocked.length) {
    const reasons = [...autoBlocked];
    if (blocked.length) {
      const shown = blocked.slice(0, 10).join(", ") + (blocked.length > 10 ? `, … (+${blocked.length - 10})` : "");
      reasons.push(`cannot remove columns still in use by ${blocked.length} ticket(s): ${shown}. Move or rename them first.`);
    }
    throw new KanbanError("invalid", reasons.join("; "));
  }
  return changes;
}

// ---- writing ----

const same = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameAuto = (a: Automation[] | undefined, b: Automation[] | undefined) =>
  JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

function setAutomations(doc: Document, at: string[], rules: Automation[] | undefined): void {
  if (!rules || rules.length === 0) doc.deleteIn(at);
  else doc.setIn(at, doc.createNode(rules));
}

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
  const beforeAuto: Record<string, Automation[] | undefined> = {};
  for (const [k, v] of Object.entries(old.boards ?? {})) {
    before[keyAfter(k)] = v.columns;
    beforeAuto[keyAfter(k)] = v.automations;
  }
  if (!sameAuto(old.automations, next.automations)) {
    setAutomations(doc, ["automations"], next.automations);
    changed = true;
  }

  for (const [name, b] of Object.entries(next.boards)) {
    if (!(name in before) || !same(b.columns, before[name])) {
      setColumns(doc, ["boards", name, "columns"], b.columns);
      changed = true;
    }
    if (!sameAuto(beforeAuto[name], b.automations)) {
      setAutomations(doc, ["boards", name, "automations"], b.automations);
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
  for (const [k, v] of Object.entries(c.boards ?? {})) {
    boards[k] = { columns: [...v.columns] };
    if (v.automations?.length) boards[k].automations = structuredClone(v.automations);
  }
  const config: ConfigInput = { name: c.name, columns: [...c.columns], glob: c.glob, boards };
  if (c.automations?.length) config.automations = structuredClone(c.automations);
  return {
    config,
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
  rewriteRenamedColumns(old, next, renames, boardRen);
  const changes = planTicketChanges(old, next, tickets, renames, boardRen, automationBlocks(old, next, boardRen));
  const autoProblems = automationProblems(next);
  if (autoProblems.length) throw new KanbanError("invalid", autoProblems.join("; "));
  const doc = parseDocument(fs.readFileSync(file, "utf8"), YAML_OPTS);
  const configChanged = applyConfigToDoc(doc, old, next, boardRen);

  if (opts.dryRun) return { changes, configChanged, mtime };
  // tickets first: if a write fails midway, repeating the request still finds the rest to migrate
  applyTicketChanges(dir, changes);
  if (configChanged) fs.writeFileSync(file, doc.toString({ lineWidth: 0, flowCollectionPadding: false }));
  return { changes, configChanged, mtime: fs.statSync(file).mtimeMs };
}
