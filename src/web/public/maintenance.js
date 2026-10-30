// Maintenance dialog: validation issues, board warnings, fix ids.
import { api } from "./api.js";
import { h, clear, toast } from "./dom.js";
import { describeChange } from "./logic.js";

const dlg = () => document.getElementById("maint-dialog");
let boardWarnings = [];
let onApplied = () => {};

export const isOpen = () => dlg().open;

export function init(applied) {
  onApplied = applied;
  dlg().addEventListener("mousedown", (e) => {
    dlg().dataset.bd = e.target === dlg() ? "1" : "";
  });
  dlg().addEventListener("click", (e) => {
    if (e.target === dlg() && dlg().dataset.bd === "1") dlg().close();
  });
}

export function setBoardWarnings(w) {
  boardWarnings = w ?? [];
}

export async function open() {
  if (!dlg().open) dlg().showModal();
  await refresh();
}

export async function refresh() {
  if (!dlg().open) return;
  const body = document.getElementById("maint-body");
  let v;
  try {
    v = await api.validate();
  } catch (e) {
    clear(body);
    body.append(h("p", { class: "form-error", text: e.message }));
    return;
  }
  const fixBox = h("div", { class: "fix-box" });
  clear(body);
  body.append(
    section("Errors", v.errors, "error"),
    section("Warnings", v.warnings, "warn"),
    boardSection(),
    h(
      "div",
      { class: "fix-area" },
      h("button", { type: "button", class: "btn", text: "Fix ids…", onclick: () => planFix(fixBox) }),
      fixBox,
    ),
  );
}

function section(title, issues, kind) {
  return h(
    "section",
    { class: "issues" },
    h("h3", { text: `${title} (${issues.length})` }),
    issues.length
      ? h(
          "ul",
          {},
          issues.map((i) =>
            h("li", { class: kind }, i.path ? h("span", { class: "mono path", text: i.path }) : null, h("span", { text: i.message })),
          ),
        )
      : h("p", { class: "muted", text: "None." }),
  );
}

function boardSection() {
  if (!boardWarnings.length) return null;
  return h(
    "section",
    { class: "issues" },
    h("h3", { text: `Board warnings (${boardWarnings.length})` }),
    h(
      "ul",
      {},
      boardWarnings.map((w) =>
        h(
          "li",
          { class: "warn" },
          w.path || w.paths?.length ? h("span", { class: "mono path", text: w.path ?? w.paths.join(", ") }) : null,
          h("span", { text: `${w.message}` }),
        ),
      ),
    ),
  );
}

async function planFix(box) {
  clear(box);
  try {
    const r = await api.fix(true);
    if (!r.changes.length) return box.append(h("p", { class: "muted", text: "Nothing to fix." }));
    box.append(
      h("p", { text: `${r.changes.length} change(s) planned:` }),
      h("ul", { class: "mono" }, r.changes.map((c) => h("li", { text: describeChange(c) }))),
      h("button", {
        type: "button",
        class: "btn primary",
        text: "Apply",
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            const a = await api.fix(false);
            toast(`Fixed ${a.changes.length} file(s)`, "ok");
            onApplied();
            await refresh();
          } catch (err) {
            toast(err.message, "error");
            e.target.disabled = false;
          }
        },
      }),
    );
  } catch (e) {
    box.append(h("p", { class: "form-error", text: e.message }));
  }
}

/** Count shown in the header badge. */
export const badgeCount = (v) => v.errors.length + v.warnings.length;
