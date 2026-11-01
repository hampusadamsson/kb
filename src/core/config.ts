import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { KanbanError } from "./errors.js";
import { YAML_OPTS } from "./frontmatter.js";

export const CONFIG_FILE = "kanban.yaml";

const columnsSchema = z.array(z.string()).min(1, "columns must not be empty");

export const MAX_TIMEOUT_SECONDS = 86400;
const TIMEOUT_MSG = `timeout must be a whole number of seconds from 0 to ${MAX_TIMEOUT_SECONDS} (0 = no timeout)`;

export const automationSchema = z.object({
  name: z.string(),
  when: z
    .object({
      moved_to: z.string().optional(),
      created_in: z.string().optional(),
      labels: z.array(z.string()).optional(),
      props: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    })
    .refine((w) => (w.moved_to !== undefined) !== (w.created_in !== undefined), {
      message: "when needs exactly one of moved_to / created_in",
    }),
  /** one shell command, or a list of steps run sequentially */
  run: z.union([z.string(), z.array(z.string()).min(1)]),
  enabled: z.boolean().optional(),
  /** keep going after a failing step (default false: stop and fail) */
  continueOnError: z.boolean().optional(),
  /** loop guard (default true): stop after AUTOMATION_RUN_LIMIT runs per ticket; false opts out */
  guard: z.boolean().optional(),
  /** per-run timeout in whole seconds; 0 or absent = no timeout */
  timeout: z.number({ error: TIMEOUT_MSG }).int(TIMEOUT_MSG).min(0, TIMEOUT_MSG).max(MAX_TIMEOUT_SECONDS, TIMEOUT_MSG).optional(),
});

const automationsSchema = z.array(automationSchema).optional();

export type Automation = z.infer<typeof automationSchema>;

// ---- ticket rules ----

const relGlob = z
  .string()
  .trim()
  .min(1, "glob must not be empty")
  .refine((g) => !g.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(g), "glob must be relative to the kanban dir")
  .refine((g) => !g.split(/[\\/]/).includes(".."), 'glob must not contain ".."');

export const ticketRuleSchema = z
  .object({
    name: z.string().optional(),
    glob: relGlob.optional(),
    prefix: z
      .string()
      .min(1, "prefix must not be empty")
      .refine((p) => !/[\\/]/.test(p), "prefix is a file name prefix and must not contain a slash")
      .optional(),
    props: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    has: z.array(z.string().min(1, "has: empty key")).optional(),
  })
  .refine((r) => r.glob !== undefined || r.prefix !== undefined || Object.keys(r.props ?? {}).length > 0 || (r.has ?? []).length > 0, {
    message: "a rule needs at least one condition (glob, prefix, props or has)",
  });

export const ticketRulesSchema = z.object({
  baseline: z.boolean().default(true),
  include: z.array(ticketRuleSchema).default([]),
  exclude: z.array(ticketRuleSchema).default([]),
});

export type TicketRule = z.infer<typeof ticketRuleSchema>;
export type TicketRules = z.infer<typeof ticketRulesSchema>;
export type TicketRulesInput = z.input<typeof ticketRulesSchema>;

