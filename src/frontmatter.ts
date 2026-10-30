import fs from "node:fs";
import path from "node:path";
import { Document, parseDocument, Scalar, YAMLMap } from "yaml";

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

export function readFile(file: string): { doc: Document; body: string } {
  const { yaml, body } = splitFrontmatter(fs.readFileSync(file, "utf8"));
  return { doc: parseDocument(yaml ?? ""), body };
}

export function render(doc: Document, body: string): string {
  return `---\n${doc.toString()}---\n${body}`;
}

/** Read, mutate the YAML document, write back. Body is untouched. */
export function updateFile(file: string, fn: (doc: Document) => void): void {
  const { doc, body } = readFile(file);
  if (doc.errors.length) throw new Error(`${file}: ${doc.errors[0].message}`);
  fn(doc);
  fs.writeFileSync(file, render(doc, body));
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
  const taken = (k: string) => map.items.some((p) => String((p.key as Scalar).value ?? p.key) === k);

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

