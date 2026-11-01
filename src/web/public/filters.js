// Filter bar: free text, label checkboxes (+ searchable dropdown), property chips, clear button.
import { chipInput, debounce, h } from "./dom.js";
import { hasFilters } from "./logic.js";
import {
  TOP_LABELS,
  addNegation,
  filterLabelOptions,
  hiddenSelected,
  isNegated,
  labelName,
  removeLabel,
  toggleLabel,
  topLabels,
} from "./filters-logic.js";

let seq = 0;

/**
 * Label filter: top-N inline checkboxes plus a searchable dropdown listing all labels.
 * onChange(labels) fires after a user edit (never on set/setOptions).
 * Returns { el, get(), set(labels), setOptions([{name,count}]) }.
 */
export function labelFilter({ onChange }) {
  let options = []; // [{ name, count }]
  let selected = []; // exact values: "bug", "!bug"
  let open = false;
  let topKey = "";
  let listKey = "";
  let optionsKey = "";
  const checked = (name) => selected.includes(name);

  const topBox = h("div", { class: "lf-top" });
  const trigger = h("button", { type: "button", class: "btn small lf-trigger", "aria-expanded": "false" });
  const negChips = h("span", { class: "lf-neg" });
  const search = h("input", {
    type: "search",
    class: "lf-search",
    placeholder: "Search labels…",
    "aria-label": "Search labels",
    autocomplete: "off",
  });
  const list = h("div", { class: "lf-list", role: "group", "aria-label": "All labels" });
  const panel = h("div", { class: "lf-panel", hidden: true }, search, list);
  panel.id = `lf-panel-${++seq}`;
  trigger.setAttribute("aria-controls", panel.id);
  const el = h("div", { class: "lf" }, topBox, h("div", { class: "lf-bar" }, trigger, negChips, panel));

  const optionRow = (o) => {
    const input = h("input", { type: "checkbox", checked: checked(o.name), onchange: () => toggle(o.name) });
    input.dataset.label = o.name;
    return h(
      "label",
      { class: "lf-opt", title: o.name },
      input,
      h("span", { class: "lf-opt-name", text: o.name }),
      h("span", { class: "lf-opt-count", text: String(o.count) }),
    );
  };
  const optionKey = (opts) => opts.map((o) => `${o.name}\u0000${o.count}`).join("\u0001");
  /** Rebuild the checkboxes only when the option list changes, so focus and open state survive toggling. */
  const renderOptions = (box, opts, getKey, setKey, emptyText) => {
    const key = optionKey(opts);
    if (getKey() === key) {
      for (const i of box.querySelectorAll('input[type="checkbox"]')) i.checked = checked(i.dataset.label);
      return;
    }
    setKey(key);
    box.replaceChildren(...(opts.length ? opts.map(optionRow) : [h("p", { class: "lf-none", text: emptyText })]));
  };

  /** All options for the panel: filtered by the search, plus selected labels that vanished from the board. */
  function panelOptions() {
    const typed = search.value.trim();
    const q = (isNegated(typed) ? labelName(typed) : typed).toLowerCase();
    const opts = filterLabelOptions(options, q);
    const known = new Set(opts.map((o) => o.name));
    const extra = [];
    for (const v of selected) {
      if (isNegated(v)) continue;
      const name = labelName(v);
      if (!known.has(name) && !extra.some((o) => o.name === name)) extra.push({ name, count: 0 });
    }
    return [...extra, ...opts].filter((o) => !q || o.name.toLowerCase().includes(q));
  }

  function render() {
    const top = topLabels(options, TOP_LABELS);
    renderOptions(
      topBox,
      top,
      () => topKey,
      (k) => (topKey = k),
      "No labels",
    );

    const extra = hiddenSelected(selected, top);
    const badge = extra ? h("span", { class: "badge-count", text: String(extra), title: `${extra} more selected` }) : undefined;
    trigger.replaceChildren(h("span", { text: "All labels…" }), ...(badge ? [badge] : []));
    trigger.setAttribute("aria-expanded", String(open));

    const negated = selected.filter(isNegated);
    negChips.replaceChildren(
      ...negated.map((v) =>
        h(
          "span",
          { class: "chip label lf-negchip" },
          h("span", { text: v }),
          h("button", {
            type: "button",
            class: "chip-x",
            "aria-label": `Remove ${v}`,
            text: "×",
            onclick: () => {
              selected = removeLabel(selected, v);
              render();
              onChange([...selected]);
            },
          }),
        ),
      ),
    );

    const opts = panelOptions();
    renderOptions(
      list,
      opts,
      () => listKey,
      (k) => (listKey = k),
      "No labels match",
    );
  }

  function toggle(name) {
    selected = checked(name) ? removeLabel(selected, name) : toggleLabel(selected, name);
    render();
    onChange([...selected]);
  }

  const onDocDown = (e) => {
    if (!el.contains(e.target)) setOpen(false);
  };
  const onDocKey = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    setOpen(false);
    trigger.focus();
  };
  function setOpen(on) {
    if (open === on) return;
    open = on;
    panel.hidden = !on;
    if (on) {
      document.addEventListener("mousedown", onDocDown, true);
      document.addEventListener("keydown", onDocKey, true);
    } else {
      document.removeEventListener("mousedown", onDocDown, true);
      document.removeEventListener("keydown", onDocKey, true);
      search.value = "";
    }
    render();
    if (on) search.focus();
  }

  trigger.addEventListener("click", () => setOpen(!open));
  search.addEventListener("input", render);
  // "!bug" + Enter adds a negated label (kept verbatim as "!bug" in the label list, as before).
  search.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const typed = search.value.trim();
    const name = labelName(typed);
    if (!isNegated(typed) || !name) return;
    selected = addNegation(selected, name);
    search.value = "";
    render();
    onChange([...selected]);
    search.focus();
  });

  render();
  return {
    el,
    get: () => [...selected],
    /** Accepts a label array (or { labels }). Never fires onChange. */
    set(v) {
      selected = [...(Array.isArray(v) ? v : (v?.labels ?? []))];
      render();
    },
    /** Board label options ([{name, count}]). Never fires onChange. */
    setOptions(opts) {
      const next = [...(opts ?? [])];
      const key = next.map((o) => `${o.name}\u0000${o.count}`).join("\u0001");
      if (key === optionsKey) return;
      optionsKey = key;
      options = next;
      render();
    },
  };
}

