// Board rendering: sections, columns, cards, drag and drop.
import { h, clear } from "./dom.js";
import { display } from "./logic.js";

/**
 * handlers: { open(view), add(board, status), move(view, status), dragState(bool) }
 * boards: [{name, columns:[{name,tickets}], unsorted:[]}]
 */
export function renderBoards(container, boards, handlers, { showTitles }) {
  const keep = captureScroll(container);
  clear(container);
  for (const b of boards) container.append(renderBoard(b, handlers, showTitles));
  restoreScroll(container, keep);
}

function renderBoard(board, handlers, showTitle) {
  const cols = board.columns.map((c) => renderColumn(board, c, handlers, false));
  if (board.unsorted.length) {
    cols.push(renderColumn(board, { name: "unsorted", tickets: board.unsorted }, handlers, true));
  }
  return h(
    "section",
    { class: "board", "aria-label": `Board ${board.name}` },
    showTitle ? h("h2", { class: "board-title", text: board.name }) : null,
    h("div", { class: "columns" }, cols),
  );
}

function renderColumn(board, col, handlers, unsorted) {
  const key = `${board.name}\u0000${col.name}`;
  const body = h("div", { class: "cards", "data-scroll": key });
  for (const t of col.tickets) body.append(renderCard(t, handlers));
  if (!col.tickets.length) body.append(h("p", { class: "empty-col", text: "—" }));
  const el = h(
    "div",
    { class: "column" + (unsorted ? " unsorted" : ""), role: "group", "aria-label": `${col.name}, ${col.tickets.length} tickets` },
    h(
      "header",
      { class: "col-head" },
      h("h3", { text: col.name }),
      h("span", { class: "count", text: String(col.tickets.length) }),
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

function renderCard(t, handlers) {
  const idText = t.hasId ? `#${display(t.id)}` : "#?";
  const card = h(
    "article",
    {
      class: "card" + (t.readOnly ? " readonly" : ""),
      tabIndex: 0,
      role: "button",
      "data-key": t.path,
      draggable: !t.readOnly,
      "aria-label": `${idText} ${t.name}`,
    },
    h(
      "div",
      { class: "card-top" },
      h("span", { class: "id", text: idText }),
      t.duplicate ? h("span", { class: "badge warn", text: "⚠ duplicate id" }) : null,
      !t.hasId ? h("span", { class: "badge warn", text: "⚠ no id" }) : null,
    ),
    h("div", { class: "name", text: t.name }),
    t.labels.length || Object.keys(t.props).length
      ? h(
          "div",
          { class: "meta" },
          t.labels.map((l) => h("span", { class: "chip label", text: `[${l}]` })),
          Object.entries(t.props).map(([k, v]) => h("span", { class: "chip prop", text: `${k}:${display(v)}` })),
        )
      : null,
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
