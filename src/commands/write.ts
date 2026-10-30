import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Document } from "yaml";
import { columnsFor, loadConfig } from "../config.js";
import { addComment, readFile, render } from "../frontmatter.js";
import { findById, nextId, RESERVED, scan } from "../tickets.js";
import { filenameFor, parseProperty, slugify } from "../util.js";

export interface Io {
  warn: (msg: string) => void;
  readStdin: () => string;
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
}

function props(list: string[] | undefined): [string, unknown][] {
  return (list ?? []).map((arg) => {
    const [k, v] = parseProperty(arg);
    if (RESERVED.includes(k)) {
      throw new Error(`property "${k}" is reserved; use its dedicated flag`);
    }
    return [k, v];
  });
}

function bodyText(opt: string, io: Io): string {
  const text = opt === "-" ? io.readStdin() : opt;
  return text === "" || text.endsWith("\n") ? text : text + "\n";
}

export function openEditor(file: string): void {
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  const r = spawnSync(`${editor} "${file.replace(/"/g, '\\"')}"`, { stdio: "inherit", shell: true });
  if (r.error) throw r.error;
  if (r.status) throw new Error(`editor exited with status ${r.status}`);
}

export function add(cwd: string, name: string | undefined, o: AddOpts, io: Io = defaultIo): string {
  if (name !== undefined && o.name !== undefined && name !== o.name) {
    throw new Error("name given twice with different values");
  }
  const nm = o.name ?? name;
  if (nm === undefined || nm === "") throw new Error("name required (positional or -n/--name)");

  const config = loadConfig(cwd);
  const { tickets } = scan(cwd, config);
  const extra = props(o.property);

  let id: number | string;
  if (o.id !== undefined) {
    if (o.id === "") throw new Error("empty --id");
    id = /^\d+$/.test(o.id) ? Number(o.id) : o.id;
    if (tickets.some((t) => t.id !== undefined && String(t.id) === String(id))) {
      throw new Error(`id ${id} already in use`);
    }
  } else {
    id = nextId(tickets);
  }

  const board = o.board ?? config.name;
  const cols = columnsFor(config, board);
  const status = o.status ?? cols[0];
  if (!cols.includes(status)) {
    io.warn(`warning: status "${status}" is not a column of board "${board}"; ticket will be unsorted`);
  }

  const data: Record<string, unknown> = { type: "ticket", id, name: nm, status };
  if (board !== config.name) data.board = board;
  const labels = [...new Set(o.label ?? [])];
  if (labels.length) data.labels = labels;
  for (const [k, v] of extra) data[k] = v;

  const doc = new Document(data);
  if (o.comment !== undefined) addComment(doc, o.comment);

  const rel =
    o.file ??
    (typeof id === "number" ? filenameFor(id, nm) : `${slugify(id)}-${slugify(nm)}.md`);
  const abs = path.resolve(cwd, rel);
  const body = o.body !== undefined ? bodyText(o.body, io) : "";
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  try {
    fs.writeFileSync(abs, render(doc, body), { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${rel} already exists`);
    throw e;
  }
  if (o.edit) openEditor(abs);
  return `#${id} ${path.relative(cwd, abs)}`;
}

export function set(cwd: string, id: string, o: SetOpts, io: Io = defaultIo): string {
  const config = loadConfig(cwd);
  const t = findById(scan(cwd, config).tickets, id);
  const abs = path.join(cwd, t.path);

  const unset = o.unset ?? [];
  for (const k of unset) {
    if (k === "id" || k === "type") throw new Error(`cannot unset "${k}"`);
    if (RESERVED.includes(k)) throw new Error(`cannot --unset "${k}"; use its dedicated flag`);
  }
  const extra = props(o.property);
  const changed =
    o.name !== undefined || o.status !== undefined || o.board !== undefined ||
    o.label?.length || o.unlabel?.length || extra.length || unset.length ||
    o.body !== undefined || o.comment !== undefined;
  if (!changed && !o.edit) throw new Error("no changes requested");

  if (changed) {
    const { doc, body: oldBody } = readFile(abs);
    if (doc.errors.length) throw new Error(`${t.path}: ${doc.errors[0].message}`);
    if (o.name !== undefined) doc.set("name", o.name);
    if (o.board !== undefined) {
      if (o.board === config.name) doc.delete("board");
      else doc.set("board", o.board);
    }
    if (o.status !== undefined || o.board !== undefined) {
      const board = o.board ?? t.board;
      const status = o.status ?? t.status;
      if (status !== undefined && !columnsFor(config, board).includes(status)) {
        io.warn(`warning: status "${status}" is not a column of board "${board}"; ticket will be unsorted`);
      }
      if (o.status !== undefined) doc.set("status", o.status);
    }
    if (o.label?.length) {
      const have = new Set(t.labels);
      const add = [...new Set(o.label)].filter((l) => !have.has(l));
      if (add.length) {
        const cur = doc.get("labels", true);
        if (cur && typeof (cur as { add?: unknown }).add === "function" && Array.isArray((cur as { items?: unknown }).items)) {
          for (const l of add) doc.addIn(["labels"], l);
        } else {
          doc.set("labels", [...t.labels, ...add]);
        }
      }
    }
    if (o.unlabel?.length) {
      const items = (doc.get("labels", true) as { items?: unknown[] } | undefined)?.items;
      if (Array.isArray(items)) {
        const rm = new Set(o.unlabel);
        const kept = t.labels.filter((l) => !rm.has(l));
        if (kept.length === 0) doc.delete("labels");
        else if (kept.length !== t.labels.length) {
          const seq = doc.get("labels", true) as { items: { value?: unknown }[] };
          seq.items = seq.items.filter((n) => !rm.has(String(n.value ?? n)));
        }
      }
    }
    for (const [k, v] of extra) doc.set(k, v);
    for (const k of unset) doc.delete(k);
    if (o.comment !== undefined) addComment(doc, o.comment);
    const body = o.body !== undefined ? bodyText(o.body, io) : oldBody;
    fs.writeFileSync(abs, render(doc, body));
  }
  if (o.edit) openEditor(abs);
  return `#${t.id} updated`;
}

export function mv(cwd: string, id: string, status: string, io: Io = defaultIo): string {
  return set(cwd, id, { status }, io);
}

export function comment(cwd: string, id: string, text: string, now = new Date()): string {
  const config = loadConfig(cwd);
  const t = findById(scan(cwd, config).tickets, id);
  const abs = path.join(cwd, t.path);
  const { doc, body } = readFile(abs);
  if (doc.errors.length) throw new Error(`${t.path}: ${doc.errors[0].message}`);
  const key = addComment(doc, text, now);
  fs.writeFileSync(abs, render(doc, body));
  return key;
}

export function edit(cwd: string, id: string): void {
  const config = loadConfig(cwd);
  const t = findById(scan(cwd, config).tickets, id);
  openEditor(path.join(cwd, t.path));
}
