// Settings dialog: board config form (kanban.yaml), health (validate + warnings), fix ids.
import { api } from "./api.js";
import { h, clear, toast } from "./dom.js";
import {
  checkForm,
  configToForm,
  describeChange,
  describeTicketChange,
  formDirty,
  formToPayload,
  moveItem,
} from "./logic.js";

const dlg = () => document.getElementById("settings-dialog");
let boardWarnings = [];
let onApplied = () => {};

// config form state
let loaded = null; // last GET /api/config: {config, mtime}
let form = null;
let banner = ""; // "" | "external" | "stale"
let preview = null; // pending save confirmation: {changes}
let formError = "";
let busy = false;

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
  banner = "";
  preview = null;
  formError = "";
  await loadConfig();
  await renderAll();
}

/** Called on live updates while open: refresh health; handle config changes on disk. */
export async function refresh() {
  if (!dlg().open || busy) return;
  try {
    const c = await api.config();
    if (!loaded || c.mtime !== loaded.mtime) {
      if (form && formDirty(form, loaded.config)) banner = "external";
      else {
        loaded = c;
        form = configToForm(c.config);
        preview = null;
      }
    }
  } catch {
    /* shown by renderAll through validate */
  }
  await renderAll();
}

async function loadConfig() {
  try {
    loaded = await api.config();
    form = configToForm(loaded.config);
    banner = "";
    preview = null;
  } catch (e) {
    loaded = null;
    form = null;
    formError = e.message;
  }
}

// ---- render ----

