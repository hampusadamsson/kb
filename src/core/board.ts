import fs from "node:fs";
import path from "node:path";
import { Document, isSeq, Scalar, YAMLMap } from "yaml";
import {
  matchRule,
  renderCommand,
  ticketVars,
  type AutomationEvent,
  type AutomationRecord,
  type AutomationRunner,
  type RunResult,
} from "./automation.js";
import { automationsFor, columnsFor, CONFIG_FILE, loadConfig, STARTER_CONFIG, type Config } from "./config.js";
import { KanbanError } from "./errors.js";
import { addComment, commentKey, idScalar, keyOf, readFile, render, updateFile } from "./frontmatter.js";
import {
  duplicates,
  findById,
  hasFilters,
  hasId,
  idKey,
  matches,
  nextId,
  orderedBoards,
  RESERVED,
  scan,
  sortTickets,
  UNSORTED,
  type Diagnostic,
  type Filters,
  type Ticket,
} from "./tickets.js";
import {
  getConfigSnapshot,
  updateConfigFile,
  type ConfigSnapshot,
  type UpdateConfigOptions,
  type UpdateConfigResult,
} from "./settings.js";
import { filenameFor, padId } from "./util.js";

// ---- types ----

export interface Warning {
  kind: "unsorted" | "missing-id" | "duplicate-id" | "parse-error";
  /** single affected file (relative to dir), when there is one */
  path?: string;
  /** all affected files (duplicate ids) */
  paths?: string[];
  message: string;
}

export interface Issue {
  path?: string;
  message: string;
}

export interface LoadResult {
  config: Config;
  tickets: Ticket[];
  diagnostics: Diagnostic[];
  warnings: Warning[];
}

export interface ListFilters extends Filters {
  board?: string;
}

export interface BoardView {
  name: string;
  columns: { name: string; tickets: Ticket[] }[];
  unsorted: Ticket[];
}

export interface ListResult {
  boards: BoardView[];
  warnings: Warning[];
}

export interface AddInput {
  name: string;
  status?: string;
  board?: string;
  labels?: string[];
  properties?: Record<string, unknown>;
  /** body text; a trailing newline is added if missing */
  body?: string;
  comment?: string;
  /** path relative to dir (default: <id>-<slug>.md) */
  file?: string;
  id?: string;
}

export interface AddResult {
  id: string;
  /** relative to dir */
  path: string;
  warnings: Warning[];
}

export interface Patch {
  name?: string;
  status?: string;
  board?: string;
  addLabels?: string[];
  removeLabels?: string[];
  setProps?: Record<string, unknown>;
  unsetProps?: string[];
  body?: string;
  comment?: string;
}

export interface UpdateResult {
  id: unknown;
  warnings: Warning[];
}

export interface ValidateResult {
  errors: Issue[];
  warnings: Issue[];
  /** errors and warnings in the order found */
  issues: (Issue & { severity: "error" | "warning" })[];
}

export interface Change {
  path: string;
  /** previous id, undefined if none */
  from: unknown;
  to: string;
}

export interface KanbanOptions {
  /** directory containing kanban.yaml */
  dir: string;
  /** clock, for comment timestamps */
  now?: () => Date;
  /** runs automation commands; absent → automations never run */
  runner?: AutomationRunner;
  /** set false to disable automations (default true) */
  automations?: boolean;
  /** called when an automation run finishes */
  onAutomation?: (rec: AutomationRecord) => void;
}

// ---- helpers ----

export function hasChanges(p: Patch): boolean {
  return !!(
    p.name !== undefined || p.status !== undefined || p.board !== undefined ||
    p.addLabels?.length || p.removeLabels?.length ||
    (p.setProps && Object.keys(p.setProps).length) || p.unsetProps?.length ||
    p.body !== undefined || p.comment !== undefined
  );
}

function checkProps(props: Record<string, unknown> | undefined): [string, unknown][] {
  const entries = Object.entries(props ?? {});
  for (const [k] of entries) {
    if (RESERVED.includes(k)) {
      throw new KanbanError("invalid", `property "${k}" is reserved; use its dedicated flag`);
    }
  }
  return entries;
}

