// Accessible tab strip for the Settings dialog (roving tabindex, arrow-key navigation).
import { h, clear } from "./dom.js";
import { nextTab } from "./logic.js";

export const tabId = (id) => `settings-tab-${id}`;
export const panelId = (id) => `settings-panel-${id}`;

/**
 * items: [{id, label, dirty?}] ; getActive(): id ; select(id): activate.
 * Returns {el, update(items)} — update() redraws labels/aria state only (focus is kept).
 */
export function tabList(initial, getActive, select) {
  let items = initial;
  const el = h("div", { class: "set-tabs", role: "tablist", "aria-label": "Settings sections" });
  const draw = () => {
    const focused = document.activeElement?.closest?.(".set-tabs") ? document.activeElement.id : null;
    clear(el);
    for (const it of items) {
      const on = it.id === getActive();
      el.append(
        h(
          "button",
          {
            type: "button",
            class: "tab",
            role: "tab",
            id: tabId(it.id),
            "aria-selected": String(on),
            "aria-controls": panelId(it.id),
            tabIndex: on ? 0 : -1,
            onclick: () => select(it.id),
          },
          it.running ? h("span", { class: "sdot running tab-run", "aria-hidden": "true" }) : null,
          h("span", { text: it.label }),
          it.dirty ? h("span", { class: "dirty", title: "Unsaved changes", "aria-label": "unsaved changes", text: "•" }) : null,
        ),
      );
    }
    if (focused) document.getElementById(focused)?.focus();
  };
  el.addEventListener("keydown", (e) => {
    const to = nextTab(items.map((i) => i.id), getActive(), e.key);
    if (to === null) return;
    e.preventDefault();
    select(to);
    document.getElementById(tabId(to))?.focus();
  });
  draw();
  return {
    el,
    update(next) {
      items = next;
      draw();
    },
  };
}

/** Tabpanel element for tab `id`. */
export const tabPanel = (id) => h("div", { class: "set-panel", role: "tabpanel", id: panelId(id), "aria-labelledby": tabId(id), tabIndex: 0 });
