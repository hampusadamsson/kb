import fs from "node:fs";
import path from "node:path";
import { Document, parseDocument, Scalar, YAMLMap, type Pair } from "yaml";
import { KanbanError } from "./errors.js";

/** yaml options: never print warnings to the process (real errors stay in doc.errors). */
export const YAML_OPTS = { logLevel: "error" } as const;

const FM_RE = /^---\r?\n(?:([\s\S]*?\r?\n)?)---[ \t]*(?:\r?\n|$)/;

export interface Split {
  /** frontmatter YAML text, or undefined if the file has none */
  yaml: string | undefined;
  body: string;
}

export function splitFrontmatter(text: string): Split {
  const m = FM_RE.exec(text);
  if (!m) return { yaml: undefined, body: text };
  return { yaml: m[1] ?? "", body: text.slice(m[0].length) };
}

/** Key of a YAML map pair as a string. */
export function keyOf(p: Pair): string {
  return String((p.key as Scalar | null)?.value ?? p.key);
}

export function readFile(file: string): { doc: Document; body: string; crlf: boolean } {
  const text = fs.readFileSync(file, "utf8");
  const { yaml, body } = splitFrontmatter(text);
  return { doc: parseDocument(yaml ?? "", YAML_OPTS), body, crlf: text.startsWith("---\r\n") };
}

/** Render frontmatter + body. With crlf, frontmatter uses CRLF; body is untouched. */
export function render(doc: Document, body: string, crlf = false): string {
  const fm = `---\n${doc.toString({ lineWidth: 0 })}---\n`;
  return (crlf ? fm.replace(/\n/g, "\r\n") : fm) + body;
}

/** Read, mutate the YAML document, write back. Body is untouched. */
export function updateFile(file: string, fn: (doc: Document) => void): void {
  const { doc, body, crlf } = readFile(file);
  if (doc.errors.length) throw new KanbanError("parse", `${file}: ${doc.errors[0].message}`);
  fn(doc);
  fs.writeFileSync(file, render(doc, body, crlf));
}

/** Id as a double-quoted string scalar (so "001" is not read back as 1). */
export function idScalar(id: string): Scalar {
  const s = new Scalar(id);
  s.type = Scalar.QUOTE_DOUBLE;
  return s;
}

/** Create a new file (parent dirs created); fails if it exists. */
export function createFile(file: string, data: Record<string, unknown>, body = ""): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const doc = new Document(data);
  fs.writeFileSync(file, render(doc, body), { flag: "wx" });
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local time as YYYY-MM-DDTHH:MM or, with seconds, YYYY-MM-DDTHH:MM:SS. */
export function commentKey(d: Date, seconds = false): string {
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return seconds ? `${base}:${pad(d.getSeconds())}` : base;
}

/** Append a comment; returns the key used. */
export function addComment(doc: Document, text: string, now = new Date()): string {
  let comments = doc.get("comments", true);
  if (!(comments instanceof YAMLMap)) {
    comments = new YAMLMap();
    doc.set("comments", comments);
  }
  const map = comments as YAMLMap;
  const taken = (k: string) => map.items.some((p) => keyOf(p) === k);

  let key = commentKey(now);
  let t = now;
  if (taken(key)) {
    key = commentKey(t, true);
    while (taken(key)) {
      t = new Date(t.getTime() + 1000);
      key = commentKey(t, true);
    }
  }
  const keyNode = new Scalar(key);
  // Seconds form would be read as a timestamp by YAML 1.1 parsers; quote it.
  if (key.length > 16) keyNode.type = Scalar.QUOTE_DOUBLE;
  map.add(doc.createPair(keyNode, new Scalar(text)));
  return key;
}