const issueText = (issues: z.core.$ZodIssue[], prefix = "") =>
  issues.map((i) => `${prefix}${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");

/** Validate raw `tickets` input; messages name the offending rule (index and name). */
export function parseTicketRules(raw: unknown): TicketRules {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new KanbanError("invalid", "invalid tickets: expected an object");
  }
  const r = raw as Record<string, unknown>;
  const problems: string[] = [];
  if (r.baseline !== undefined && typeof r.baseline !== "boolean") problems.push("tickets.baseline: must be a boolean");
  for (const kind of ["include", "exclude"] as const) {
    const list = r[kind];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      problems.push(`tickets.${kind}: must be a list`);
      continue;
    }
    list.forEach((rule, i) => {
      const res = ticketRuleSchema.safeParse(rule);
      if (res.success) return;
      const nm =
        rule && typeof rule === "object" && typeof (rule as { name?: unknown }).name === "string"
          ? ` "${(rule as { name: string }).name}"`
          : "";
      problems.push(issueText(res.error.issues, `tickets.${kind}[${i}]${nm}: `));
    });
  }
  if (problems.length) throw new KanbanError("invalid", `invalid tickets: ${problems.join("; ")}`);
  return ticketRulesSchema.parse(raw);
}

export const DEFAULT_TICKET_RULES: TicketRules = { baseline: true, include: [], exclude: [] };

export const isDefaultTicketRules = (t: TicketRulesInput | undefined): boolean =>
  !t || ((t.baseline ?? true) && !(t.include ?? []).length && !(t.exclude ?? []).length);

export function ticketRules(config: { tickets?: TicketRulesInput }): TicketRules {
  return ticketRulesSchema.parse(config.tickets ?? {});
}

const toPosix = (p: string) => p.split(path.sep).join("/");

/** Glob test that never throws (invalid pattern = no match). */
export function globMatches(rel: string, glob: string): boolean {
  try {
    return path.matchesGlob(toPosix(rel), glob);
  } catch {
    return false;
  }
}

/** node's glob never throws, so check structure: balanced [] and {} (backslash escapes). */
export function isValidGlob(glob: string): boolean {
  let br = 0;
  let cb = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "\\") i++;
    else if (c === "[") br++;
    else if (c === "]" && br > 0) br--;
    else if (c === "{" && br === 0) cb++;
    else if (c === "}" && br === 0) cb--;
    if (cb < 0) return false;
  }
  return br === 0 && cb === 0;
}

const isPathOnly = (r: TicketRule) => Object.keys(r.props ?? {}).length === 0 && (r.has ?? []).length === 0;

const propEquals = (v: unknown, want: string): boolean =>
  Array.isArray(v) ? v.some((e) => String(e) === want) : v != null && String(v) === want;

const present = (v: unknown) => v !== undefined && v !== null;

/** All conditions of a rule (AND). Without `data`, props/has are evaluated against an empty file. */
function ruleMatches(r: TicketRule, rel: string, data: Record<string, unknown> | undefined): boolean {
  const p = toPosix(rel);
  if (r.glob !== undefined && !globMatches(p, r.glob)) return false;
  if (r.prefix !== undefined && !p.slice(p.lastIndexOf("/") + 1).startsWith(r.prefix)) return false;
  for (const [k, val] of Object.entries(r.props ?? {})) {
    const neg = typeof val === "string" && val.startsWith("!");
    const want = neg ? String(val).slice(1) : String(val);
    if (propEquals(data?.[k], want) === neg) return false;
  }
  for (const h of r.has ?? []) {
    const neg = h.startsWith("!");
    if (present(data?.[neg ? h.slice(1) : h]) === neg) return false;
  }
  return true;
}

const HARD_EXCLUDED = new Set(["node_modules", ".kb"]);
const hardExcluded = (rel: string) =>
  toPosix(rel)
    .split("/")
    .some((s) => HARD_EXCLUDED.has(s));

const includeApplies = (r: TicketRule, rel: string, topGlob: string | undefined) =>
  r.glob !== undefined || topGlob === undefined || globMatches(rel, topGlob);

/** Excluded by an exclude rule that needs only the path (decidable without parsing). */
export function isPathExcluded(rules: TicketRulesInput, relPath: string): boolean {
  if (hardExcluded(relPath)) return true;
  return (rules.exclude ?? []).some((r) => isPathOnly(r) && ruleMatches(r, relPath, undefined));
}

/** Included by an include rule that needs only the path. */
export function isPathIncluded(rules: TicketRulesInput, relPath: string, topGlob?: string): boolean {
  return (
    relPath.endsWith(".md") &&
    (rules.include ?? []).some((r) => isPathOnly(r) && includeApplies(r, relPath, topGlob) && ruleMatches(r, relPath, undefined))
  );
}

/**
 * Is this file a ticket? Pure. `data` = parsed frontmatter (undefined: none).
 * ticket = not excluded AND ((baseline && type === "ticket" && inside topGlob) OR any include rule matches).
 * Without `topGlob` every path counts as inside it.
 */
export function isTicketFile(
  rules: TicketRulesInput,
  relPath: string,
  data: Record<string, unknown> | undefined,
  topGlob?: string,
): boolean {
  if (hardExcluded(relPath)) return false;
  if ((rules.exclude ?? []).some((r) => ruleMatches(r, relPath, data))) return false;
  const inTop = topGlob === undefined || globMatches(relPath, topGlob);
  if ((rules.baseline ?? true) && inTop && data?.type === "ticket") return true;
  return relPath.endsWith(".md") && (rules.include ?? []).some((r) => includeApplies(r, relPath, topGlob) && ruleMatches(r, relPath, data));
}

/** Globs the scan walks: the top-level glob plus every include rule's glob. */
export function scanGlobs(config: { glob: string; tickets?: TicketRulesInput }): string[] {
  const globs = [config.glob];
  for (const r of config.tickets?.include ?? []) if (r.glob !== undefined && !globs.includes(r.glob)) globs.push(r.glob);
  return globs;
}

/** Optional `web` block: defaults for the web UI host/port (CLI flags win). */
export const webSchema = z.object({
  host: z.string().min(1).optional(),
  port: z.number().int().min(0).max(65535).optional(),
});

const configSchema = z.object({
  name: z.string().default("default"),
  columns: columnsSchema,
  glob: z.string().default("*.md"),
  tickets: ticketRulesSchema.optional(),
  automations: automationsSchema,
  boards: z.record(z.string(), z.object({ columns: columnsSchema, automations: automationsSchema })).optional(),
  web: webSchema.optional(),
});

export type Config = z.infer<typeof configSchema>;
export type WebConfig = NonNullable<Config["web"]>;

export const STARTER_CONFIG = `name: default
columns: [todo, doing, done]
glob: "*.md"
`;

export function loadConfig(cwd: string): Config {
  const file = path.join(cwd, CONFIG_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new KanbanError("config", `${CONFIG_FILE} not found in ${cwd} (run \`kb init\`)`);
  }
  let data: unknown;
  try {
    data = parse(text, YAML_OPTS);
  } catch (e) {
    throw new KanbanError("config", `${CONFIG_FILE}: invalid YAML: ${(e as Error).message}`);
  }
  const result = configSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new KanbanError("config", `${CONFIG_FILE}: invalid config: ${issues}`);
  }
  return result.data;
}

/** Automations of a board; not inherited from the default board. */
export function automationsFor(config: Config, board: string): Automation[] {
  if (board === config.name) return config.automations ?? [];
  return config.boards?.[board]?.automations ?? [];
}

export function columnsFor(config: Config, board: string): string[] {
  return config.boards?.[board]?.columns ?? config.columns;
}
