// Pure helpers for the Settings → Automations tab (no DOM access).
import { automationState, effectiveColumn, parseTimeout, timeoutLabel, parseLocal, relativeTime } from "./logic.js";

export const EVENT_OPTIONS = [
  { value: "moved_to", label: "A ticket is moved to…", short: "moves to" },
  { value: "created_in", label: "A ticket is created in…", short: "is created in" },
];

/** Variables offered as insert chips: [name, snippet, tooltip]. */
export const VARIABLES = [
  ["id", "{{ id }}", "Ticket id"],
  ["name", "{{ name }}", "Ticket title"],
  ["body", "{{ body }}", "Ticket body text"],
  ["board", "{{ board }}", "Board the ticket is on"],
  ["status", "{{ status }}", "Column the ticket is in now"],
  ["from", "{{ from }}", "Column it came from (moves only)"],
  ["to", "{{ to }}", "Column it went to / was created in"],
  ["path", "{{ path }}", "Ticket file path"],
  ["labels", "{{ labels }}", "Labels, comma-separated"],
  ["event", "{{ event }}", "moved_to or created_in"],
  ["props.<key>", "{{ props.KEY }}", "A ticket property (replace KEY with the property name)"],
];

/** Starter rules for the empty state. */
export const STARTERS = [
  {
    id: "moved",
    title: "Run a command when a ticket moves to a column",
    detail: "Appends the ticket id to a log file",
    event: "moved_to",
    pick: "last",
    name: "on-move",
    run: "echo {{ id }} moved to {{ to }} >> automation.log",
  },
  {
    id: "created",
    title: "Run a command when a ticket is created in a column",
    detail: "Appends the new ticket's title to a log file",
    event: "created_in",
    pick: "first",
    name: "on-create",
    run: "echo created {{ id }} {{ name }} >> automation.log",
  },
];

