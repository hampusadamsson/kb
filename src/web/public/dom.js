// Tiny DOM helpers. Text is always set via textContent / text nodes, never innerHTML.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k in el && k !== "list" && k !== "form") el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const clear = (el) => el.replaceChildren();

export function clone(templateId) {
  return document.getElementById(templateId).content.firstElementChild.cloneNode(true);
}

let toastTimer;
export function toast(message, kind = "info") {
  const box = document.getElementById("toasts");
  const t = h("div", { class: `toast ${kind}`, text: message });
  box.append(t);
  setTimeout(() => t.remove(), kind === "error" ? 7000 : 3500);
  clearTimeout(toastTimer);
}

export function debounce(fn, ms) {
  let t;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

/** Chip list editor: chips with × plus an input (Enter adds). */
export function chipInput({ label, placeholder, values = [], onChange, readOnly = false }) {
  let items = [...values];
  const list = h("span", { class: "chips" });
  const input = h("input", { type: "text", placeholder, "aria-label": label, disabled: readOnly });
  const render = () => {
    clear(list);
    for (const v of items) {
      list.append(
        h(
          "span",
          { class: "chip label" },
          h("span", { text: v }),
          readOnly
            ? null
            : h("button", {
                type: "button",
                class: "chip-x",
                "aria-label": `Remove ${v}`,
                text: "×",
                onclick: () => {
                  items = items.filter((x) => x !== v);
                  render();
                  onChange?.(items);
                },
              }),
        ),
      );
    }
  };
  const add = () => {
    const v = input.value.trim();
    if (v && !items.includes(v)) {
      items.push(v);
      render();
      onChange?.(items);
    }
    input.value = "";
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      add();
    }
  });
  render();
  const el = h("div", { class: "chip-input" }, list, readOnly ? null : input);
  return {
    el,
    input,
    get: () => [...items],
    set: (v) => {
      items = [...v];
      render();
    },
    commitPending: add,
  };
}
