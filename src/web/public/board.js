// Board rendering: sections, columns, cards, drag and drop.
import { h, clear } from "./dom.js";
import { cardProps, display, moveTargets, propsToggleLabel } from "./logic.js";
import { cardIndicator } from "./status.js";

/**
 * handlers: { open(view), add(board, status), move(view, status), dragState(bool) }
 * boards: [{name, columns:[{name,tickets}], unsorted:[]}]
 */
export function renderBoards(container, boards, handlers, { showTitles, web = {} }) {
  const keep = captureScroll(container);
  clear(container);
  cardView = { show: web.propertiesShow ?? null, collapsed: web.propertiesCollapsed !== false };
  for (const b of boards) container.append(renderBoard(b, handlers, showTitles));
  restoreScroll(container, keep);
}

// Card property display for the current render (from the board response's `web`).
let cardView = { show: null, collapsed: true };
// Session-only expand/collapse choices, keyed by ticket path: survives re-renders and SSE refreshes.
const propsOpen = new Map();

function propsToggle(key, count, expanded, rerender) {
  const btn = h("button", {
    type: "button",
    class: "props-toggle",
    "aria-expanded": String(expanded),
    "aria-label": propsToggleLabel(count, expanded),
    title: propsToggleLabel(count, expanded),
  });
  btn.append(h("span", { class: "chev", "aria-hidden": "true", text: "▸" }), h("span", { class: "n", text: String(count) }));
  btn.addEventListener("click", (e) => {
    e.stopPropagation(); // do not open the ticket
    propsOpen.set(key, !expanded);
    rerender();
  });
  // Enter/Space on the button must not bubble to the card's open-on-Enter handler
  btn.addEventListener("keydown", (e) => e.stopPropagation());
  return btn;
}

function renderBoard(board, handlers, showTitle) {
  const names = board.columns.map((c) => c.name);
  const cols = board.columns.map((c) => renderColumn(board, c, handlers, false, names));
  if (board.unsorted.length) {
    cols.push(renderColumn(board, { name: "unsorted", tickets: board.unsorted }, handlers, true, names));
  }
  return h(
    "section",
    { class: "board", "aria-label": `Board ${board.name}` },
    showTitle ? h("h2", { class: "board-title", text: board.name }) : null,
    h("div", { class: "columns" }, cols),
  );
}

function renderColumn(board, col, handlers, unsorted, names) {
  const key = `${board.name}\u0000${col.name}`;
  const n = col.tickets.length;
  const body = h("div", { class: "cards", "data-scroll": key });
  const targets = moveTargets(names, unsorted ? null : col.name);
  for (const t of col.tickets) body.append(renderCard(t, handlers, targets));
  if (!col.tickets.length) body.append(h("p", { class: "empty-col", text: "—" }));
  const el = h(
    "div",
    { class: "column" + (unsorted ? " unsorted" : ""), role: "group", "aria-label": `${col.name}, ${n} ${n === 1 ? "ticket" : "tickets"}` },
    h(
      "header",
      { class: "col-head" },
      h("h3", { text: col.name }),
      h("span", { class: "count", text: String(n) }),
      unsorted
        ? null
        : h("button", {
            type: "button",
            class: "icon-btn",
            title: `New ticket in ${col.name}`,
            "aria-label": `New ticket in ${col.name}`,
            text: "+",
            onclick: () => handlers.add(board.name, col.name),
          }),
    ),
    body,
  );
  if (!unsorted) wireDrop(el, board.name, col.name, handlers);
  return el;
}

// The ticket currently being dragged (module scope: dataTransfer can't be read in dragover).
let dragging = null;