async function renderAll() {
  const body = document.getElementById("settings-body");
  let v;
  try {
    v = await api.validate();
  } catch (e) {
    clear(body);
    body.append(h("p", { class: "form-error", text: e.message }));
    return;
  }
  const fixBox = h("div", { class: "fix-box" });
  const keep = body.scrollTop;
  clear(body);
  body.append(
    configSection(),
    h("h3", { class: "section-title", text: "Health" }),
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
  body.scrollTop = keep;
}

function rerenderConfig() {
  const old = document.getElementById("config-section");
  if (old) old.replaceWith(configSection());
}

const input = (value, onInput, label, extra = {}) =>
  h("input", { type: "text", value, "aria-label": label, oninput: (e) => onInput(e.target.value), ...extra });

function configSection() {
  const sec = h("section", { id: "config-section", class: "config" }, h("h3", { class: "section-title", text: "Board config (kanban.yaml)" }));
  if (!form) {
    sec.append(h("p", { class: "form-error", text: formError || "Cannot load the config." }));
    return sec;
  }
  if (banner) {
    sec.append(
      h(
        "div",
        { class: "banner", role: "alert" },
        h("span", { text: banner === "stale" ? "kanban.yaml changed on disk since you opened this." : "kanban.yaml changed on disk." }),
        h("button", { type: "button", class: "btn small", text: "Reload", onclick: reload }),
        banner === "stale" ? h("button", { type: "button", class: "btn small danger", text: "Overwrite", onclick: () => save(true) }) : null,
      ),
    );
  }

  const rerenderDirty = () => {
    const btn = document.getElementById("config-save");
    if (btn) btn.disabled = !formDirty(form, loaded.config) || busy;
  };

  sec.append(
    h(
      "div",
      { class: "row2" },
      h("div", { class: "field" }, h("label", { text: "Default board name" }), input(form.name, (v) => ((form.name = v), rerenderDirty()), "Default board name")),
      h("div", { class: "field" }, h("label", { text: "Ticket files (glob)" }), input(form.glob, (v) => ((form.glob = v), rerenderDirty()), "Glob")),
    ),
    h("div", { class: "field" }, h("span", { class: "lbl", text: "Columns (in order)" }), columnList(form.columns, rerenderDirty)),
    h("span", { class: "lbl", text: "Per-board columns (optional overrides)" }),
    h(
      "div",
      { class: "board-overrides" },
      form.boards.map((b, i) =>
        h(
          "div",
          { class: "override" },
          h(
            "div",
            { class: "row" },
            input(b.name, (v) => ((b.name = v), rerenderDirty()), "Board name"),
            h("button", {
              type: "button",
              class: "btn small danger",
              text: "Remove board",
              title: "Tickets on this board fall back to the default columns",
              onclick: () => {
                form.boards.splice(i, 1);
                rerenderConfig();
              },
            }),
          ),
          columnList(b.columns, rerenderDirty),
        ),
      ),
      h("button", {
        type: "button",
        class: "btn small",
        text: "+ Add board override",
        onclick: () => {
          form.boards.push({ orig: null, name: "", columns: [{ orig: null, value: "" }] });
          rerenderConfig();
        },
      }),
    ),
  );

  if (formError) sec.append(h("p", { class: "form-error", role: "alert", text: formError }));
  if (preview) sec.append(previewBox());
  sec.append(
    h(
      "div",
      { class: "actions" },
      h("button", { type: "button", class: "btn", text: "Revert", disabled: !formDirty(form, loaded.config), onclick: reload }),
      h("button", { id: "config-save", type: "button", class: "btn primary", text: "Save config", disabled: !formDirty(form, loaded.config) || busy, onclick: () => save(false) }),
    ),
  );
  return sec;
}

/** Ordered, editable column list: rename inline, reorder, remove, add. */
function columnList(rows, onChange) {
  const box = h("div", { class: "col-list" });
  const draw = () => {
    clear(box);
    rows.forEach((r, i) => {
      box.append(
        h(
          "div",
          { class: "col-row" },
          input(r.value, (v) => ((r.value = v), onChange()), `Column ${i + 1}`),
          h("button", { type: "button", class: "btn small", text: "↑", "aria-label": "Move up", disabled: i === 0, onclick: () => swap(i, -1) }),
          h("button", { type: "button", class: "btn small", text: "↓", "aria-label": "Move down", disabled: i === rows.length - 1, onclick: () => swap(i, 1) }),
          h("button", { type: "button", class: "btn small danger", text: "×", "aria-label": "Remove column", onclick: () => remove(i) }),
        ),
      );
    });
    box.append(h("button", { type: "button", class: "btn small", text: "+ Add column", onclick: add }));
  };
  const swap = (i, d) => {
    const next = moveItem(rows, i, d);
    rows.splice(0, rows.length, ...next);
    onChange();
    draw();
  };
  const remove = (i) => {
    rows.splice(i, 1);
    onChange();
    draw();
  };
  const add = () => {
    rows.push({ orig: null, value: "" });
    onChange();
    draw();
    box.querySelectorAll("input")[rows.length - 1]?.focus();
  };
  draw();
  return box;
}

function previewBox() {
  const n = preview.changes.length;
  return h(
    "div",
    { class: "notice", role: "alertdialog" },
    h("strong", { text: `This will edit ${n} ticket file${n === 1 ? "" : "s"}:` }),
    h("ul", { class: "mono" }, preview.changes.slice(0, 50).map((c) => h("li", { text: describeTicketChange(c) }))),
    n > 50 ? h("p", { class: "muted", text: `… and ${n - 50} more` }) : null,
    h(
      "div",
      { class: "actions" },
      h("button", { type: "button", class: "btn", text: "Cancel", onclick: () => ((preview = null), rerenderConfig()) }),
      h("button", { type: "button", class: "btn primary", text: "Confirm and save", onclick: () => save(preview.overwrite, true) }),
    ),
  );
}

// ---- actions ----

async function reload() {
  formError = "";
  await loadConfig();
  rerenderConfig();
}

/**
 * Save the form. First a dry run: if tickets would change, ask for confirmation (count + list).
 * `overwrite` ignores the mtime check; `confirmed` skips the dry-run preview.
 */
async function save(overwrite, confirmed = false) {
  formError = "";
  const problem = checkForm(form);
  if (problem) {
    formError = problem;
    return rerenderConfig();
  }
  const { config, renames } = formToPayload(form);
  const base = { config, renames, mtime: overwrite ? undefined : loaded.mtime };
  busy = true;
  try {
    if (!confirmed) {
      const dry = await api.putConfig({ ...base, dryRun: true });
      if (dry.changes.length) {
        preview = { changes: dry.changes, overwrite };
        busy = false;
        return rerenderConfig();
      }
    }
    const r = await api.putConfig(base);
    preview = null;
    banner = "";
    toast(r.changes.length ? `Config saved; ${r.changes.length} ticket(s) updated` : "Config saved", "ok");
    await loadConfig();
    onApplied();
  } catch (e) {
    preview = null;
    if (e.code === "stale") banner = "stale";
    else formError = e.message;
  } finally {
    busy = false;
  }
  await renderAll();
}

// ---- health ----

function section(title, issues, kind) {
  return h(
    "section",
    { class: "issues" },
    h("h4", { text: `${title} (${issues.length})` }),
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
    h("h4", { text: `Board warnings (${boardWarnings.length})` }),
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
            await renderAll();
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
