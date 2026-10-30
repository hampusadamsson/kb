import path from "node:path";
import { YAMLMap } from "yaml";
import { loadConfig } from "../config.js";
import { idScalar, keyOf, updateFile } from "../frontmatter.js";
import { padId } from "../util.js";
import { duplicates, hasId, idKey, nextId, scan, type Ticket } from "../tickets.js";

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

export function fix(cwd: string, dryRun = false): string {
  const config = loadConfig(cwd);
  const { tickets } = scan(cwd, config);
  const has = hasId;

  const used = new Set(tickets.filter(has).map((t) => idKey(t.id)));
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

  const out: string[] = [];
  for (const t of [...tickets].sort(byAge)) {
    if (has(t) && !losers.has(t)) continue;
    let id: string | undefined;
    if (!has(t)) {
      const m = /^(\d+)[-_ .]/.exec(path.basename(t.path));
      if (m && !used.has(idKey(m[1]))) id = m[1];
    }
    id ??= next();
    used.add(idKey(id));
    pool.push({ id });
    if (!dryRun) setId(path.join(cwd, t.path), id);
    out.push(`${dryRun ? "(dry-run) " : ""}${t.path}: id ${has(t) ? String(t.id) : "(none)"} -> ${id}`);
  }
  return out.length ? out.join("\n") : "nothing to fix";
}
