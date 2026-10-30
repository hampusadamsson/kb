// Pure logic (no DOM access): hash state, filter queries, scalar conversion, patch building.

/** Parse `#board=x&text=..&l=a&p=k:v` into a filter state. board === null means "default". */
export function parseHash(hash) {
  const params = new URLSearchParams(String(hash ?? "").replace(/^#/, ""));
  return {
    board: params.has("board") ? params.get("board") : null,
    text: params.get("text") ?? "",
    labels: params.getAll("l").filter((s) => s !== ""),
    props: params.getAll("p").filter((s) => s !== ""),
  };
}

/** Inverse of parseHash. Returns "" for the empty state. */
export function serializeHash(f) {
  const params = new URLSearchParams();
  if (f.board !== null && f.board !== undefined) params.set("board", f.board);
  if (f.text) params.set("text", f.text);
  for (const l of f.labels ?? []) params.append("l", l);
  for (const p of f.props ?? []) params.append("p", p);
  const s = params.toString().replace(/%3A/gi, ":").replace(/%21/g, "!");
  return s ? "#" + s : "";
}

/** Query string for GET /api/board (board selection is done client side). */
export function filterQuery(f) {
  const params = new URLSearchParams();
  if (f.text) params.set("text", f.text);
  for (const l of f.labels ?? []) params.append("label", l);
  for (const p of f.props ?? []) params.append("property", p);
  return params.toString();
}

export const hasFilters = (f) => Boolean(f.text) || f.labels.length > 0 || f.props.length > 0;

/** "3" → 3, "true"/"false" → boolean, anything else stays a string. */
export function toScalar(s) {
  if (s === "true") return true;
  if (s === "false") return false;
  // leading zeros ("007") stay strings so they round-trip
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return s;
}

/** How a stored property value is shown in inputs and chips. */
export function display(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Editable values from a ticket detail. */
export function snapshot(d) {
  const props = {};
  for (const [k, v] of Object.entries(d.props ?? {})) props[k] = display(v);
  return {
    name: d.name ?? "",
    status: d.status ?? "",
    board: d.board ?? "",
    body: d.body ?? "",
    labels: [...(d.labels ?? [])],
    props,
  };
}

/** Normalize form rows [{k,v}] into a props map (blank keys dropped, last wins). */
export function rowsToProps(rows) {
  const out = {};
  for (const { k, v } of rows) {
    const key = k.trim();
    if (key) out[key] = v;
  }
  return out;
}

/** Only changed fields, in API patch shape (without mtime). */
export function buildPatch(orig, cur) {
  const p = {};
  if (cur.name !== orig.name) p.name = cur.name;
  if (cur.status !== orig.status && cur.status !== "") p.status = cur.status;
  if (cur.board !== orig.board && cur.board !== "") p.board = cur.board;
  if (cur.body !== orig.body) p.body = cur.body;
  const add = cur.labels.filter((l) => !orig.labels.includes(l));
  const rem = orig.labels.filter((l) => !cur.labels.includes(l));
  if (add.length) p.addLabels = add;
  if (rem.length) p.removeLabels = rem;
  const set = {};
  for (const [k, v] of Object.entries(cur.props)) {
    if (!(k in orig.props) || orig.props[k] !== v) set[k] = toScalar(v);
  }
  const unset = Object.keys(orig.props).filter((k) => !(k in cur.props));
  if (Object.keys(set).length) p.setProps = set;
  if (unset.length) p.unsetProps = unset;
  return p;
}

export const hasPatch = (p) => Object.keys(p).length > 0;

/** POST /api/tickets body from form values. */
export function buildCreate(v, comment) {
  const b = { name: v.name.trim() };
  if (v.status) b.status = v.status;
  if (v.board.trim()) b.board = v.board.trim();
  if (v.labels.length) b.labels = v.labels;
  const props = Object.entries(v.props);
  if (props.length) b.properties = Object.fromEntries(props.map(([k, val]) => [k, toScalar(val)]));
  if (v.body) b.body = v.body;
  if (comment && comment.trim()) b.comment = comment.trim();
  return b;
}

/** Comments object → [key, text] sorted oldest first. */
export const sortedComments = (c) => Object.entries(c ?? {}).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

/** Status columns to offer for a board; includes the current value if it isn't a column. */
export function statusOptions(columns, current) {
  const opts = [...columns];
  if (current && !opts.includes(current)) opts.push(current);
  return opts;
}

/** Fix change line: `path: id from → to`. */
export function describeChange(c) {
  const from = c.from === undefined || c.from === null || c.from === "" ? "(none)" : String(c.from);
  return `${c.path}: id ${from} → ${c.to}`;
}

// ---- settings (kanban.yaml form) ----

const colValues = (rows) => rows.map((r) => r.value.trim()).filter((v) => v !== "");
const colRows = (cols) => cols.map((c) => ({ orig: c, value: c }));

const ruleRow = (a) => ({
  orig: a.name,
  name: a.name,
  event: a.when.created_in !== undefined ? "created_in" : "moved_to",
  column: a.when.created_in ?? a.when.moved_to ?? "",
  labels: [...(a.when.labels ?? [])],
  props: Object.entries(a.when.props ?? {}).map(([key, raw]) => ({ key, value: String(raw), raw })),
  run: a.run,
  enabled: a.enabled !== false,
});

/** A blank rule for a board whose columns are `cols` (form rows). */
export const newRule = (cols) => ({
  orig: null,
  name: "",
  event: "moved_to",
  column: colValues(cols)[0] ?? "",
  labels: [],
  props: [],
  run: "",
  enabled: true,
});

/** GET /api/config → editable form state. `orig` = name in the file (null for new rows). */
export function configToForm(c) {
  return {
    name: c.name,
    glob: c.glob,
    columns: colRows(c.columns),
    automations: (c.automations ?? []).map(ruleRow),
    boards: Object.entries(c.boards ?? {}).map(([n, b]) => ({
      orig: n,
      name: n,
      columns: colRows(b.columns),
      automations: (b.automations ?? []).map(ruleRow),
    })),
  };
}

/** Column a rule points at after in-form column renames (rows keep their `orig`). */
export function effectiveColumn(rows, column) {
  const row = rows.find((r) => r.orig === column && r.value.trim() !== "");
  return row ? row.value.trim() : column;
}

/** Form rule → config automation object (typed prop values preserved when unchanged). */
function ruleToConfig(r, cols) {
  const when = { [r.event]: effectiveColumn(cols, r.column) };
  const labels = r.labels.map((l) => l.trim()).filter(Boolean);
  if (labels.length) when.labels = labels;
  const props = {};
  for (const p of r.props) {
    const k = p.key.trim();
    if (k) props[k] = p.raw !== undefined && String(p.raw) === p.value ? p.raw : p.value;
  }
  if (Object.keys(props).length) when.props = props;
  const out = { name: r.name.trim(), when, run: r.run };
  if (!r.enabled) out.enabled = false;
  return out;
}

const rulesToConfig = (rules, cols) => (rules ?? []).map((r) => ruleToConfig(r, cols));

/** Rows that were renamed: { oldName: newName } (blank new names are not renames, they are removals). */
function renamedColumns(rows) {
  const out = {};
  for (const r of rows) {
    const v = r.value.trim();
    if (r.orig !== null && v !== "" && v !== r.orig) out[r.orig] = v;
  }
  return out;
}


/** Form state → PUT /api/config payload parts: { config, renames }. */
export function formToPayload(f) {
  const config = { name: f.name.trim(), glob: f.glob.trim(), columns: colValues(f.columns), boards: {} };
  if (f.automations?.length) config.automations = rulesToConfig(f.automations, f.columns);
  const renames = { columns: {}, boards: {} };
  const top = renamedColumns(f.columns);
  if (Object.keys(top).length) renames.columns[""] = top;
  for (const b of f.boards) {
    const name = b.name.trim();
    config.boards[name] = { columns: colValues(b.columns) };
    if (b.automations?.length) config.boards[name].automations = rulesToConfig(b.automations, b.columns);
    if (b.orig !== null) {
      if (name !== b.orig) renames.boards[b.orig] = name;
      const m = renamedColumns(b.columns);
      if (Object.keys(m).length) renames.columns[b.orig] = m;
    }
  }
  return { config, renames };
}

/** Has the form changed relative to the loaded config? */
export const formDirty = (f, loaded) => JSON.stringify(formToPayload(f)) !== JSON.stringify(formToPayload(configToForm(loaded)));

/** Client-side checks that give friendlier errors than the server's; returns a message or "". */
export function checkForm(f) {
  const p = formToPayload(f).config;
  if (!p.name) return "Board name must not be empty.";
  if (!p.glob) return "Glob must not be empty.";
  const dup = (a) => a.find((v, i) => a.indexOf(v) !== i);
  if (p.columns.length === 0) return "Columns must not be empty.";
  if (dup(p.columns) !== undefined) return `Duplicate column "${dup(p.columns)}".`;
  const names = f.boards.map((b) => b.name.trim());
  if (names.some((n) => n === "")) return "Board override names must not be empty.";
  if (dup(names) !== undefined) return `Duplicate board "${dup(names)}".`;
  for (const [n, b] of Object.entries(p.boards)) {
    if (b.columns.length === 0) return `Board "${n}" needs at least one column.`;
    if (dup(b.columns) !== undefined) return `Board "${n}": duplicate column "${dup(b.columns)}".`;
  }
  const targets = [{ board: p.name, rules: f.automations ?? [], cols: f.columns }, ...f.boards.map((b) => ({ board: b.name.trim(), rules: b.automations ?? [], cols: b.columns }))];
  for (const t of targets) {
    const err = checkRules(t.board, t.rules, t.cols);
    if (err) return err;
  }
  return "";
}

/** Move item i of a list by delta (-1/+1); returns a new array. */
export function moveItem(list, i, delta) {
  const j = i + delta;
  if (j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** One line per ticket edit in a config save preview. */
export function describeTicketChange(c) {
  const to = c.to === undefined ? "(default board)" : c.to;
  return `${c.path}: ${c.field} ${c.from ?? "(none)"} → ${to}`;
}

/** Rule checks for one board; returns a message or "". */
export function checkRules(board, rules, cols) {
  const have = colValues(cols);
  const seen = new Set();
  for (const r of rules) {
    const name = r.name.trim();
    const who = name ? `Automation "${name}"` : "An automation";
    const where = ` on board "${board}"`;
    if (!name) return `An automation${where} has no name.`;
    if (seen.has(name)) return `Duplicate automation name "${name}"${where}.`;
    seen.add(name);
    if (!r.run.trim()) return `${who}${where} has an empty script.`;
    const col = effectiveColumn(cols, r.column);
    if (!col) return `${who}${where} needs a column.`;
    if (!have.includes(col)) return `Cannot remove column "${col}": used by automation "${name}"${where}. Change or remove the rule first.`;
  }
  return "";
}

/** Template variables offered in the script hint. */
export const AUTOMATION_VARS = ["id", "name", "body", "board", "status", "from", "to", "path", "labels", "event", "props.<key>"];

/** One line for a log record: `board/rule`. */
export const logTitle = (r) => `${r.board}/${r.rule}`;

/** Test-run request body from a form rule. */
export function testBody(rule, board) {
  const b = { run: rule.run, event: rule.event };
  if (board) b.board = board;
  return b;
}

/** Test-run result → text for the <pre>. */
export function describeTestRun(r) {
  const res = r.result;
  const lines = [`$ ${r.command}`, `exit: ${res.exitCode ?? "(none)"}`];
  if (res.error) lines.push(`error: ${res.error}`);
  if (res.stdout) lines.push("--- stdout ---", res.stdout.replace(/\n$/, ""));
  if (res.stderr) lines.push("--- stderr ---", res.stderr.replace(/\n$/, ""));
  return lines.join("\n");
}

/** Ticket detail `automations` object → "name: status at" lines. */
export function describeAutomations(a) {
  return Object.entries(a ?? {}).map(([name, e]) => {
    const x = e && typeof e === "object" ? e : { status: String(e) };
    return `${name}: ${x.status ?? "?"}${x.at ? ` at ${x.at}` : ""}`;
  });
}

/** One automation entry → "running" | "done" | "failed" | "unknown". */
export function automationState(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return "unknown";
  if (e.error) return "failed";
  const s = typeof e.status === "string" ? e.status.trim().toLowerCase() : "";
  if (s === "failed") return "failed";
  if (s === "running") return "running";
  if (s === "done") {
    const x = e.exit;
    return x !== undefined && x !== null && x !== "" && Number.isFinite(Number(x)) && Number(x) !== 0 ? "failed" : "done";
  }
  return "unknown";
}

/** Local ISO string without timezone ("2026-10-30T15:16:55") → Date (local time); null if invalid. */
export function parseLocal(iso) {
  if (iso instanceof Date) return Number.isNaN(+iso) ? null : iso;
  if (typeof iso !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(iso.trim());
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
    return Number.isNaN(+d) ? null : d;
  }
  const d = new Date(iso); // has an explicit zone (Z / +02:00)
  return Number.isNaN(+d) ? null : d;
}

const pad = (n) => String(n).padStart(2, "0");
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Absolute local time "YYYY-MM-DD HH:MM:SS" (or "" if unparsable). */
export function absoluteTime(iso) {
  const d = parseLocal(iso);
  return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : "";
}

/** "just now" | "N min ago" | "N h ago" | "yesterday" | "YYYY-MM-DD"; "" when unparsable. */
export function relativeTime(iso, now = new Date()) {
  const d = parseLocal(iso);
  if (!d) return "";
  const diff = +now - +d;
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (diff < -60000) return date; // clearly in the future
  if (diff < 60000) return "just now";
  const sameDay = dayStart(now).getTime() === dayStart(d).getTime();
  if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
  if (diff < 86400000 && sameDay) return `${Math.floor(diff / 3600000)} h ago`;
  const days = Math.round((dayStart(now) - dayStart(d)) / 86400000);
  return days === 1 ? "yesterday" : date;
}

const DETAIL_ORDER = { running: 0, failed: 1, done: 2, unknown: 3 };
const WORST_ORDER = { failed: 0, running: 1, done: 2, unknown: 3 };

/**
 * Map {name: entry} (or array of {name, ...entry}) → {total, counts, worst, list, worstFirst}.
 * list: running, failed, done, unknown; newest first within a group. worstFirst: failed, running, done, unknown.
 */
export function summarizeAutomations(src) {
  const pairs = Array.isArray(src) ? src.map((e) => [e?.name, e]) : Object.entries(src && typeof src === "object" ? src : {});
  const items = pairs.map(([name, e]) => {
    const x = e && typeof e === "object" ? e : {};
    return { name: String(name), state: automationState(e), status: typeof x.status === "string" ? x.status : "", at: x.at ?? null, exit: x.exit ?? null, error: x.error ? String(x.error) : "" };
  });
  const time = (i) => +(parseLocal(i.at) ?? -Infinity);
  const sortBy = (order) => [...items].sort((a, b) => order[a.state] - order[b.state] || time(b) - time(a) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const counts = { failed: 0, running: 0, done: 0, unknown: 0 };
  for (const i of items) counts[i.state]++;
  const worstFirst = sortBy(WORST_ORDER);
  return { total: items.length, counts, worst: worstFirst[0]?.state ?? null, list: sortBy(DETAIL_ORDER), worstFirst };
}

/** "2 automations: 1 failed, 1 done" ("" when none). */
export function automationsText(sum) {
  if (!sum.total) return "";
  const parts = ["failed", "running", "done", "unknown"].filter((k) => sum.counts[k]).map((k) => `${sum.counts[k]} ${k}`);
  return `${sum.total} automation${sum.total === 1 ? "" : "s"}: ${parts.join(", ")}`;
}

/** "log-review: done 2 min ago (exit 0)" for a summarized item. */
export function automationLabel(i, now = new Date()) {
  const rel = relativeTime(i.at, now);
  const exit = i.exit !== null && i.exit !== undefined && i.exit !== "" ? ` (exit ${i.exit})` : "";
  return `${i.name}: ${i.state === "unknown" ? `unknown status${i.status ? ` "${i.status}"` : ""}` : i.state}${rel ? ` ${rel}` : ""}${exit}${i.error ? ` – ${i.error}` : ""}`;
}
