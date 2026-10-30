// Settings → Logs: audit event table (search, filters, pagination, live prepend).
import { api } from "./api.js";
import { h, clear, debounce, toast } from "./dom.js";
import { SOURCE_FILTERS, TYPE_FILTERS, absoluteTime, appendPage, buildQuery, countText, dataEntries, isUnfiltered, mergeById, noMatchText, pillClass, relativeTime } from "./logs-logic.js";

let ctx = { boardNames: () => [], openTicket: async () => {} };
let st = null; // per-mount state

export function configure(c) {
  ctx = { ...ctx, ...c };
}

/** True when the Logs panel is mounted and visible. */
export const isMounted = () => Boolean(st && document.body.contains(st.root));

export function mount(panel) {
  const filters = { q: "", type: "all", source: "all", board: "all" };
  st = { root: panel, filters, events: [], cursor: undefined, loading: false, error: "", loaded: false, expanded: new Set(), stale: false, seq: 0, missing: new Set() };
  const s = st;

  const sel = (label, key, opts) =>
    h(
      "select",
      { "aria-label": label, onchange: (e) => ((filters[key] = e.target.value), reload()) },
      opts.map(([v, t]) => h("option", { value: v, text: t, selected: filters[key] === v })),
    );
  const search = h("input", { type: "search", class: "logs-search", placeholder: "Search events…", "aria-label": "Search events" });
  const run = debounce(() => {
    filters.q = search.value;
    reload();
  }, 250);
  search.addEventListener("input", run);
  s.search = search;
  const boards = [["all", "All boards"], ...(ctx.boardNames() ?? []).map((b) => [b, b])];
  const bar = h(
    "div",
    { class: "logs-bar" },
    search,
    sel("Event type", "type", TYPE_FILTERS.map((f) => [f.value, f.label])),
    sel("Source", "source", [["all", "All sources"], ...SOURCE_FILTERS.map((x) => [x, x])]),
    boards.length > 2 ? sel("Board", "board", boards) : null,
  );
  s.pill = h("button", { type: "button", class: "logs-new", hidden: true, text: "New events — refresh", onclick: () => reload() });
  s.body = h("div", { class: "logs-body" });
  panel.append(bar, s.pill, s.body);
  reload();
}

async function fetchPage(extra = {}) {
  return api.events(buildQuery({ ...st.filters, ...extra }));
}

async function reload() {
  const s = st;
  if (!s) return;
  const seq = ++s.seq;
  s.loading = true;
  s.error = "";
  s.stale = false;
  s.pill.hidden = true;
  s.events = [];
  s.cursor = undefined;
  s.loaded = false;
  draw();
  try {
    const r = await fetchPage();
    if (seq !== s.seq) return;
    s.events = r.events;
    s.cursor = r.nextCursor;
    s.loaded = true;
  } catch (e) {
    if (seq !== s.seq) return;
    s.error = e.message;
  }
  s.loading = false;
  draw();
}

async function more() {
  const s = st;
  if (!s || s.loading || !s.cursor) return;
  const seq = ++s.seq;
  s.loading = true;
  draw();
  try {
    const r = await fetchPage({ before: s.cursor });
    if (seq !== s.seq) return;
    s.events = appendPage(s.events, r.events);
    s.cursor = r.nextCursor;
  } catch (e) {
    if (seq !== s.seq) return;
    toast(e.message, "error");
  }
  s.loading = false;
  draw();
}

/** Called on SSE changes while the Logs tab is open. */
export async function live() {
  const s = st;
  if (!s || !isMounted() || s.loading || !s.loaded) return;
  const atTop = s.events.length <= 50 && isUnfiltered(s.filters) && !s.filters.q.trim();
  try {
    const r = await fetchPage();
    if (st !== s) return;
    const fresh = r.events.filter((e) => !s.events.some((x) => x.id === e.id) && (!s.events[0] || e.id > s.events[0].id));
    if (!fresh.length) return;
    if (atTop) {
      s.events = mergeById(s.events, r.events);
      draw();
    } else s.pill.hidden = false;
  } catch {
    /* ignore live errors */
  }
}

const cell = (cls, ...c) => h("td", { class: cls }, ...c);