function bodyText(text: string): string {
  return text === "" || text.endsWith("\n") ? text : text + "\n";
}

function applyLabels(doc: Document, add: string[], remove: string[]): void {
  const seq = doc.get("labels", true);
  const have = isSeq(seq) ? seq.items.map((n) => String((n as { value?: unknown }).value ?? n)) : [];
  const toAdd = [...new Set(add)].filter((l) => !have.includes(l));
  if (toAdd.length) {
    if (isSeq(seq)) for (const l of toAdd) seq.add(doc.createNode(l));
    else doc.set("labels", [...have, ...toAdd]);
  }
  if (remove.length && isSeq(seq)) {
    const rm = new Set(remove);
    const kept = seq.items.filter((n) => !rm.has(String((n as { value?: unknown }).value ?? n)));
    if (kept.length === 0) doc.delete("labels");
    else seq.items = kept;
  }
}

function setId(file: string, id: string): void {
  updateFile(file, (doc) => {
    if (doc.has("id") || !(doc.contents instanceof YAMLMap)) {
      doc.set("id", idScalar(id));
      return;
    }
    const items = doc.contents.items;
    const i = items.findIndex((p) => keyOf(p) === "type");
    items.splice(i + 1, 0, doc.createPair("id", idScalar(id)));
  });
}

const byAge = (a: Ticket, b: Ticket) => a.mtime - b.mtime || a.path.localeCompare(b.path);

function unsortedWarning(board: string, status: string): Warning {
  return {
    kind: "unsorted",
    message: `status "${status}" is not a column of board "${board}"; ticket will be unsorted`,
  };
}

/** Warnings for the scan; unsorted tickets only for the given boards. */
function scanWarnings(tickets: Ticket[], diagnostics: Diagnostic[], boards: string[]): Warning[] {
  const out: Warning[] = [];
  for (const d of diagnostics) out.push({ kind: "parse-error", path: d.path, message: d.message });
  for (const t of tickets) {
    if (!hasId(t)) out.push({ kind: "missing-id", path: t.path, message: "ticket has no id" });
  }
  for (const g of duplicates(tickets)) {
    const paths = g.map((t) => t.path);
    out.push({
      kind: "duplicate-id",
      paths,
      message: `duplicate id ${String(g[0].id)}: ${paths.join(", ")}`,
    });
  }
  for (const board of boards) {
    for (const t of sortTickets(tickets.filter((t) => t.board === board && t.column === UNSORTED))) {
      const why = t.status === undefined ? "missing status" : `unknown status "${t.status}"`;
      out.push({ kind: "unsorted", path: t.path, message: `unsorted (${why})` });
    }
  }
  return out;
}

// ---- API ----

export class Kanban {
  readonly dir: string;
  private readonly now: () => Date;
  private readonly runner?: AutomationRunner;
  private readonly automationsOn: boolean;
  private readonly onAutomation?: (rec: AutomationRecord) => void;
  private readonly inflight = new Set<Promise<void>>();

  constructor(opts: KanbanOptions) {
    this.dir = opts.dir;
    this.now = opts.now ?? (() => new Date());
    this.runner = opts.runner;
    this.automationsOn = opts.automations !== false;
    this.onAutomation = opts.onAutomation;
  }

