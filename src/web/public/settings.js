// Settings dialog: board config form (kanban.yaml), health (validate + warnings), fix ids.
import { api } from "./api.js";
import { h, clear, toast } from "./dom.js";
import { automationList } from "./automations.js";
import * as logs from "./logs.js";
import * as live from "./live.js";
import { liveLabel } from "./live-logic.js";
import { tabList, tabPanel } from "./settings-tabs.js";
import { ticketRulesSection } from "./ticket-rules.js";
import { scopeLines } from "./ticket-rules-logic.js";
import {
  checkForm,
  configToForm,
  describeChange,
  describeTicketChange,
  dirtyTabs,
  errorTab,
  formDirty,
  formToPayload,
  hasFixableIdIssues,
  issueSummary,
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
let fixPlan = null; // dry-run `fix` preview: {changes} | {changes: []} | {error}

export const isOpen = () => dlg().open;

let liveChanged = () => {};
/** Called by app.js with a callback for when the number of running automations changes. */
export function onLiveChange(cb) {
  liveChanged = cb;
}
export const refreshLive = () => live.refresh();
export const liveCount = () => live.count();

export function init(applied, logsCtx) {
  onApplied = applied;
  if (logsCtx) {
    logs.configure(logsCtx);
    live.configure({ openTicket: logsCtx.openTicket, onChange: () => (refreshTabs(), liveChanged()) });
  }
  dlg().addEventListener("close", () => live.unmount());
  dlg().addEventListener("mousedown", (e) => {
    dlg().dataset.bd = e.target === dlg() ? "1" : "";
  });
  dlg().addEventListener("click", (e) => {
    if (e.target === dlg() && dlg().dataset.bd === "1") requestClose();
  });
  dlg().addEventListener("cancel", (e) => {
    e.preventDefault();
    requestClose();
  });
}

/** Single close path (header ×, footer Close, Escape, backdrop): confirms when the form has unsaved changes. */
export function requestClose() {
  if (form && loaded && formDirty(form, loaded.config) && !confirm("Discard unsaved changes?")) return;
  dlg().close();
}

export function setBoardWarnings(w) {
  boardWarnings = w ?? [];
}

export async function open() {
  if (!dlg().open) dlg().showModal();
  banner = "";
  preview = null;
  fixPlan = null;
  formError = "";
  activeTab = "config";
  await loadConfig();
  await renderAll();
}

/** Called on live updates while open: refresh health; handle config changes on disk. */
export async function refresh() {
  if (!dlg().open || busy) return;
  if (activeTab === "logs") logs.live();
  let changed = false;
  try {
    const c = await api.config();
    if (!loaded || c.mtime !== loaded.mtime) {
      changed = true;
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
  if (changed || !document.getElementById("settings-panel-slot")) return renderAll();
  try {
    validation = await api.validate();
  } catch {
    return;
  }
  refreshTabs();
  updateHealth(); // Health section + footer summary only: form and scroll stay untouched
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

let activeTab = "config";
let validation = null; // last GET /api/validate
let tabs = null; // tab strip controller

const healthCount = () => (validation ? validation.errors.length + validation.warnings.length + boardWarnings.length : 0);

function tabItems() {
  const d = form && loaded ? dirtyTabs(form, loaded.config) : { config: false, automations: false };
  const bad = formError ? errorTab(formError) : "";
  const n = healthCount();
  return [
    { id: "config", label: "Config", issues: n, level: issueSummary(validation, boardWarnings).level, dirty: d.config, error: bad === "config" },
    { id: "automations", label: "Automations", dirty: d.automations, error: bad === "automations" },
    { id: "live", label: liveLabel(live.count()), running: live.count() > 0 },
    { id: "logs", label: "Logs" },
  ];
}

const refreshTabs = () => tabs?.update(tabItems());

function selectTab(id) {
  if (id === activeTab) return;
  activeTab = id;
  refreshTabs();
  renderPanel();
}

async function renderAll() {
  const body = document.getElementById("settings-body");
  try {
    validation = await api.validate();
  } catch (e) {
    clear(body);
    body.append(h("p", { class: "form-error", text: e.message }));
    return;
  }
  clear(body);
  tabs = tabList(tabItems(), () => activeTab, selectTab);
  body.append(tabs.el, h("div", { id: "settings-panel-slot" }));
  await renderPanel();
}

/** Rebuild the active tab's panel (config/automations are built from the shared form state). */
async function renderPanel() {
  const slot = document.getElementById("settings-panel-slot");
  if (!slot) return;
  const panel = tabPanel(activeTab);
  const formTab = activeTab === "config" || activeTab === "automations";
  slot.replaceChildren(panel, footer(formTab && form ? activeTab : "other"));
  if (activeTab === "logs") return void logs.mount(panel);
  if (activeTab === "live") return void live.mount(panel);
  if (!form) return void panel.append(h("p", { class: "form-error", text: formError || "Cannot load the config." }));
  if (activeTab === "config") panel.append(configPanel());
  else panel.append(automationsPanel());
}

const rerenderConfig = () => {
  refreshTabs();
  const panel = document.querySelector(".set-panel");
  if (!panel || activeTab === "logs" || activeTab === "live") return;
  const keep = panel.scrollTop;
  renderPanel().then(() => {
    const p = document.querySelector(".set-panel");
    if (p) p.scrollTop = keep;
  });
};

const input = (value, onInput, label, extra = {}) =>
  h("input", { type: "text", value, "aria-label": label, oninput: (e) => onInput(e.target.value), ...extra });

const onDirty = () => {
  const btn = document.getElementById("config-save");
  if (btn) btn.disabled = !formDirty(form, loaded.config) || busy;
  const rv = document.getElementById("config-revert");
  if (rv) rv.disabled = !formDirty(form, loaded.config);
  refreshTabs();
};

function bannerBox() {
  if (!banner) return null;
  return h(
    "div",
    { class: "banner", role: "alert" },
    h("span", { text: banner === "stale" ? "kanban.yaml changed on disk since you opened this." : "kanban.yaml changed on disk." }),
    h("button", { type: "button", class: "btn small", text: "Reload", onclick: reload }),
    banner === "stale" ? h("button", { type: "button", class: "btn small danger", text: "Overwrite", onclick: () => save(true) }) : null,
  );
}

/** Footer for every tab: form errors/preview above, summary left, actions right. kind: config | automations | other. */
function footer(kind) {
  const formTab = kind !== "other";
  const dirty = formTab && formDirty(form, loaded.config);
  const sum = issueSummary(validation, boardWarnings);
  const fixable = hasFixableIdIssues(validation, boardWarnings);
  return h(
    "footer",
    { class: "form-footer", id: "settings-footer" },
    formTab && formError ? h("p", { class: "form-error", role: "alert", text: formError }) : null,
    formTab && preview ? previewBox() : null,
    h(
      "div",
      { class: "footer-bar" },
      formTab ? summaryButton(sum) : h("span"),
      h(
        "div",
        { class: "actions" },
        kind === "config"
          ? h("button", {
              id: "config-fix",
              type: "button",
              class: "btn",
              text: "Fix ids…",
              disabled: !fixable,
              title: fixable ? "Preview id fixes" : "Nothing to fix",
              onclick: showFix,
            })
          : null,
        formTab ? h("button", { id: "config-revert", type: "button", class: "btn", text: "Revert", disabled: !dirty, onclick: reload }) : null,
        formTab ? h("button", { id: "config-save", type: "button", class: "btn primary", text: "Save config", disabled: !dirty || busy, onclick: () => save(false) }) : null,
        h("button", { id: "config-close", type: "button", class: "btn", text: "Close", onclick: requestClose }),
      ),
    ),
  );
}

function summaryButton(sum) {
  return h("button", {
    type: "button",
    id: "issue-summary",
    class: `issue-summary ${sum.level}`,
    text: sum.text,
    "aria-describedby": "health-section",
    title: sum.count ? "Go to Health" : "",
    onclick: gotoHealth,
  });
}

async function gotoHealth() {
  if (activeTab !== "config") {
    activeTab = "config";
    refreshTabs();
    await renderPanel();
  }
  document.getElementById("health-section")?.scrollIntoView({ block: "nearest" });
  document.getElementById("health-section")?.focus({ preventScroll: true });
}

async function showFix() {
  try {
    fixPlan = await api.fix(true);
  } catch (e) {
    fixPlan = { error: e.message };
  }
  updateHealth();
  document.getElementById("health-section")?.scrollIntoView({ block: "nearest" });
}

/** Re-render only the Health section and footer summary/fix button (keeps form state and scroll). */
function updateHealth() {
  const old = document.getElementById("health-section");
  if (old) old.replaceWith(healthSection());
  const sum = document.getElementById("issue-summary");
  if (sum) sum.replaceWith(summaryButton(issueSummary(validation, boardWarnings)));
  const fix = document.getElementById("config-fix");
  if (fix) {
    const fixable = hasFixableIdIssues(validation, boardWarnings);
    fix.disabled = !fixable;
    fix.title = fixable ? "Preview id fixes" : "Nothing to fix";
  }
}

function configPanel() {
  const sec = h("section", { id: "config-section", class: "config" }, h("h3", { class: "section-title", text: "Board config (kanban.yaml)" }), bannerBox());
  sec.append(
    h(
      "div",
      { class: "row2" },
      h("div", { class: "field" }, h("label", { text: "Default board name" }), input(form.name, (v) => ((form.name = v), onDirty()), "Default board name")),
      h("div", { class: "field" }, h("label", { text: "Ticket files (glob)" }), input(form.glob, (v) => ((form.glob = v), onDirty()), "Glob")),
    ),
    h("div", { class: "field" }, h("span", { class: "lbl", text: "Columns (in order)" }), columnList(form.columns, onDirty)),
    h("span", { class: "lbl", text: "Per-board column overrides (optional)" }),
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
            input(b.name, (v) => ((b.name = v), onDirty()), "Board name"),
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
          columnList(b.columns, onDirty),
        ),
      ),
      h("button", {
        type: "button",
        class: "btn small",
        text: "+ Add board override",
        onclick: () => {
          form.boards.push({ orig: null, name: "", columns: [{ orig: null, value: "" }], automations: [] });
          rerenderConfig();
        },
      }),
    ),
    ticketRulesSection({ t: form.tickets, onChange: onDirty, changed: () => formDirty(form, loaded.config), error: () => formError }),
    healthSection(),
  );
  return sec;
}

function automationsPanel() {
  const boards = [{ name: () => form.name.trim() || "(unnamed)", rules: form.automations, cols: form.columns, test: () => form.name.trim() }].concat(
    form.boards.map((b) => ({ name: () => b.name.trim() || "(unnamed)", rules: b.automations, cols: b.columns, test: () => b.name.trim() })),
  );
  const sec = h("section", { class: "config", id: "automations-section" }, bannerBox());
  boards.forEach((b, i) => {
    const title = b.name();
    sec.append(
      h(
        "div",
        { class: "board-auto" },
        h("h4", { text: `Board: ${title}${i === 0 ? " (default)" : ""}` }),
        automationList({ rules: b.rules, cols: b.cols, board: b.test, onChange: onDirty }),
      ),
    );
  });
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
  const scope = scopeLines(preview.scope);
  return h(
    "div",
    { class: "notice", role: "alertdialog", id: "save-confirm" },
    scope.length ? h("ul", { class: "tr-scope" }, scope.map((s) => h("li", { text: s }))) : null,
    n ? h("strong", { text: `This will edit ${n} ticket file${n === 1 ? "" : "s"}:` }) : null,
    n ? h("ul", { class: "mono" }, preview.changes.slice(0, 50).map((c) => h("li", { text: describeTicketChange(c) }))) : null,
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
      if (dry.changes.length || scopeLines(dry.ticketScope).length) {
        preview = { changes: dry.changes, scope: dry.ticketScope, overwrite };
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

function healthSection() {
  const v = validation;
  const sec = h("section", { id: "health-section", class: "health", tabIndex: -1, "aria-label": "Health" }, h("h3", { class: "section-title", text: "Health" }));
  const none = !v.errors.length && !v.warnings.length && !boardWarnings.length;
  if (none) sec.append(h("p", { class: "muted", text: "No issues found." }));
  else sec.append(...[section("Errors", v.errors, "error"), section("Warnings", v.warnings, "warn"), boardSection()].filter(Boolean));
  sec.append(fixBox());
  return sec;
}

function section(title, issues, kind) {
  if (!issues.length) return null;
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

function fixBox() {
  const box = h("div", { class: "fix-box" });
  if (!fixPlan) return box;
  if (fixPlan.error) return box.append(h("p", { class: "form-error", role: "alert", text: fixPlan.error })), box;
  if (!fixPlan.changes.length) return box.append(h("p", { class: "muted", text: "Nothing to fix." })), box;
  box.append(
    h("p", { text: `${fixPlan.changes.length} change(s) planned:` }),
    h("ul", { class: "mono" }, fixPlan.changes.map((c) => h("li", { text: describeChange(c) }))),
    h(
      "div",
      { class: "actions" },
      h("button", { type: "button", class: "btn", text: "Cancel", onclick: () => ((fixPlan = null), updateHealth()) }),
      h("button", {
        type: "button",
        class: "btn primary",
        text: "Apply",
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            const a = await api.fix(false);
            fixPlan = null;
            toast(`Fixed ${a.changes.length} file(s)`, "ok");
            onApplied();
            validation = await api.validate();
            refreshTabs();
            updateHealth();
          } catch (err) {
            toast(err.message, "error");
            e.target.disabled = false;
          }
        },
      }),
    ),
  );
  return box;
}

/** Count shown in the header badge. */
export const badgeCount = (v) => v.errors.length + v.warnings.length;