function wireDrop(el, boardName, colName, handlers) {
  const ok = () => dragging && dragging.board === boardName && dragging.column !== colName;
  el.addEventListener("dragover", (e) => {
    if (!ok()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    el.classList.add("drop");
  });
  el.addEventListener("dragleave", (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove("drop");
  });
  el.addEventListener("drop", (e) => {
    el.classList.remove("drop");
    if (!ok()) return;
    e.preventDefault();
    const t = dragging;
    dragging = null;
    handlers.move(t, colName);
  });
}

function renderCard(t, handlers, targets) {
  const idText = t.hasId ? `#${display(t.id)}` : "#?";
  const ind = cardIndicator(t.autos);
  const shown = cardProps(t.props, cardView.show);
  const expanded = shown.length > 0 && (propsOpen.get(t.path) ?? !cardView.collapsed);
  const hasMeta = t.labels.length || shown.length || t.duplicate || !t.hasId;
  const card = h(
    "article",
    {
      class: "card" + (t.readOnly ? " readonly" : ""),
      tabIndex: 0,
      role: "button",
      "data-key": t.path,
      draggable: !t.readOnly,
      "aria-label": ind ? `${idText} ${t.name}, ${ind.text}` : `${idText} ${t.name}`,
      title: ind ? ind.text : null,
    },
    // Title first: it is what people scan. The id is secondary metadata below.
    h("span", { class: "name", text: t.name }),
    hasMeta
      ? h(
          "div",
          { class: "meta" },
          h("span", { class: "id", text: idText }),
          t.duplicate ? h("span", { class: "badge warn", text: "dup id" }) : null,
          !t.hasId ? h("span", { class: "badge warn", text: "no id" }) : null,
          t.labels.map((l) => h("span", { class: "chip label", text: l })),
          shown.length
            ? propsToggle(t.path, shown.length, expanded, () => {
                const next = renderCard(t, handlers, targets);
                card.replaceWith(next);
                next.querySelector(".props-toggle")?.focus(); // keep keyboard focus on the toggle
              })
            : null,
          expanded ? shown.map(([k, v]) => h("span", { class: "chip prop", text: `${k}:${display(v)}` })) : null,
        )
      : h("div", { class: "meta" }, h("span", { class: "id", text: idText })),
    ind ? ind.el : null,
    t.readOnly || !targets.length ? null : moveSelect(t, targets, handlers),
  );
  card.addEventListener("click", () => handlers.open(t));
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target === card) {
      e.preventDefault();
      handlers.open(t);
    }
  });
  if (!t.readOnly) {
    card.addEventListener("dragstart", (e) => {
      dragging = t;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(t.id));
      card.classList.add("dragging");
      handlers.dragState(true);
    });
    card.addEventListener("dragend", () => {
      dragging = null;
      card.classList.remove("dragging");
      document.querySelectorAll(".drop").forEach((x) => x.classList.remove("drop"));
      handlers.dragState(false);
    });
  }
  return card;
}

/** Touch/keyboard alternative to drag and drop: a native select that calls the same move handler. */
function moveSelect(t, targets, handlers) {
  const sel = h(
    "select",
    { class: "card-move", "aria-label": `Move #${display(t.id)} to column` },
    h("option", { value: "", text: "Move to…" }),
    targets.map((c) => h("option", { value: c, text: c })),
  );
  for (const ev of ["click", "keydown", "mousedown", "dragstart"]) sel.addEventListener(ev, (e) => e.stopPropagation());
  sel.draggable = false;
  sel.addEventListener("change", () => {
    const to = sel.value;
    sel.value = "";
    if (to) handlers.move(t, to);
  });
  return sel;
}

function captureScroll(container) {
  const cols = {};
  container.querySelectorAll("[data-scroll]").forEach((el) => {
    if (el.scrollTop) cols[el.dataset.scroll] = el.scrollTop;
  });
  const sections = [...container.querySelectorAll(".columns")].map((el) => el.scrollLeft);
  const active = document.activeElement?.dataset?.key;
  return {
    cols,
    sections,
    top: container.scrollTop,
    left: container.scrollLeft,
    page: [window.scrollX, window.scrollY],
    active: container.contains(document.activeElement) ? active : undefined,
  };
}

function restoreScroll(container, s) {
  container.scrollTop = s.top;
  container.scrollLeft = s.left;
  container.querySelectorAll(".columns").forEach((el, i) => (el.scrollLeft = s.sections[i] ?? 0));
  container.querySelectorAll("[data-scroll]").forEach((el) => {
    if (s.cols[el.dataset.scroll]) el.scrollTop = s.cols[el.dataset.scroll];
  });
  if (s.active) {
    for (const c of container.querySelectorAll(".card")) {
      if (c.dataset.key === s.active) {
        c.focus({ preventScroll: true });
        break;
      }
    }
  }
  window.scrollTo(s.page[0], s.page[1]);
}
