import { parse } from "yaml";

export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "ticket";
}

export function filenameFor(id: number | string, name: string): string {
  return `${String(id).padStart(3, "0")}-${slugify(name)}.md`;
}

/** "key:value" → [key, value]; split on first colon, value parsed as YAML. */
export function parseProperty(arg: string): [string, unknown] {
  const i = arg.indexOf(":");
  if (i <= 0) throw new Error(`invalid property "${arg}" (expected key:value)`);
  const key = arg.slice(0, i).trim();
  const raw = arg.slice(i + 1).trim();
  if (raw === "") return [key, ""];
  let value: unknown;
  try {
    value = parse(raw);
  } catch {
    value = raw;
  }
  if (value === undefined || value === null || typeof value === "object") value = raw;
  return [key, value];
}
