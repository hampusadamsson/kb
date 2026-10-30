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

const colRows = (cols) => cols.map((c) => ({ orig: c, value: c }));

/** GET /api/config → editable form state. `orig` = name in the file (null for new rows). */
export function configToForm(c) {
  return {
    name: c.name,
    glob: c.glob,
    columns: colRows(c.columns),
    boards: Object.entries(c.boards ?? {}).map(([n, b]) => ({ orig: n, name: n, columns: colRows(b.columns) })),
  };
}

/** Rows that were renamed: { oldName: newName } (blank new names are not renames, they are removals). */
function renamedColumns(rows) {
  const out = {};
  for (const r of rows) {
    const v = r.value.trim();
    if (r.orig !== null && v !== "" && v !== r.orig) out[r.orig] = v;
  }
  return out;
}

const colValues = (rows) => rows.map((r) => r.value.trim()).filter((v) => v !== "");

/** Form state → PUT /api/config payload parts: { config, renames }. */
export function formToPayload(f) {
  const config = { name: f.name.trim(), glob: f.glob.trim(), columns: colValues(f.columns), boards: {} };
  const renames = { columns: {}, boards: {} };
  const top = renamedColumns(f.columns);
  if (Object.keys(top).length) renames.columns[""] = top;
  for (const b of f.boards) {
    const name = b.name.trim();
    config.boards[name] = { columns: colValues(b.columns) };
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
