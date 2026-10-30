import { loadConfig, columnsFor } from "../config.js";
import { duplicates, scan } from "../tickets.js";

export interface ValidateResult {
  out: string;
  errors: number;
  warnings: number;
}

export function validate(cwd: string): ValidateResult {
  const lines: string[] = [];
  let errors = 0;
  let warnings = 0;
  const err = (p: string, m: string) => (errors++, lines.push(`error: ${p}: ${m}`));
  const warn = (p: string, m: string) => (warnings++, lines.push(`warning: ${p}: ${m}`));

  let config;
  try {
    config = loadConfig(cwd);
  } catch (e) {
    errors++;
    lines.push(`error: ${(e as Error).message}`);
    lines.push(`${errors} errors, ${warnings} warnings`);
    return { out: lines.join("\n"), errors, warnings };
  }

  const { tickets, diagnostics } = scan(cwd, config);
  for (const d of diagnostics) err(d.path, d.message);

  for (const t of tickets) {
    if (t.id === undefined || t.id === null) err(t.path, "missing id");
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

  lines.push(errors + warnings === 0 ? "ok" : `${errors} errors, ${warnings} warnings`);
  return { out: lines.join("\n"), errors, warnings };
}
