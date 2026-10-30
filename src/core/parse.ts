import { parse } from "yaml";
import { KanbanError } from "./errors.js";

/** Reusable text syntax for UIs: "key:value" properties and "!" negation in filters. */

/** "key:value" → [key, value]; split on first colon, value parsed as YAML. */
export function parseProperty(arg: string): [string, unknown] {
  const i = arg.indexOf(":");
  if (i <= 0) throw new KanbanError("invalid", `invalid property "${arg}" (expected key:value)`);
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

/** Split a leading "!" (negation) off a filter value. */
export function splitNegation(v: string): [boolean, string] {
  return v.startsWith("!") ? [true, v.slice(1)] : [false, v];
}

/** Property filter spec "key" (exists) or "key:value" → parts. */
export function parsePropertyFilter(spec: string): { key: string; value?: string } {
  const i = spec.indexOf(":");
  return i < 0 ? { key: spec } : { key: spec.slice(0, i), value: spec.slice(i + 1) };
}