/**
 * `root` is the #filters element. onChange({text, labels, props}) fires 250 ms after the last edit.
 * Property filter is still a chip input; labels use checkbox + searchable dropdown.
 */
export function createFilters(root, onChange) {
  const text = root.querySelector("#f-text");
  const clearBtn = root.querySelector("#f-clear");
  const emit = debounce(() => onChange({ text: text.value.trim(), labels: labels.get(), props: props.get() }), 250);
  const labels = labelFilter({ onChange: emit });
  const props = chipInput({ label: "Property filter", placeholder: "key:value, !key ⏎", onChange: emit });
  root.querySelector("#f-labels").append(labels.el);
  root.querySelector("#f-props").append(props.el);
  text.addEventListener("input", emit);
  clearBtn.addEventListener("click", () => {
    emit.cancel();
    text.value = "";
    labels.set([]);
    props.set([]);
    onChange({ text: "", labels: [], props: [] });
  });
  return {
    /** Reflect URL state without firing onChange. */
    set(f) {
      emit.cancel();
      if (text.value.trim() !== f.text) text.value = f.text;
      labels.set(f.labels);
      props.set(f.props);
      clearBtn.hidden = !hasFilters(f);
    },
    /** Available label options ([{name, count}]) for the checkboxes and dropdown. */
    setLabels(opts) {
      labels.setOptions(opts ?? []);
    },
  };
}