  /** Resolves when all in-flight automation runs (incl. status writes) are finished. */
  async settled(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private writeAutomationStatus(rel: string, rule: string, entry: Record<string, unknown>): boolean {
    const abs = path.join(this.dir, rel);
    if (!fs.existsSync(abs)) return false;
    try {
      updateFile(abs, (doc) => {
        const cur = doc.get("automations", true);
        if (cur === undefined || cur === null || !(cur instanceof YAMLMap)) doc.set("automations", doc.createNode({}));
        const at = new Scalar(entry.at);
        at.type = Scalar.QUOTE_DOUBLE;
        doc.setIn(["automations", rule], doc.createNode({ ...entry, at }));
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Start matching automations for an event on the ticket at `rel` (state after the write). Never throws. */
  private dispatch(config: Config, rel: string, event: AutomationEvent): void {
    const runner = this.runner;
    if (!runner || !this.automationsOn) return;
    try {
      const ticket = scan(this.dir, config).tickets.find((t) => t.path === rel);
      if (!ticket) return;
      for (const rule of automationsFor(config, ticket.board)) {
        if (!matchRule(rule, event, ticket)) continue;
        const startedAt = commentKey(this.now(), true);
        this.writeAutomationStatus(rel, rule.name, { status: "running", at: startedAt });
        const rec = (command: string, result: RunResult): AutomationRecord => ({
          board: ticket.board,
          rule: rule.name,
          ticketId: ticket.id,
          path: rel,
          event,
          command,
          startedAt,
          finishedAt: commentKey(this.now(), true),
          status: result.exitCode === 0 && !result.error ? "done" : "failed",
          result,
        });
        const finish = (r: AutomationRecord) => {
          const entry: Record<string, unknown> = { status: r.status, at: r.finishedAt, exit: r.result.exitCode };
          if (r.result.error) entry.error = r.result.error;
          this.writeAutomationStatus(rel, rule.name, entry);
          try {
            this.onAutomation?.(r);
          } catch {
            // ignore
          }
        };
        let command: string;
        try {
          command = renderCommand(rule.run, ticketVars(ticket, event));
        } catch (e) {
          finish(rec(rule.run, { exitCode: null, stdout: "", stderr: "", error: (e as Error).message }));
          continue;
        }
        const p: Promise<void> = (async () => {
          let result: RunResult;
          try {
            result = await runner.run(command, { cwd: this.dir, env: { KB_AUTOMATION: "1" } });
          } catch (e) {
            result = { exitCode: null, stdout: "", stderr: "", error: (e as Error).message };
          }
          finish(rec(command, result));
        })()
          .catch(() => {})
          .finally(() => this.inflight.delete(p));
        this.inflight.add(p);
      }
    } catch {
      // never throw from automations
    }
  }

  /** Write a starter kanban.yaml. */
  init(): void {
    const file = path.join(this.dir, CONFIG_FILE);
    if (fs.existsSync(file)) throw new KanbanError("exists", `${CONFIG_FILE} already exists`);
    fs.writeFileSync(file, STARTER_CONFIG);
  }

  /** Editable view of kanban.yaml plus its mtime. */
  getConfig(): ConfigSnapshot {
    return getConfigSnapshot(this.dir);
  }

  /**
   * Replace the board config: validates, rewrites kanban.yaml (keeping comments), migrates tickets
   * for renamed columns/boards, and refuses to drop a column that tickets still use.
   */
  updateConfig(config: unknown, opts: UpdateConfigOptions = {}): UpdateConfigResult {
    return updateConfigFile(this.dir, config, opts);
  }

  /** Read config and scan all tickets. */
  load(): LoadResult {
    const config = loadConfig(this.dir);
    const { tickets, diagnostics } = scan(this.dir, config);
    return { config, tickets, diagnostics, warnings: scanWarnings(tickets, diagnostics, orderedBoards(tickets, config)) };
  }

  boards(): string[] {
    const { config, tickets } = this.load();
    return orderedBoards(tickets, config);
  }

  list(f: ListFilters = {}): ListResult {
    const { config, tickets, diagnostics } = this.load();
    const all = orderedBoards(tickets, config);
    if (f.board !== undefined && !all.includes(f.board)) {
      throw new KanbanError("not-found", `unknown board "${f.board}" (boards: ${all.join(", ")})`);
    }
    const names = f.board !== undefined ? [f.board] : all;
    const warnings = scanWarnings(tickets, diagnostics, names);

    const filtered = hasFilters(f);
    const boards: BoardView[] = [];
    for (const name of names) {
      const mine = tickets.filter((t) => t.board === name && matches(t, f));
      if (filtered && mine.length === 0) continue;
      boards.push({
        name,
        columns: columnsFor(config, name).map((col) => ({
          name: col,
          tickets: sortTickets(mine.filter((t) => t.column === col)),
        })),
        unsorted: sortTickets(mine.filter((t) => t.column === UNSORTED)),
      });
    }
    return { boards, warnings };
  }

  /** Find a ticket by id (exact, or numeric match). */
  get(idArg: string): Ticket {
    return findById(this.load().tickets, idArg);
  }

  /** Absolute file path of a ticket. */
  pathOf(idArg: string): string {
    return path.join(this.dir, this.get(idArg).path);
  }

  add(input: AddInput): AddResult {
    if (input.name === undefined || input.name === "") {
      throw new KanbanError("invalid", "name required (positional or -n/--name)");
    }
    const { config, tickets } = this.load();
    const extra = checkProps(input.properties);

    let id: string;
    if (input.id !== undefined) {
      if (input.id === "") throw new KanbanError("invalid", "empty --id");
      id = input.id;
      if (tickets.some((t) => hasId(t) && idKey(t.id) === idKey(id))) {
        throw new KanbanError("exists", `id ${id} already in use`);
      }
    } else {
      id = padId(nextId(tickets));
    }

    const warnings: Warning[] = [];
    const board = input.board ?? config.name;
    const cols = columnsFor(config, board);
    const status = input.status ?? cols[0];
    if (!cols.includes(status)) warnings.push(unsortedWarning(board, status));

    const data: Record<string, unknown> = { type: "ticket", id: idScalar(id), name: input.name, status };
    if (board !== config.name) data.board = board;
    const labels = [...new Set(input.labels ?? [])];
    if (labels.length) data.labels = labels;
    for (const [k, v] of extra) data[k] = v;

    const doc = new Document(data);
    if (input.comment !== undefined) addComment(doc, input.comment, this.now());

    const rel = input.file ?? filenameFor(id, input.name);
    const abs = path.resolve(this.dir, rel);
    if (input.file !== undefined) {
      const inside = path.relative(path.resolve(this.dir), abs);
      if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside) || !abs.endsWith(".md")) {
        throw new KanbanError("invalid", `file must be a .md path inside the board directory: ${rel}`);
      }
    }
    const body = input.body !== undefined ? bodyText(input.body) : "";
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    try {
      fs.writeFileSync(abs, render(doc, body), { flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new KanbanError("exists", `${rel} already exists`);
      throw e;
    }
    const rel2 = path.relative(this.dir, abs);
    this.dispatch(config, rel2, { type: "created_in", to: status });
    return { id, path: rel2, warnings };
  }

  update(idArg: string, patch: Patch): UpdateResult {
    const { config, tickets } = this.load();
    const t = findById(tickets, idArg);
    const abs = path.join(this.dir, t.path);

    const unset = patch.unsetProps ?? [];
    for (const k of unset) {
      if (k === "id" || k === "type") throw new KanbanError("invalid", `cannot unset "${k}"`);
      if (RESERVED.includes(k)) throw new KanbanError("invalid", `cannot --unset "${k}"; use its dedicated flag`);
    }
    const extra = checkProps(patch.setProps);
    if (!hasChanges(patch)) throw new KanbanError("invalid", "no changes requested");

    const warnings: Warning[] = [];
    const { doc, body: oldBody, crlf } = readFile(abs);
    if (doc.errors.length) throw new KanbanError("parse", `${t.path}: ${doc.errors[0].message}`);
    if (patch.name !== undefined) doc.set("name", patch.name);
    if (patch.board !== undefined) {
      if (patch.board === config.name) doc.delete("board");
      else doc.set("board", patch.board);
    }
    if (patch.status !== undefined || patch.board !== undefined) {
      const board = patch.board ?? t.board;
      const status = patch.status ?? t.status;
      if (status !== undefined && !columnsFor(config, board).includes(status)) {
        warnings.push(unsortedWarning(board, status));
      }
      if (patch.status !== undefined) doc.set("status", patch.status);
    }
    applyLabels(doc, patch.addLabels ?? [], patch.removeLabels ?? []);
    for (const [k, v] of extra) doc.set(k, v);
    for (const k of unset) doc.delete(k);
    if (patch.comment !== undefined) addComment(doc, patch.comment, this.now());
    const body = patch.body !== undefined ? bodyText(patch.body) : oldBody;
    fs.writeFileSync(abs, render(doc, body, crlf));
    if (patch.status !== undefined && patch.status !== t.status) {
      this.dispatch(config, t.path, { type: "moved_to", from: t.status, to: patch.status });
    }
    return { id: t.id, warnings };
  }

  move(idArg: string, status: string): UpdateResult {
    return this.update(idArg, { status });
  }

  /** Add a comment; returns its key (timestamp). */
  comment(idArg: string, text: string): string {
    const t = this.get(idArg);
    const abs = path.join(this.dir, t.path);
    const { doc, body, crlf } = readFile(abs);
    if (doc.errors.length) throw new KanbanError("parse", `${t.path}: ${doc.errors[0].message}`);
    const key = addComment(doc, text, this.now());
    fs.writeFileSync(abs, render(doc, body, crlf));
    return key;
  }

  /** Check config and tickets. Config problems are reported as an error issue. */
  validate(): ValidateResult {
    const issues: ValidateResult["issues"] = [];
    const err = (p: string | undefined, m: string) => issues.push({ severity: "error", path: p, message: m });
    const warn = (p: string | undefined, m: string) => issues.push({ severity: "warning", path: p, message: m });
    const result = (): ValidateResult => ({
      errors: issues.filter((i) => i.severity === "error").map(({ path, message }) => ({ path, message })),
      warnings: issues.filter((i) => i.severity === "warning").map(({ path, message }) => ({ path, message })),
      issues,
    });

    let config: Config;
    try {
      config = loadConfig(this.dir);
    } catch (e) {
      err(undefined, (e as Error).message);
      return result();
    }

    const { tickets, diagnostics } = scan(this.dir, config);
    for (const d of diagnostics) err(d.path, d.message);

    for (const t of tickets) {
      if (!hasId(t)) err(t.path, "missing id");
      if (t.status === undefined) err(t.path, "missing status");
      else if (!columnsFor(config, t.board).includes(t.status)) {
        err(t.path, `status "${t.status}" is not a column of board "${t.board}"`);
      }
      const { labels, comments } = t.data;
      if (labels !== undefined && !Array.isArray(labels)) err(t.path, "labels is not a list");
      if (comments !== undefined && (comments === null || typeof comments !== "object" || Array.isArray(comments))) {
        err(t.path, "comments is not a map");
      }
      if (t.board !== config.name && !(t.board in (config.boards ?? {}))) {
        warn(t.path, `board "${t.board}" is not declared in config boards`);
      }
    }
    for (const g of duplicates(tickets)) {
      const paths = g.map((t) => t.path).join(", ");
      for (const t of g) err(t.path, `duplicate id ${String(t.id)} (${paths})`);
    }
    return result();
  }

  /** Repair missing/duplicate ids. With dryRun, only report. */
  fix({ dryRun = false }: { dryRun?: boolean } = {}): Change[] {
    const { tickets } = this.load();

    const used = new Set(tickets.filter(hasId).map((t) => idKey(t.id)));
    // ids known so far, including ones assigned in this run
    const pool: { id: unknown }[] = [...tickets];
    const next = (): string => {
      let n = padId(nextId(pool));
      while (used.has(idKey(n))) {
        pool.push({ id: n });
        n = padId(nextId(pool));
      }
      return n;
    };

    const losers = new Set<Ticket>();
    for (const g of duplicates(tickets)) for (const t of [...g].sort(byAge).slice(1)) losers.add(t);

    const changes: Change[] = [];
    for (const t of [...tickets].sort(byAge)) {
      if (hasId(t) && !losers.has(t)) continue;
      let id: string | undefined;
      if (!hasId(t)) {
        const m = /^(\d+)[-_ .]/.exec(path.basename(t.path));
        if (m && !used.has(idKey(m[1]))) id = m[1];
      }
      id ??= next();
      used.add(idKey(id));
      pool.push({ id });
      if (!dryRun) setId(path.join(this.dir, t.path), id);
      changes.push({ path: t.path, from: hasId(t) ? t.id : undefined, to: id });
    }
    return changes;
  }
}

export function createKanban(opts: KanbanOptions): Kanban {
  return new Kanban(opts);
}

