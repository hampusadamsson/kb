// App: state, routing (URL hash), rendering, live updates.
import { api, ApiError } from "./api.js";
import { renderBoards } from "./board.js";
import { closeDialog, isOpen as ticketOpen, openCreate, openDetail, refreshOpen } from "./dialog.js";
import { clear, debounce, h, toast } from "./dom.js";
import { createFilters } from "./filters.js";
import { filterQuery, hasFilters, parseHash, serializeHash } from "./logic.js";
import * as maint from "./maintenance.js";

const $ = (id) => document.getElementById(id);

const state = {
  filters: parseHash(location.hash),
  data: null, // last /api/board response
  dragging: false,
  pending: false, // a refresh was requested while dragging
  loadSeq: 0,
};

const filters = createFilters($("filters"), (f) => {
  state.filters = { ...state.filters, ...f };
  writeHash();
});

// ---- routing ----

function writeHash() {
  const s = serializeHash(state.filters);
  if (s === location.hash || (s === "" && location.hash === "")) return load();
  location.hash = s; // triggers hashchange → load
}

window.addEventListener("hashchange", () => {
  state.filters = parseHash(location.hash);
  filters.set(state.filters);
  load();
});

/** Selected board: "all", a name, or the first board by default. */
function selection() {
  const names = state.data?.boardNames ?? [];
  const b = state.filters.board;
  if (b === "all") return "all";
  if (b !== null && names.includes(b)) return b;
  return names[0] ?? "all";
}

// ---- loading ----

async function load() {
  const seq = ++state.loadSeq;
  if (state.dragging) {
    state.pending = true;
    return;
  }
  let data;
  let validation = null;
  try {
    [data, validation] = await Promise.all([api.board(filterQuery(state.filters)), api.validate().catch(() => null)]);
  } catch (e) {
    if (seq !== state.loadSeq) return;
    return showFatal(e);
  }
  if (seq !== state.loadSeq) return;
  if (state.dragging) {
    state.pending = true;
    return;
  }
  state.data = data;
  state.validation = validation;
  $("fatal").hidden = true;
  $("app").hidden = false;
  maint.setBoardWarnings(data.warnings);
  render();
}

function showFatal(e) {
  $("app").hidden = true;
  const box = $("fatal");
  box.hidden = false;
  clear(box);
  box.append(
    h("h2", { text: e.code === "config" ? "Configuration problem" : "Cannot load the board" }),
    h("p", { class: "mono", text: e.message }),
    h("button", { type: "button", class: "btn", text: "Retry", onclick: load }),
  );
}

// ---- render ----

function render() {
  const { data } = state;
  $("title").textContent = data.name || "kb";
  document.title = data.name ? `${data.name} — kb` : "kb";
  renderTabs();
  renderBadge();
  const sel = selection();
  const boards = sel === "all" ? data.boards : data.boards.filter((b) => b.name === sel);
  const total = boards.reduce((n, b) => n + b.unsorted.length + b.columns.reduce((m, c) => m + c.tickets.length, 0), 0);
  const empty = $("empty");
  empty.hidden = total > 0;
  if (total === 0) {
    empty.textContent = hasFilters(state.filters)
      ? "No tickets match the current filters."
      : "No tickets yet. Use “New” to create the first one.";
  }
  renderBoards($("boards"), boards, handlers, { showTitles: sel === "all" });
}

function renderTabs() {
  const tabs = $("tabs");
  const sel = selection();
  clear(tabs);
  const tab = (name, label) =>
    h("button", {
      type: "button",
      role: "tab",
      class: "tab",
      "aria-selected": String(sel === name),
      text: label,
      onclick: () => {
        state.filters = { ...state.filters, board: name };
        writeHash();
      },
    });
  for (const n of state.data.boardNames) tabs.append(tab(n, n));
  tabs.append(tab("all", "All"));
}

function renderBadge() {
  const v = state.validation;
  const n = v ? v.errors.length + v.warnings.length : 0;
  const badge = $("maint-badge");
  badge.textContent = String(n);
  badge.hidden = n === 0;
  badge.classList.toggle("err", Boolean(v && v.errors.length));
  $("maint-btn").setAttribute("aria-label", n ? `Maintenance, ${n} issues` : "Maintenance");
}

// ---- actions ----

function dialogCtx() {
  return {
    columns: state.data.columns,
    boardNames: state.data.boardNames,
    onSaved: () => load(),
  };
}

const handlers = {
  open: (view) => openDetail(dialogCtx(), view),
  add: (board, status) => openCreate(dialogCtx(), { board, status }),
  async move(view, status) {
    try {
      await api.patch(String(view.id), { status, mtime: view.mtime });
    } catch (e) {
      toast(e.code === "stale" ? "Ticket changed on disk; board refreshed" : e.message, "error");
    }
    load();
  },
  dragState(on) {
    state.dragging = on;
    if (!on && state.pending) {
      state.pending = false;
      load();
    }
  },
};

$("new-btn").addEventListener("click", () => {
  const sel = selection();
  openCreate(dialogCtx(), { board: sel === "all" ? undefined : sel });
});
$("maint-btn").addEventListener("click", () => maint.open());
$("maint-close").addEventListener("click", () => $("maint-dialog").close());
maint.init(() => load());

// Click on the backdrop closes a dialog only if the click started and ended there.
$("ticket-dialog").addEventListener("mousedown", (e) => {
  $("ticket-dialog").dataset.bd = e.target === $("ticket-dialog") ? "1" : "";
});
$("ticket-dialog").addEventListener("click", (e) => {
  if (e.target === $("ticket-dialog") && $("ticket-dialog").dataset.bd === "1") closeDialog();
});

// ---- live updates ----

const onChanged = debounce(() => {
  load();
  if (maint.isOpen()) maint.refresh();
  if (ticketOpen()) refreshOpen();
}, 100);

function connect() {
  const es = new EventSource("/api/events");
  const live = $("live");
  const set = (ok) => {
    live.classList.toggle("ok", ok);
    live.querySelector(".live-text").textContent = ok ? "live" : "reconnecting…";
    live.title = ok ? "Live updates connected" : "Live updates disconnected; reconnecting";
  };
  let wasDown = false;
  es.addEventListener("open", () => {
    set(true);
    if (wasDown) onChanged(); // refetch on reconnect
    wasDown = false;
  });
  es.addEventListener("error", () => {
    wasDown = true;
    set(false);
  });
  es.addEventListener("changed", onChanged);
}

// ---- boot ----

filters.set(state.filters);
connect();
load();