/** First free name `base`, `base-2`, … among `rules`. */
export function uniqueName(rules, base) {
  const have = new Set(rules.map((r) => r.name.trim()));
  if (!have.has(base)) return base;
  let n = 2;
  while (have.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** A form rule for a starter template (columns = form column rows). */
export function starterRule(s, cols, rules, newRule) {
  const vals = cols.map((c) => c.value.trim()).filter(Boolean);
  const column = (s.pick === "last" ? vals[vals.length - 1] : vals[0]) ?? "";
  return { ...newRule(cols), event: s.event, column, name: uniqueName(rules, s.name), run: s.run };
}

/** Copy of a rule with a unique "<name>-copy" name; new row (orig null). */
export function duplicateRule(r, rules) {
  return {
    ...r,
    orig: null,
    name: uniqueName(rules, `${r.name.trim() || "rule"}-copy`),
    labels: [...r.labels],
    props: r.props.map((p) => ({ ...p })),
  };
}

/** Text with `snippet` inserted over [start, end); returns { value, start, end } (new selection; KEY placeholders stay selected). */
export function insertAtCursor(value, start, end, snippet) {
  const a = Math.max(0, Math.min(start ?? value.length, value.length));
  const b = Math.max(a, Math.min(end ?? a, value.length));
  const sep = a > 0 && !/\s/.test(value[a - 1]) ? " " : ""; // keep placeholders separate from the previous word
  const next = value.slice(0, a) + sep + snippet + value.slice(b);
  const key = snippet.indexOf("KEY");
  if (key >= 0) return { value: next, start: a + sep.length + key, end: a + sep.length + key + 3 };
  const at = a + sep.length + snippet.length;
  return { value: next, start: at, end: at };
}

const oneLine = (s, n) => {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** "!x" → "not x" */
const propText = (p) => (p.value.startsWith("!") ? `${p.key.trim()} not ${p.value.slice(1)}` : `${p.key.trim()} = ${p.value}`);

/** Steps of a rule's script: a plain string `run` is a single step. */
export const ruleSteps = (run) => (Array.isArray(run) ? run : [run]);

/** Script as one short label: a step list becomes "3 steps". */
export const runLabel = (run) => (Array.isArray(run) ? `${run.length} step${run.length === 1 ? "" : "s"}` : run);

/** One-line human summary of a rule (column = effective column). */
export function ruleSummary(r, column = r.column) {
  const ev = EVENT_OPTIONS.find((e) => e.value === r.event) ?? EVENT_OPTIONS[0];
  const parts = [`When a ticket ${ev.short} ${column || "(no column)"}`];
  const labels = r.labels.map((l) => l.trim()).filter(Boolean);
  if (labels.length) parts.push(`labels: ${labels.join(", ")}`);
  const props = r.props.filter((p) => p.key.trim());
  if (props.length) parts.push(props.map(propText).join(", "));
  const run = oneLine(runLabel(r.run), 60);
  parts.push(run ? `runs ${run}` : "no script yet");
  const to = timeoutLabel(parseTimeout(r.timeout).seconds);
  if (to) parts.push(`timeout ${to}`);
  return parts.join(" · ");
}

/** Per-field problems of a rule: { name?, run?, column? } (messages, empty object = valid). */
export function ruleIssues(r, rules, cols) {
  const out = {};
  const name = r.name.trim();
  if (!name) out.name = "Give the automation a name.";
  else if (rules.some((o) => o !== r && o.name.trim() === name)) out.name = `Another automation on this board is already called "${name}".`;
  if (ruleSteps(r.run).every((s) => !s.trim())) out.run = "Enter the script to run.";
  const te = parseTimeout(r.timeout).error;
  if (te) out.timeout = te;
  const col = effectiveColumn(cols, r.column);
  const have = cols.map((c) => c.value.trim()).filter(Boolean);
  if (!col) out.column = "Choose a column.";
  else if (!have.includes(col)) out.column = `Column "${col}" no longer exists on this board.`;
  return out;
}

/** Display name of a rule. */
export const ruleTitle = (r) => r.name.trim() || "Untitled automation";

/** Case-insensitive filter over name, script and column. */
export function filterRules(rules, q) {
  const s = String(q ?? "")
    .trim()
    .toLowerCase();
  if (!s) return rules;
  return rules.filter((r) => [r.name, ruleSteps(r.run).join(" "), r.column, ...r.labels].some((x) => String(x).toLowerCase().includes(s)));
}

/** Rules with problems. */
export const invalidCount = (rules, cols) => rules.filter((r) => Object.keys(ruleIssues(r, rules, cols)).length).length;

/** "3 rules" / "1 rule" */
export const ruleCount = (n) => `${n} rule${n === 1 ? "" : "s"}`;

/**
 * Latest run per rule name from board tickets' `autos` ([{name,status,at,exit,error}]).
 * → Map name → { state, at, exit, error }.
 */
export function lastRuns(tickets) {
  const out = new Map();
  for (const t of tickets ?? []) {
    for (const a of t.autos ?? []) {
      const at = +(parseLocal(a.at) ?? -Infinity);
      const cur = out.get(a.name);
      const state = automationState(a);
      if (cur && cur.state === "running" && state !== "running") continue; // a running entry wins
      if (cur && (cur.state === "running") === (state === "running") && at <= cur.ms) continue;
      out.set(a.name, { state: automationState(a), at: a.at ?? null, exit: a.exit ?? null, error: a.error ? "failed" : "", ms: at });
    }
  }
  return out;
}

/** Status chip text: "done 3 min ago", "failed", "never run"... */
export function statusText(run, now = new Date()) {
  if (!run) return "never run";
  const rel = run.state === "running" ? "" : relativeTime(run.at, now);
  const word = run.state === "skipped" ? "skipped" : run.state === "unknown" ? "unknown" : run.state;
  return rel ? `${word} ${rel}` : word;
}

const shellQuote = (s) => `'${String(s).replace(/\0/g, "").replace(/'/g, `'\\''`)}'`;

/** Sample ticket used by test runs and the preview. */
export function sampleFor(r, column = r.column, board = "") {
  const props = {};
  for (const p of r.props) if (p.key.trim() && !p.value.startsWith("!")) props[p.key.trim()] = p.value;
  const labels = r.labels.map((l) => l.trim()).filter(Boolean);
  return { to: column, labels, props, board };
}

/** The script with placeholders replaced by shell-quoted sample values (mirrors the server). "" if nothing to show. */
export function previewScript(run, sample, event) {
  const vars = {
    id: "000",
    name: "Sample ticket",
    body: "Sample body",
    board: sample.board || "",
    status: sample.to,
    from: event === "moved_to" ? "todo" : "",
    to: sample.to,
    path: "sample.md",
    labels: sample.labels.join(","),
    event,
  };
  return run.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (m, name) => {
    if (name.startsWith("props.")) return shellQuote(sample.props[name.slice(6)] ?? "");
    return Object.hasOwn(vars, name) ? shellQuote(vars[name]) : m;
  });
}

/** Test-run duration "0.4 s" / "120 ms". */
export const durationText = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
