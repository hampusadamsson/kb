import path from "node:path";
import { YAMLMap } from "yaml";
import { loadConfig } from "../config.js";
import { updateFile } from "../frontmatter.js";
import { duplicates, scan, type Ticket } from "../tickets.js";

function setId(file: string, id: number): void {
  updateFile(file, (doc) => {
    if (doc.has("id") || !(doc.contents instanceof YAMLMap)) {
      doc.set("id", id);
      return;
    }
    const items = doc.contents.items;
    const i = items.findIndex((p) => String((p.key as { value?: unknown }).value ?? p.key) === "type");
    items.splice(i + 1, 0, doc.createPair("id", id));
  });
}

const byAge = (a: Ticket, b: Ticket) => a.mtime - b.mtime || a.path.localeCompare(b.path);

export function fix(cwd: string, dryRun = false): string {
  const config = loadConfig(cwd);
  const { tickets } = scan(cwd, config);
  const has = (t: Ticket) => t.id !== undefined && t.id !== null;

  const used = new Set(tickets.filter(has).map((t) => String(t.id)));
  let max = 0;
  for (const t of tickets) {
    if (typeof t.id === "number" && Number.isInteger(t.id) && t.id > max) max = t.id;
  }
  const next = (): number => {
    do max++;
    while (used.has(String(max)));
    return max;
  };

  const losers = new Set<Ticket>();
  for (const g of duplicates(tickets)) for (const t of [...g].sort(byAge).slice(1)) losers.add(t);

  const out: string[] = [];
  for (const t of [...tickets].sort(byAge)) {
    if (has(t) && !losers.has(t)) continue;
    let id: number | undefined;
    if (!has(t)) {
      const m = /^(\d+)[-_ .]/.exec(path.basename(t.path));
      if (m && !used.has(String(Number(m[1])))) id = Number(m[1]);
    }
    id ??= next();
    used.add(String(id));
    if (id > max) max = id;
    if (!dryRun) setId(path.join(cwd, t.path), id);
    out.push(`${dryRun ? "(dry-run) " : ""}${t.path}: id ${has(t) ? String(t.id) : "(none)"} -> ${id}`);
  }
  return out.length ? out.join("\n") : "nothing to fix";
}
