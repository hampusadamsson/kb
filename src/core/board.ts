import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Document, isSeq, Scalar, YAMLMap } from "yaml";
import {
  matchRule,
  renderCommand,
  ruleCommand,
  runSteps,
  ticketVars,
  automationProblems,
  buildAutomationOverview,
  type AutomationOverview,
  AUTOMATION_RUN_LIMIT,
  entryRuns,
  isStaleRun,
  totalRuns,
  type AutomationEvent,
  type AutomationRecord,
  type AutomationRunner,
  type RunResult,
  KILLED_BY_USER,
} from "./automation.js";
import {
  automationsFor,
  columnsFor,
  CONFIG_FILE,
  isTicketFile,
  isValidGlob,
  loadConfig,
  STARTER_CONFIG,
  ticketRules,
  type Config,
} from "./config.js";
import { KanbanError } from "./errors.js";
import {
  clipText,
  diffConfig,
  isoWithOffset,
  newEventId,
  summarizeDiff,
  type EventSink,
  type KbEvent,
  type KbEventSource,
} from "./events.js";
import { addComment, commentKey, idScalar, keyOf, readFile, render, updateFile } from "./frontmatter.js";
import { consumeKilled } from "../killMarker.js";
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
  previewTicketRules,
  updateConfigFile,
  type TicketPreview,
  type ConfigSnapshot,
  type UpdateConfigOptions,
  type UpdateConfigResult,
} from "./settings.js";
import { filenameFor, padId } from "./util.js";

// ---- types ----

export interface Warning {
  kind: "unsorted" | "missing-id" | "duplicate-id" | "parse-error" | "not-scanned";
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
  /** delete the `automations` run history (resets the loop-guard counter); never triggers automations */
  resetAutomations?: boolean;
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
  /** audit event sink; absent → no events */
  events?: EventSink;
  /** who triggers the operations (default "unknown") */
  source?: KbEventSource;
  /**
   * Liveness probe for pids recorded in `automations` frontmatter. Core stays process-agnostic:
   * the CLI/web pass one so a long-running (or hung) run is not mistaken for a dead one.
   */
  isAlive?: (pid: number) => boolean;
}

// ---- helpers ----

