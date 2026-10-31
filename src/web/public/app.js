// App: state, routing (URL hash), rendering, live updates.
import { api } from "./api.js";
import { renderBoards } from "./board.js";
import { closeDialog, isOpen as ticketOpen, openCreate, openDetail, refreshOpen } from "./dialog.js";
import { clear, debounce, h, toast } from "./dom.js";
import { createFilters } from "./filters.js";
import { filterQuery, hasFilters, parseHash, serializeHash } from "./logic.js";
import * as settings from "./settings.js";

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

// Filters row is collapsible on narrow screens (CSS hides the toggle on wide ones).
const toggleFilters = $("filters-toggle");
const setFiltersOpen = (on) => {
  document.querySelector(".top").classList.toggle("filters-open", on);
  toggleFilters.setAttribute("aria-expanded", String(on));
};
toggleFilters.addEventListener("click", () => setFiltersOpen(toggleFilters.getAttribute("aria-expanded") !== "true"));
function renderFilterCount() {
  const f = state.filters;
  const n = (f.text ? 1 : 0) + f.labels.length + f.props.length;
  $("filters-count").textContent = String(n);
  $("filters-count").hidden = n === 0;
}

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
  settings.setBoardWarnings(data.warnings);
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
  renderFilterCount();
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
      : "No tickets yet. Use the + in a column header to create one.";
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
  const badge = $("settings-badge");
  badge.textContent = String(n);
  badge.hidden = n === 0;
  badge.classList.toggle("err", Boolean(v && v.errors.length));
  $("settings-btn").setAttribute("aria-label", n ? `Settings, ${n} issues` : "Settings");
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

$("settings-btn").addEventListener("click", () => settings.open());
$("settings-close").addEventListener("click", () => settings.requestClose());
settings.init(() => load(), {
  boardNames: () => state.data?.boardNames ?? [],
  async openTicket(id) {
    await api.get(String(id)); // throws when the ticket is gone
    openDetail(dialogCtx(), { id });
  },
});

// Click on the backdrop closes a dialog only if the click started and ended there.
$("ticket-dialog").addEventListener("mousedown", (e) => {
  $("ticket-dialog").dataset.bd = e.target === $("ticket-dialog") ? "1" : "";
});
$("ticket-dialog").addEventListener("click", (e) => {
  if (e.target === $("ticket-dialog") && $("ticket-dialog").dataset.bd === "1") closeDialog();
});

// On-screen keyboards: keep the focused field visible inside a dialog.
document.addEventListener("focusin", (e) => {
  const el = e.target;
  if (!matchMedia("(pointer: coarse)").matches || !el.closest?.("dialog") || !el.matches("input,textarea,select")) return;
  setTimeout(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), 300);
});

// ---- live updates ----

const onChanged = debounce(() => {
  load();
  if (settings.isOpen()) settings.refresh();
  if (ticketOpen()) refreshOpen();
}, 100);

function connect() {
  const es = new EventSource("/api/stream");
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
  es.addEventListener("runs", () => settings.refreshLive());
}

// Header dot while automations run
settings.onLiveChange(() => {
  const n = settings.liveCount();
  $("settings-run").hidden = n === 0;
  $("settings-btn").title = n ? `${n} automation${n === 1 ? "" : "s"} running` : "";
});

// ---- boot ----

filters.set(state.filters);
connect();
load();
settings.refreshLive();
