// Pure helpers for Settings → Logs (no DOM).

/** Event-type filter options: value → `type` query param ("" = none). */
export const TYPE_FILTERS = [
  { value: "all", label: "All events", type: "" },
  { value: "tickets", label: "Ticket changes", type: "ticket.*" },
  { value: "moves", label: "Moves", type: "ticket.moved" },
  { value: "labels", label: "Labels", type: "ticket.labels" },
  { value: "props", label: "Properties", type: "ticket.props" },
  { value: "comments", label: "Comments", type: "ticket.comment" },
  { value: "config", label: "Config", type: "config.*" },
  { value: "automations", label: "Automations", type: "automation.*" },
  { value: "ids", label: "Fix ids", type: "ids.fixed" },
];

export const SOURCE_FILTERS = ["cli", "web", "automation"];

export const PAGE_SIZE = 50;

/** Filter value → `type` param ("" for All/unknown). */
export const typeParam = (value) => TYPE_FILTERS.find((f) => f.value === value)?.type ?? "";

/** Query string (no leading "?") for GET /api/events; empty values are omitted. */
export function buildQuery(f = {}) {
  const p = new URLSearchParams();
  const q = (f.q ?? "").trim();
  if (q) p.set("q", q);
  const t = typeParam(f.type ?? "all");
  if (t) p.set("type", t);
  if (f.source && f.source !== "all") p.set("source", f.source);
  if (f.board && f.board !== "all") p.set("board", f.board);
  if (f.before) p.set("before", f.before);
  p.set("limit", String(f.limit ?? PAGE_SIZE));
  return p.toString();
}

/** True when no search/type/source/board filter is active. */
export const isUnfiltered = (f = {}) =>
  !(f.q ?? "").trim() && (f.type ?? "all") === "all" && (!f.source || f.source === "all") && (!f.board || f.board === "all");

/** Merge a freshly fetched first page into the loaded list, de-duplicated by id, newest first (ids sort by time). */
export function mergeById(current, fresh) {
  const have = new Set(current.map((e) => e.id));
  const added = fresh.filter((e) => !have.has(e.id));
  return [...added, ...current].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** Append an older page, skipping ids already present. */
export function appendPage(current, page) {
  const have = new Set(current.map((e) => e.id));
  return [...current, ...page.filter((e) => !have.has(e.id))];
}

/** CSS class suffix for the event pill. */
export function pillClass(e) {
  const t = e?.type ?? "";
  if (t === "automation.finished") return e.data?.status === "done" || e.data?.status === "ok" ? "auto-ok" : "auto-fail";
  if (t === "automation.skipped") return "auto-skip";
  if (t === "automation.started") return "auto-start";
  if (t.startsWith("ticket.")) return "ticket";
  if (t.startsWith("config.")) return "config";
  if (t.startsWith("ids.")) return "ids";
  return "other";
}

const pad = (n) => String(n).padStart(2, "0");
const parse = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(+d) ? null : d;
};
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** "just now" | "N min ago" | "N h ago" | "yesterday" | "YYYY-MM-DD"; "" when unparsable. */
export function relativeTime(iso, now = new Date()) {
  const d = parse(iso);
  if (!d) return "";
  const diff = +now - +d;
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (diff < -60000) return date;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
  if (diff < 86400000 && +dayStart(now) === +dayStart(d)) return `${Math.floor(diff / 3600000)} h ago`;
  const days = Math.round((+dayStart(now) - +dayStart(d)) / 86400000);
  return days === 1 ? "yesterday" : date;
}

/** Local "YYYY-MM-DD HH:MM:SS" for tooltips. */
export function absoluteTime(iso) {
  const d = parse(iso);
  return d
    ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    : "";
}

/** Entries of event.data for display: [{key, value, pre}] — scalars as text, objects/arrays as pretty JSON (pre: true). */
export function dataEntries(data) {
  if (!data || typeof data !== "object") return [];
  return Object.entries(data).map(([key, v]) => {
    if (v !== null && typeof v === "object") return { key, value: JSON.stringify(v, null, 2), pre: true };
    if (typeof v === "string" && v.includes("\n")) return { key, value: v, pre: true };
    return { key, value: v === null ? "null" : String(v), pre: false };
  });
}

export const countText = (n) => `Showing ${n} event${n === 1 ? "" : "s"}`;

/** "No events match …" description of the active filters. */
export function noMatchText(f = {}) {
  const parts = [];
  const q = (f.q ?? "").trim();
  if (q) parts.push(`"${q}"`);
  const t = TYPE_FILTERS.find((x) => x.value === f.type);
  if (t && t.value !== "all") parts.push(t.label.toLowerCase());
  if (f.source && f.source !== "all") parts.push(`source ${f.source}`);
  if (f.board && f.board !== "all") parts.push(`board ${f.board}`);
  return `No events match ${parts.join(", ") || "the filters"}.`;
}