export function hasChanges(p: Patch): boolean {
  return !!(
    p.name !== undefined ||
    p.status !== undefined ||
    p.board !== undefined ||
    p.addLabels?.length ||
    p.removeLabels?.length ||
    (p.setProps && Object.keys(p.setProps).length) ||
    p.unsetProps?.length ||
    p.body !== undefined ||
    p.comment !== undefined ||
    p.resetAutomations === true
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
  private readonly sink?: EventSink;
  private readonly source: KbEventSource;
  private readonly isAlive?: (pid: number) => boolean;

  constructor(opts: KanbanOptions) {
    this.sink = opts.events;
    this.source = opts.source ?? "unknown";
    this.isAlive = opts.isAlive;
    this.dir = opts.dir;
    this.now = opts.now ?? (() => new Date());
    this.runner = opts.runner;
    this.automationsOn = opts.automations !== false;
    this.onAutomation = opts.onAutomation;
  }

  /** Emit an audit event. Never throws. */
  private emit(
    type: KbEvent["type"],
    summary: string,
    data: Record<string, unknown>,
    ref: Partial<Pick<KbEvent, "board" | "ticketId" | "ticketName" | "path">> = {},
  ): void {
    if (!this.sink) return;
    try {
      const d = this.now();
      const e: KbEvent = { id: newEventId(d), ts: isoWithOffset(d), type, source: this.source, ...ref, summary, data };
      this.sink.emit(e);
    } catch {
      // auditing must never break an operation
    }
  }

  /** Resolves when all in-flight automation runs (incl. status writes) are finished. */
  async settled(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  /** Writes a rule's entry; `runs` is incremented when `bump`, otherwise carried over from the existing entry. */
  private writeAutomationStatus(rel: string, id: unknown, rule: string, entry: Record<string, unknown>, bump = false): boolean {
    try {
      const idOf = (file: string): unknown => readFile(file).doc.get("id");
      let abs = path.join(this.dir, rel);
      let ok = false;
      try {
        ok = fs.existsSync(abs) && idKey(idOf(abs)) === idKey(id);
      } catch {
        ok = false;
      }
      if (!ok) {
        const found = scan(this.dir, loadConfig(this.dir)).tickets.find((t) => hasId(t) && idKey(t.id) === idKey(id));
        if (!found) return false;
        abs = path.join(this.dir, found.path);
      }
      updateFile(abs, (doc) => {
        const cur = doc.get("automations", true);
        if (cur === undefined || cur === null || !(cur instanceof YAMLMap)) doc.set("automations", doc.createNode({}));
        const at = new Scalar(entry.at);
        at.type = Scalar.QUOTE_DOUBLE;
        const prev = doc.getIn(["automations", rule]);
        const prevRuns = prev instanceof YAMLMap ? entryRuns(prev.toJSON()) : 0;
        doc.setIn(["automations", rule], doc.createNode({ ...entry, at, runs: prevRuns + (bump ? 1 : 0) }));
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Start matching automations for an event on the ticket at `rel` (state after the write). Never throws. */
  private dispatch(config: Config, rel: string, event: AutomationEvent): void {
    const runner = this.runner;
    const off = !runner || !this.automationsOn;
    if (off && !this.sink) return;
    try {
      const ticket = scan(this.dir, config).tickets.find((t) => t.path === rel);
      if (!ticket) return;
      const ref = { board: ticket.board, ticketId: String(ticket.id), ticketName: ticket.name, path: rel };
      let started = 0; // runs started in this dispatch (the scanned ticket snapshot does not include them)
      for (const rule of automationsFor(config, ticket.board)) {
        if (!matchRule({ ...rule, enabled: true }, event, ticket)) continue;
        if (off || rule.enabled === false) {
          const reason = rule.enabled === false ? "rule-disabled" : "automations-off";
          this.emit(
            "automation.skipped",
            `automation "${rule.name}" skipped on #${String(ticket.id)} (${reason})`,
            { rule: rule.name, reason, event },
            ref,
          );
          continue;
        }
        // Loop guard (default on). KB_AUTOMATION=1 already stops CLI loops from scripts; this mainly
        // protects against scripts calling the web API and other paths that re-trigger rules.
        if (rule.guard !== false) {
          const runs = totalRuns(ticket.data.automations) + started;
          if (runs >= AUTOMATION_RUN_LIMIT) {
            const reason = `guardrail: ${AUTOMATION_RUN_LIMIT} automation runs on this ticket`;
            this.writeAutomationStatus(rel, ticket.id, rule.name, { status: "skipped", at: commentKey(this.now(), true), reason });
            this.emit(
              "automation.skipped",
              `automation "${rule.name}" skipped on #${String(ticket.id)} (guardrail: ${runs} runs)`,
              { rule: rule.name, reason: "guardrail", runs, limit: AUTOMATION_RUN_LIMIT, event },
              ref,
            );
            continue;
          }
        }
        started++;
        const startMs = this.now().getTime();
        const startedAt = commentKey(this.now(), true);
        this.emit("automation.started", `automation "${rule.name}" started on #${String(ticket.id)}`, { rule: rule.name, event }, ref);
        this.writeAutomationStatus(rel, ticket.id, rule.name, { status: "running", at: startedAt }, true);
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
          // A multi-step run records the first failing step's number (single `run` strings keep their shape).
          const failedStep = Array.isArray(rule.run) ? r.failedStep : undefined;
          const entry: Record<string, unknown> = { status: r.status, at: r.finishedAt, exit: r.result.exitCode };
          if (r.result.error) entry.error = r.result.error;
          if (failedStep !== undefined) entry.step = failedStep;
          this.writeAutomationStatus(rel, ticket.id, rule.name, entry);
          const data: Record<string, unknown> = {
            rule: rule.name,
            status: r.status,
            exit: r.result.exitCode,
            durationMs: this.now().getTime() - startMs,
            command: clipText(r.command),
          };
          if (r.result.error) data.error = r.result.error;
          if (failedStep !== undefined) data.step = failedStep;
          if (r.result.error === KILLED_BY_USER) data.killed = true;
          if (r.result.timedOut) {
            data.timedOut = true;
            data.timeoutSeconds = rule.timeout;
          }
          this.emit("automation.finished", `automation "${rule.name}" ${r.status} on #${String(ticket.id)}`, data, ref);
          try {
            this.onAutomation?.(r);
          } catch {
            // ignore
          }
        };
        let commands: string[];
        try {
          // Render every step before running any, so a template error fails the whole run up front.
          const vars = ticketVars(ticket, event);
          commands = runSteps(rule).map((step) => renderCommand(step, vars));
        } catch (e) {
          finish(rec(ruleCommand(rule), { exitCode: null, stdout: "", stderr: "", error: (e as Error).message }));
          continue;
        }
        let pid: number | undefined;
        const p: Promise<void> = (async () => {
          let result: RunResult = { exitCode: 0, stdout: "", stderr: "" };
          let failedStep: number | undefined;
          let firstFailure: RunResult | undefined;
          for (const [i, command] of commands.entries()) {
            try {
              result = await runner!.run(command, {
                cwd: this.dir,
                env: { KB_AUTOMATION: "1" },
                ...(rule.timeout ? { timeoutMs: rule.timeout * 1000 } : {}),
                meta: { board: ticket.board, rule: rule.name, ticketId: String(ticket.id), ticketName: ticket.name, path: rel },
                // Record the pid so `kb automations kill` can reach this run from another process.
                onSpawn: (s) => {
                  pid = s.pid;
                  this.writeAutomationStatus(rel, ticket.id, rule.name, {
                    status: "running",
                    at: startedAt,
                    pid: s.pid,
                    pgid: s.pgid,
                    host: os.hostname(),
                  });
                },
              });
            } catch (e) {
              result = { exitCode: null, stdout: "", stderr: "", error: (e as Error).message };
            }
            // Killed from another process (kb automations kill): record it like the web Kill button.
            if (result.exitCode === null && result.error && result.error !== KILLED_BY_USER && pid && consumeKilled(this.dir, pid)) {
              result = { ...result, error: KILLED_BY_USER };
            }
            if (result.exitCode !== 0 || result.error) {
              if (failedStep === undefined) {
                failedStep = i + 1;
                firstFailure = result;
              }
              if (rule.continueOnError !== true) break;
            }
          }
          // A failed multi-step run reports the first failure, not the last step's result.
          const r = rec(commands.join(" && "), firstFailure ?? result);
          finish(failedStep === undefined ? r : { ...r, status: "failed", failedStep });
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
    let before: Config | undefined;
    if (this.sink && !opts.dryRun) {
      try {
        before = loadConfig(this.dir);
      } catch {
        before = undefined;
      }
    }
    const r = updateConfigFile(this.dir, config, opts);
    if (before && !opts.dryRun && (r.configChanged || r.changes.length)) {
      try {
        const diff = diffConfig(before, loadConfig(this.dir), opts.renames);
        this.emit("config.updated", summarizeDiff(diff, r.changes.length), {
          ...diff,
          ticketsMigrated: r.changes.length,
          tickets: r.changes.slice(0, 50).map((c) => ({ path: c.path, field: c.field, from: c.from, to: c.to })),
        });
      } catch {
        // ignore
      }
    }
    return r;
  }

  /** Read-only: how the proposed ticket rules change the set of tickets (against the current files). */
  previewTicketRules(tickets: unknown): TicketPreview {
    return previewTicketRules(this.dir, tickets);
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

  /** Automation rules and their runtime state (from ticket frontmatter). Read-only; nothing is run. */
  automationOverview(opts: { board?: string } = {}): AutomationOverview {
    const { config, tickets } = this.load();
    const all = orderedBoards(tickets, config);
    if (opts.board !== undefined && !all.includes(opts.board)) {
      throw new KanbanError("not-found", `unknown board "${opts.board}" (boards: ${all.join(", ")})`);
    }
    return buildAutomationOverview(config, tickets, opts.board !== undefined ? [opts.board] : all, this.now().getTime(), {
      isAlive: this.isAlive,
      localHost: os.hostname(),
    });
  }

  /**
   * Find a ticket by id (exact, or numeric match).
   * `board` limits the search; omit it (or pass "all") to search every board.
   */
  get(idArg: string, opts: { board?: string } = {}): Ticket {
    const { config, tickets } = this.load();
    const board = opts.board === "all" ? undefined : opts.board;
    if (board !== undefined && board !== config.name) {
      const known = orderedBoards(tickets, config);
      if (!known.includes(board)) {
        throw new KanbanError("not-found", `unknown board "${board}" (boards: ${known.join(", ")})`);
      }
    }
    return findById(tickets, idArg, board);
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
    const rel0 = path.relative(path.resolve(this.dir), abs).split(path.sep).join("/");
    if (!isTicketFile(ticketRules(config), rel0, data, config.glob)) {
      warnings.push({
        kind: "not-scanned",
        path: rel0,
        message: `${rel0} is not matched by glob/tickets rules; it will not show on the board`,
      });
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
    this.emit(
      "ticket.created",
      `#${id} created in ${status}: ${input.name}`,
      {
        status,
        board,
        labels,
        props: Object.fromEntries(extra),
        hasBody: body !== "",
        hasComment: input.comment !== undefined,
      },
      { board, ticketId: id, ticketName: input.name, path: rel2 },
    );
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
    const hadAutos = doc.has("automations");
    if (patch.resetAutomations) doc.delete("automations");
    if (patch.comment !== undefined) addComment(doc, patch.comment, this.now());
    const body = patch.body !== undefined ? bodyText(patch.body) : oldBody;
    fs.writeFileSync(abs, render(doc, body, crlf));
    if (this.sink) this.emitUpdate(config, t, patch, oldBody, body, extra, unset);
    if (this.sink && patch.resetAutomations) {
      const tid = String(t.id ?? "?");
      this.emit(
        "ticket.automations-reset",
        `#${tid} automation history reset`,
        { hadHistory: hadAutos },
        { board: t.board, ticketId: tid, ticketName: t.name, path: t.path },
      );
    }
    if (patch.status !== undefined && patch.status !== t.status) {
      this.dispatch(config, t.path, { type: "moved_to", from: t.status, to: patch.status });
    }
    return { id: t.id, warnings };
  }

  /** One event per kind of change actually made (old ticket vs patch). */
  private emitUpdate(
    config: Config,
    t: Ticket,
    patch: Patch,
    oldBody: string,
    newBody: string,
    extra: [string, unknown][],
    unset: string[],
  ): void {
    const tid = String(t.id ?? "?");
    const newBoard = patch.board ?? t.board;
    const ref = { board: newBoard, ticketId: tid, ticketName: patch.name ?? t.name, path: t.path };
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    void config;
    if (patch.board !== undefined && patch.board !== t.board) {
      this.emit("ticket.board", `#${tid} board ${t.board} → ${patch.board}`, { from: t.board, to: patch.board }, ref);
    }
    if (patch.status !== undefined && patch.status !== t.status) {
      this.emit(
        "ticket.moved",
        `#${tid} moved ${t.status ?? "(none)"} → ${patch.status}`,
        { from: t.status ?? null, to: patch.status },
        ref,
      );
    }
    if (patch.name !== undefined && patch.name !== t.name) {
      this.emit("ticket.renamed", `#${tid} renamed "${t.name}" → "${patch.name}"`, { from: t.name, to: patch.name }, ref);
    }
    const added = [...new Set(patch.addLabels ?? [])].filter((l) => !t.labels.includes(l));
    const removed = [...new Set(patch.removeLabels ?? [])].filter((l) => t.labels.includes(l) && !added.includes(l));
    if (added.length || removed.length) {
      const bits = [...added.map((l) => `+${l}`), ...removed.map((l) => `-${l}`)];
      this.emit("ticket.labels", `#${tid} labels ${bits.join(" ")}`, { added, removed }, ref);
    }
    const set: Record<string, unknown> = {};
    const old: Record<string, unknown> = {};
    for (const [k, v] of extra) {
      if (Object.hasOwn(t.props, k) && same(t.props[k], v)) continue;
      set[k] = v;
      if (Object.hasOwn(t.props, k)) old[k] = t.props[k];
    }
    const unsetKeys = [...new Set(unset)].filter((k) => Object.hasOwn(t.props, k) && !(k in set));
    for (const k of unsetKeys) old[k] = t.props[k];
    if (Object.keys(set).length || unsetKeys.length) {
      const bits = [...Object.keys(set).map((k) => `${k}=${clipText(JSON.stringify(set[k]) ?? "", 40)}`), ...unsetKeys.map((k) => `-${k}`)];
      this.emit("ticket.props", `#${tid} props ${bits.join(" ")}`, { set, unset: unsetKeys, old }, ref);
    }
    if (patch.body !== undefined && newBody !== oldBody) {
      this.emit(
        "ticket.body",
        `#${tid} body changed (${oldBody.length} → ${newBody.length} chars)`,
        { changed: true, fromLength: oldBody.length, toLength: newBody.length },
        ref,
      );
    }
    if (patch.comment !== undefined) {
      this.emit("ticket.comment", `#${tid} comment: ${clipText(patch.comment, 80)}`, { text: clipText(patch.comment) }, ref);
    }
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
    this.emit(
      "ticket.comment",
      `#${String(t.id ?? "?")} comment: ${clipText(text, 80)}`,
      { key, text: clipText(text) },
      { board: t.board, ticketId: String(t.id ?? "?"), ticketName: t.name, path: t.path },
    );
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

    const rules = ticketRules(config);
    for (const kind of ["include", "exclude"] as const) {
      const seen = new Set<string>();
      rules[kind].forEach((r, i) => {
        const label = `tickets.${kind}[${i}]${r.name ? ` "${r.name}"` : ""}`;
        if (r.glob !== undefined && !isValidGlob(r.glob)) err(CONFIG_FILE, `${label}: invalid glob "${r.glob}"`);
        if (r.name) {
          if (seen.has(r.name)) warn(CONFIG_FILE, `${label}: duplicate rule name`);
          seen.add(r.name);
        }
      });
    }
    if (!rules.baseline && rules.include.length === 0) {
      warn(CONFIG_FILE, "tickets.baseline is false and there are no include rules: no tickets can exist");
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

    for (const p of automationProblems(config)) err(CONFIG_FILE, p);
    const nowMs = this.now().getTime();
    for (const t of tickets) {
      const autos = t.data.automations;
      if (autos === null || typeof autos !== "object" || Array.isArray(autos)) continue;
      for (const [rule, e] of Object.entries(autos as Record<string, unknown>)) {
        if (e === null || typeof e !== "object") continue;
        const { status, at } = e as { status?: unknown; at?: unknown };
        if (status !== "running") continue;
        const ms = at instanceof Date ? at.getTime() : typeof at === "string" ? new Date(at).getTime() : NaN;
        // A live process is not stale, however long it has run; without a usable pid fall back to age.
        if (isStaleRun(e as Record<string, unknown>, ms, nowMs, { isAlive: this.isAlive, localHost: os.hostname() })) {
          warn(t.path, `automation "${rule}" on board "${t.board}" has been running since ${String(at)} (stale?)`);
        }
      }
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
    if (!dryRun && changes.length) {
      this.emit("ids.fixed", `fixed ${changes.length} id(s)`, {
        changes: changes.map((c) => ({ path: c.path, from: c.from === undefined ? null : String(c.from), to: c.to })),
      });
    }
    return changes;
  }
}

export function createKanban(opts: KanbanOptions): Kanban {
  return new Kanban(opts);
}

export type { AutomationInfo, AutomationLive, AutomationOverview, AutomationLastRun } from "./automation.js";
