import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createKanban, hasChanges, KanbanError, parseProperty, type Kanban, type Patch, type Warning } from "../../core/index.js";
import { fmtWarning } from "../format.js";
import { eventOpts } from "../automation.js";

export interface Io {
  warn: (msg: string) => void;
  readStdin: () => string;
  /** kanban factory (e.g. with automations wired); default plain createKanban */
  kanban?: (cwd: string) => Kanban;
}

export const defaultIo: Io = {
  warn: (m) => console.error(m),
  readStdin: () => fs.readFileSync(0, "utf8"),
};

export interface CommonOpts {
  name?: string;
  status?: string;
  board?: string;
  label?: string[];
  property?: string[];
  body?: string;
  comment?: string;
  edit?: boolean;
}
export interface AddOpts extends CommonOpts {
  file?: string;
  id?: string;
}
export interface SetOpts extends CommonOpts {
  unset?: string[];
  unlabel?: string[];
  resetAutomations?: boolean;
}

function props(list: string[] | undefined): Record<string, unknown> | undefined {
  if (!list?.length) return undefined;
  return Object.fromEntries(list.map(parseProperty));
}

const body = (opt: string | undefined, io: Io): string | undefined => (opt === "-" ? io.readStdin() : opt);

const warnAll = (ws: Warning[], io: Io): void => ws.forEach((w) => io.warn(fmtWarning(w)));

/**
 * Turn an $EDITOR value into a command + argv, without a shell.
 * Editor values with arguments are a real usage pattern (`EDITOR="code -w"`), so split on
 * whitespace. The file is passed as a single argv element, so spaces, `$`, backticks and
 * quotes in the path are never interpreted.
 */
export function editorArgv(editor: string, file: string): { command: string; args: string[] } {
  const [command = "vi", ...args] = editor.trim().split(/\s+/).filter(Boolean);
  return { command, args: [...args, file] };
}

export function openEditor(file: string): void {
  const { command, args } = editorArgv(process.env.EDITOR || "vi", file);
  const r = spawnSync(command, args, { stdio: "inherit" });
  if (r.error) throw r.error;
  if (r.status) throw new Error(`editor exited with status ${r.status}`);
}

export function add(cwd: string, name: string | undefined, o: AddOpts, io: Io = defaultIo): string {
  if (name !== undefined && o.name !== undefined && name !== o.name) {
    throw new KanbanError("invalid", "name given twice with different values");
  }
  const kb = (io.kanban ?? ((d) => createKanban({ dir: d, ...eventOpts(d) })))(cwd);
  const r = kb.add({
    name: (o.name ?? name) as string,
    status: o.status,
    board: o.board,
    labels: o.label,
    properties: props(o.property),
    body: body(o.body, io),
    comment: o.comment,
    file: o.file,
    id: o.id,
  });
  warnAll(r.warnings, io);
  if (o.edit) openEditor(path.resolve(cwd, r.path));
  return `#${r.id} ${r.path}`;
}

export function set(cwd: string, id: string, o: SetOpts, io: Io = defaultIo): string {
  const kb = (io.kanban ?? ((d) => createKanban({ dir: d, ...eventOpts(d) })))(cwd);
  const t = kb.get(id);
  const patch: Patch = {
    name: o.name,
    status: o.status,
    board: o.board,
    addLabels: o.label,
    removeLabels: o.unlabel,
    setProps: props(o.property),
    unsetProps: o.unset,
    body: body(o.body, io),
    comment: o.comment,
    resetAutomations: o.resetAutomations ? true : undefined,
  };
  if (hasChanges(patch)) warnAll(kb.update(id, patch).warnings, io);
  else if (!o.edit) kb.update(id, patch); // throws "no changes requested"
  if (o.edit) openEditor(path.join(cwd, t.path));
  return `#${String(t.id ?? "?")} updated`;
}

export function mv(cwd: string, id: string, status: string, io: Io = defaultIo): string {
  return set(cwd, id, { status }, io);
}

export function comment(cwd: string, id: string, text: string, now = new Date()): string {
  return createKanban({ dir: cwd, now: () => now, ...eventOpts(cwd) }).comment(id, text);
}

export function edit(cwd: string, id: string): void {
  openEditor(createKanban({ dir: cwd }).pathOf(id));
}