function ticketCell(e, s) {
  if (!e.ticketId) return cell("logs-ticket");
  const label = `#${e.ticketId}${e.ticketName ? " " + e.ticketName : ""}`;
  if (s.missing.has(e.ticketId)) return cell("logs-ticket", h("span", { class: "muted", title: "Ticket no longer exists", text: label }));
  return cell(
    "logs-ticket",
    h("button", {
      type: "button",
      class: "link-btn",
      text: label,
      title: "Open ticket",
      onclick: async (ev) => {
        ev.stopPropagation();
        try {
          await ctx.openTicket(e.ticketId);
        } catch {
          s.missing.add(e.ticketId);
          draw();
        }
      },
    }),
  );
}

function detailRow(e, id) {
  const dl = h("dl", { class: "logs-data" });
  dl.append(h("dt", { text: "id" }), h("dd", { class: "mono", text: e.id }), h("dt", { text: "timestamp" }), h("dd", { class: "mono", text: e.ts }));
  if (e.path) dl.append(h("dt", { text: "path" }), h("dd", { class: "mono", text: e.path }));
  for (const d of dataEntries(e.data)) dl.append(h("dt", { text: d.key }), h("dd", {}, d.pre ? h("pre", { class: "mono auto-out", text: d.value }) : h("span", { class: "mono", text: d.value })));
  return h("tr", { class: "logs-detail", id }, h("td", { colSpan: 6 }, dl));
}

function row(e, s, tbody) {
  const open = s.expanded.has(e.id);
  const did = `logs-d-${e.id}`;
  const toggle = () => {
    if (s.expanded.has(e.id)) s.expanded.delete(e.id);
    else s.expanded.add(e.id);
    draw();
    const el = [...s.root.querySelectorAll("tr.logs-row")].find((r) => r.dataset.id === e.id);
    el?.focus();
  };
  const tr = h(
    "tr",
    {
      class: "logs-row",
      tabIndex: 0,
      "aria-expanded": String(open),
      "aria-controls": open ? did : undefined,
      "data-id": e.id,
      onclick: toggle,
      onkeydown: (ev) => {
        if (ev.target === ev.currentTarget && (ev.key === "Enter" || ev.key === " ")) {
          ev.preventDefault();
          toggle();
        }
      },
    },
    cell("logs-time", h("span", { title: absoluteTime(e.ts), text: relativeTime(e.ts) || e.ts })),
    cell("logs-event", h("span", { class: `pill ev-${pillClass(e)}`, text: e.type })),
    ticketCell(e, s),
    cell("logs-board", e.board ?? ""),
    cell("logs-source", e.source ?? ""),
    cell("logs-summary", e.summary ?? ""),
  );
  tbody.append(tr);
  if (open) tbody.append(detailRow(e, did));
}

function draw() {
  const s = st;
  if (!s) return;
  const keep = s.root.scrollTop;
  clear(s.body);
  if (s.error) {
    s.body.append(h("p", { class: "form-error", role: "alert", text: s.error }), h("button", { type: "button", class: "btn", text: "Retry", onclick: () => reload() }));
    return;
  }
  if (!s.loaded) {
    s.body.append(h("p", { class: "muted", role: "status", text: "Loading…" }));
    return;
  }
  if (!s.events.length) {
    const none = isUnfiltered(s.filters);
    s.body.append(h("p", { class: "muted", text: none ? "No events yet. Moving cards, editing tickets and automation runs show up here." : noMatchText(s.filters) }));
    return;
  }
  const tbody = h("tbody");
  for (const e of s.events) row(e, s, tbody);
  const head = h("tr", {}, ["Time", "Event", "Ticket", "Board", "Source", "Summary"].map((t) => h("th", { scope: "col", text: t })));
  s.body.append(
    h("table", { class: "logs-table" }, h("caption", { class: "sr-only", text: "Audit event log, newest first" }), h("thead", {}, head), tbody),
    h(
      "div",
      { class: "logs-foot" },
      h("span", { class: "muted", role: "status", text: countText(s.events.length) + (s.cursor ? "" : " · No more events") }),
      s.cursor ? h("button", { type: "button", class: "btn", id: "logs-more", disabled: s.loading, text: s.loading ? "Loading…" : "Load more", onclick: more }) : null,
      s.events.length > 50 ? h("button", { type: "button", class: "btn", text: "Newest", onclick: () => reload() }) : null,
    ),
  );
  s.root.scrollTop = keep;
}
