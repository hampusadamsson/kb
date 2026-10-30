// Pure helpers for the "What is a ticket?" editor (tickets rules in kanban.yaml). No DOM access.

export const DEFAULT_TICKETS = { baseline: true, include: [], exclude: [] };

const ruleToForm = (r) => ({
  name: r.name ?? "",
  glob: r.glob ?? "",
  prefix: r.prefix ?? "",
  props: Object.entries(r.props ?? {}).map(([key, raw]) => ({ key, value: String(raw), raw })),
  has: [...(r.has ?? [])],
});

/** A blank rule (form shape). */
export const newTicketRule = () => ({ name: "", glob: "", prefix: "", props: [], has: [] });

/** config.tickets (may be undefined) → editable form state. */
export function ticketsToForm(t) {
  return {
    baseline: t?.baseline !== false,
    include: (t?.include ?? []).map(ruleToForm),
    exclude: (t?.exclude ?? []).map(ruleToForm),
  };
}

/** Form rule → config rule (blank fields dropped; untouched prop values keep their number/boolean type). */
export function ruleToConfig(r) {
  const out = {};
  if (r.name.trim()) out.name = r.name.trim();
  if (r.glob.trim()) out.glob = r.glob.trim();
  if (r.prefix !== "") out.prefix = r.prefix;
  const props = {};
  for (const p of r.props) {
    const k = p.key.trim();
    if (k) props[k] = p.raw !== undefined && String(p.raw) === p.value ? p.raw : p.value;
  }
  if (Object.keys(props).length) out.props = props;
  const has = r.has.map((s) => s.trim()).filter(Boolean);
  if (has.length) out.has = has;
  return out;
}

/** Form state → the `tickets` payload. Always a full object (the server keeps current rules if the key is omitted). */
export function ticketsToConfig(f) {
  return { baseline: f.baseline !== false, include: f.include.map(ruleToConfig), exclude: f.exclude.map(ruleToConfig) };
}

/** True when the payload equals the default (baseline, no rules). */
export const isDefaultTickets = (c) => c.baseline === true && c.include.length === 0 && c.exclude.length === 0;

export const hasCondition = (r) => Object.keys(ruleToConfig(r)).some((k) => k !== "name");

function balanced(g) {
  const pairs = { ")": "(", "]": "[", "}": "{" };
  const stack = [];
  for (const ch of g) {
    if ("([{".includes(ch)) stack.push(ch);
    else if (ch in pairs && stack.pop() !== pairs[ch]) return false;
  }
  return stack.length === 0;
}

/** Problem with one rule (message without the rule's label) or "". */
export function checkRule(r) {
  const c = ruleToConfig(r);
  if (!hasCondition(r)) return "needs at least one condition (folder, filename prefix, property or has-property).";
  if (c.glob !== undefined) {
    if (c.glob.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(c.glob)) return "glob must be relative to this folder.";
    if (c.glob.split(/[\\/]/).includes("..")) return 'glob must not contain "..".';
    if (!balanced(c.glob)) return "glob has unbalanced brackets.";
  }
  if (c.prefix !== undefined && /[\\/]/.test(c.prefix)) return "filename prefix must not contain a slash.";
  if (r.has.some((s) => s.trim() === "")) return "has-property entries must not be empty.";
  return "";
}

/** Label for messages: `include rule 2 "name"`. */
export const ruleLabel = (kind, i, r) => `${kind} rule ${i + 1}${r.name.trim() ? ` "${r.name.trim()}"` : ""}`;

export const TICKET_RULES_PREFIX = "Ticket rules: ";

/** First problem in the tickets form state, or "". */
export function checkTickets(f) {
  for (const kind of ["include", "exclude"]) {
    for (let i = 0; i < f[kind].length; i++) {
      const p = checkRule(f[kind][i]);
      if (p) return `${TICKET_RULES_PREFIX}${ruleLabel(kind, i, f[kind][i])} ${p}`;
    }
  }
  return "";
}

/** One-line description: "Files in tasks/**\/*.md whose name starts with T- and kind = task". */
export function summarizeRule(r) {
  const c = ruleToConfig(r);
  if (!hasCondition(r)) return "No conditions yet.";
  const conds = [];
  if (c.prefix !== undefined) conds.push(`name starts with ${c.prefix}`);
  for (const [k, v] of Object.entries(c.props ?? {})) {
    const s = String(v);
    conds.push(s.startsWith("!") ? `${k} ≠ ${s.slice(1)}` : `${k} = ${s}`);
  }
  for (const k of c.has ?? []) conds.push(k.startsWith("!") ? `has no ${k.slice(1)}` : `has ${k}`);
  let text = c.glob !== undefined ? `Files in ${c.glob}` : "Files";
  if (conds.length) text += `${c.prefix !== undefined ? " whose " : " where "}${conds.join(" and ")}`;
  return text;
}

export const PRESETS = {
  include: [
    { id: "folder", label: "A folder…", rule: { glob: "tasks/**/*.md" } },
    { id: "property", label: "Files with a property…", rule: { props: { kind: "task" } } },
    { id: "prefix", label: "Filename prefix…", rule: { prefix: "T-" } },
  ],
  exclude: [
    { id: "templates", label: "Templates folder (templates/**)", rule: { glob: "templates/**" } },
    { id: "daily", label: "Daily notes (type: daily)", rule: { props: { type: "daily" } } },
    { id: "underscore", label: "Files starting with _", rule: { prefix: "_" } },
  ],
};

/** A new form rule from a preset id of a list kind ("include" | "exclude"); null if unknown. */
export function presetRule(kind, id) {
  const p = (PRESETS[kind] ?? []).find((x) => x.id === id);
  return p ? ticketsToForm({ [kind]: [p.rule] })[kind][0] : null;
}

const plural = (n, one, many) => (n === 1 ? one : many);

/** Preview response → "N files become tickets, M stop being tickets (total T)". */
export function previewText(p) {
  const g = p.gained ?? 0;
  const l = p.lost ?? 0;
  const total = `(total ${p.total})`;
  if (!g && !l) return `No change to which files are tickets ${total}`;
  return `${g} ${plural(g, "file becomes a ticket", "files become tickets")}, ${l} ${plural(l, "file stops", "files stop")} being ${plural(l, "a ticket", "tickets")} ${total}`;
}

/** Confirm-box lines for PUT dryRun ticketScope; [] when nothing changes. */
export function scopeLines(scope) {
  const g = scope?.gained ?? 0;
  const l = scope?.lost ?? 0;
  const out = [];
  if (g > 0) out.push(`${g} ${plural(g, "file will become a ticket", "files will become tickets")}`);
  if (l > 0) out.push(`${l} ${plural(l, "file will stop being a ticket", "files will stop being tickets")}`);
  return out;
}

export const noTicketsWarning = (f) => (f.baseline === false && f.include.length === 0 ? "No files will count as tickets." : "");
