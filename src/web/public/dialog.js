// Ticket dialog: create + detail/edit (shared form).
import { api, ApiError } from "./api.js";
import { h, clear, chipInput, toast } from "./dom.js";
import { automationsWrap, fillAutomations } from "./status.js";
import {
  buildCreate,
  buildPatch,
  commentEntries,
  display,
  hasPatch,
  rowsToProps,
  snapshot,
  statusOptions,
  summarizeAutomations,
} from "./logic.js";

const dlg = () => document.getElementById("ticket-dialog");
let current = null; // the open session, if any

export const isOpen = () => current !== null && dlg().open;

/** ctx: {columns: {board: [..]}, boardNames: [..], onSaved()} */
export function openCreate(ctx, { board, status }) {
  const boardName = board ?? ctx.boardNames[0] ?? "";
  const cols = ctx.columns[boardName] ?? [];
  const empty = { name: "", status: status ?? cols[0] ?? "", board: boardName, body: "", labels: [], props: {} };
  show(new Session(ctx, { mode: "create", orig: empty }));
}

export async function openDetail(ctx, view) {
  // Show the list data immediately for read-only tickets; fetch detail for all.
  let d;
  try {
    d = await api.get(String(view.id));
  } catch (e) {
    if (!view.hasId || view.duplicate) d = { ...view, body: "", comments: {}, data: {} };
    else return toast(e.message, "error");
  }
  show(new Session(ctx, { mode: "edit", detail: d, orig: snapshot(d) }));
}

/** Called on SSE `changed`. */
export function refreshOpen() {
  return current?.externalChange();
}

export function closeDialog() {
  if (dlg().open) dlg().close();
}

function show(session) {
  if (current) current.dispose();
  current = session;
  const d = dlg();
  clear(d);
  d.append(session.root);
  if (!d.open) d.showModal();
  session.focus();
}

class Session {
  constructor(ctx, { mode, detail, orig }) {
    this.ctx = ctx;
    this.mode = mode;
    this.detail = detail;
    this.orig = orig;
    this.mtime = detail?.mtime;
    this.readOnly = Boolean(detail?.readOnly);
    this.rows = [];
    this.root = this.build();
    this.fill(orig);
  }

  build() {
    const create = this.mode === "create";
    const ro = this.readOnly;
    this.banner = h("div", { class: "banner", role: "alert", hidden: true });
    this.error = h("p", { class: "form-error", role: "alert", hidden: true });
    this.name = h("input", { type: "text", id: "t-name", required: true, disabled: ro });
    this.status = h("select", { id: "t-status", disabled: ro });
    this.board = h("input", { type: "text", id: "t-board", list: "t-boards", disabled: ro });
    const boards = h(
      "datalist",
      { id: "t-boards" },
      this.ctx.boardNames.map((b) => h("option", { value: b })),
    );
    this.labels = chipInput({ label: "Add label", placeholder: "add label ⏎", readOnly: ro });
    this.propList = h("div", { class: "prop-rows" });
    this.body = h("textarea", { id: "t-body", rows: 8, disabled: ro });
    this.board.addEventListener("change", () => this.refreshStatusOptions(this.status.value));

    const addProp = h("button", {
      type: "button",
      class: "btn small",
      text: "+ property",
      disabled: ro,
      onclick: () => this.addRow("", "", true),
    });

    const field = (label, forId, el) => h("div", { class: "field" }, h("label", { for: forId, text: label }), el);

    const head = ro
      ? h(
          "div",
          { class: "notice" },
          h("strong", { text: this.detail.duplicate ? "Read-only: duplicate id" : "Read-only: no id" }),
          h("p", {
            text: this.detail.duplicate
              ? "Another ticket uses the same id, so edits cannot be routed safely. Fix it from Settings → Fix ids…, or edit the files by hand."
              : "This ticket has no id, so it cannot be addressed. Fix it from Settings → Fix ids…, or add an id by hand.",
          }),
        )
      : null;

    const meta = create
      ? null
      : h(
          "dl",
          { class: "meta-list" },
          h("dt", { text: "Path" }),
          h("dd", { class: "mono", text: this.detail.path }),
          h("dt", { text: "Id" }),
          h("dd", { class: "mono", text: this.detail.hasId ? display(this.detail.id) : "(none)" }),
          h("dt", { text: "Type" }),
          h("dd", { class: "mono", text: display(this.detail.data?.type ?? "ticket") }),
          (this.autoWrap = automationsWrap(this.detail.automations)),
        );

    this.commentList = h("ul", { class: "comments", "aria-label": "Comments", "aria-live": "polite" });
    this.commentCount = h("span", { class: "muted" });
    this.commentInput = h(create ? "input" : "textarea", {
      type: create ? "text" : undefined,
      id: "t-comment",
      rows: create ? undefined : 2,
      placeholder: create ? "optional initial comment" : "Add a comment…",
      "aria-label": create ? "Comment" : "Add a comment",
      disabled: ro,
    });
    this.commentBtn = create
      ? null
      : h("button", { type: "button", class: "btn primary", text: "Add comment", disabled: true, onclick: () => this.addComment() });
    this.commentInput.addEventListener("input", () => this.commentDirty());
    // Enter adds (Shift+Enter = newline); the create form is never submitted from here.
    this.commentInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      if (create) return e.preventDefault();
      if (e.shiftKey) return;
      e.preventDefault();
      this.addComment();
    });
    const commentRow = create
      ? field("Comment", "t-comment", this.commentInput)
      : h(
          "div",
          { class: "field" },
          h("label", { for: "t-comment" }, "Comments", " ", this.commentCount),
          this.commentList,
          ro ? null : h("div", { class: "composer" }, this.commentInput, h("div", { class: "composer-side" }, this.commentBtn)),
        );

    this.saveBtn = h("button", { type: "submit", class: "btn primary", text: create ? "Create" : "Save", hidden: ro });
    this.resetBtn = h("button", {
      type: "button",
      class: "btn danger",
      text: "Reset automation history",
      hidden: true,
      onclick: () => this.resetAutomations(),
    });
    const form = h(
      "form",
      { method: "dialog", class: "ticket-form", onsubmit: (e) => (e.preventDefault(), this.save()) },
      h(
        "div",
        { class: "dlg-head" },
        h("h2", { text: create ? "New ticket" : ro ? "Ticket (read-only)" : "Edit ticket" }),
        h("button", {
          type: "button",
          class: "btn small only-narrow",
          "aria-label": "Close",
          title: "Close",
          text: "×",
          onclick: closeDialog,
        }),
      ),
      this.banner,
      head,
      meta,
      field("Name", "t-name", this.name),
      h("div", { class: "row2" }, field("Status", "t-status", this.status), field("Board", "t-board", this.board)),
      boards,
      h("div", { class: "field" }, h("span", { class: "lbl", text: "Labels" }), this.labels.el),
      h("div", { class: "field" }, h("span", { class: "lbl", text: "Properties" }), this.propList, addProp),
      field("Body", "t-body", this.body),
      commentRow,
      this.error,
      h(
        "div",
        { class: "actions" },
        this.resetBtn,
        h("span", { class: "spacer" }),
        h("button", { type: "button", class: "btn", text: ro ? "Close" : "Cancel", onclick: closeDialog }),
        this.saveBtn,
      ),
    );
    return form;
  }

  focus() {
    (this.mode === "create" ? this.name : this.readOnly ? this.root.querySelector(".actions button:not([hidden])") : this.name).focus();
  }

  dispose() {
    this.disposed = true;
  }

  columnsFor(boardName) {
    return this.ctx.columns[boardName] ?? this.ctx.columns[this.orig.board] ?? [];
  }

  refreshStatusOptions(selected) {
    const opts = statusOptions(this.columnsFor(this.board.value.trim()), selected);
    clear(this.status);
    if (!opts.length || !selected) this.status.append(h("option", { value: "", text: "(default)" }));
    for (const o of opts) this.status.append(h("option", { value: o, text: o }));
    this.status.value = selected && opts.includes(selected) ? selected : "";
  }

  addRow(k, v, focus = false) {
    const row = { k, v };
    const kin = h("input", { type: "text", "aria-label": "Property key", placeholder: "key", value: k, disabled: this.readOnly });
    const vin = h("input", { type: "text", "aria-label": "Property value", placeholder: "value", value: v, disabled: this.readOnly });
    kin.addEventListener("input", () => (row.k = kin.value));
    vin.addEventListener("input", () => (row.v = vin.value));
    const el = h(
      "div",
      { class: "prop-row" },
      kin,
      vin,
      this.readOnly
        ? null
        : h("button", {
            type: "button",
            class: "chip-x",
            "aria-label": "Remove property",
            text: "×",
            onclick: () => {
              this.rows = this.rows.filter((r) => r !== row);
              el.remove();
            },
          }),
    );
    this.rows.push(row);
    this.propList.append(el);
    if (focus) kin.focus();
  }

  fill(s) {
    this.name.value = s.name;
    this.board.value = s.board;
    this.refreshStatusOptions(s.status);
    this.body.value = s.body;
    this.labels.set(s.labels);
    clear(this.propList);
    this.rows = [];
    for (const [k, v] of Object.entries(s.props)) this.addRow(k, v);
    this.renderComments();
    this.commentDirty();
    this.syncReset();
  }

  /** Show "Reset automation history" only when the ticket has run history and can be written. */
  syncReset() {
    const total = summarizeAutomations(this.detail?.automations).total;
    this.resetBtn.hidden = !(this.mode === "edit" && !this.readOnly && total > 0);
  }

  renderComments() {
    if (this.mode === "create") return;
    clear(this.commentList);
    const entries = commentEntries(this.detail.comments);
    this.commentCount.textContent = entries.length ? `(${entries.length})` : "";
    if (!entries.length) {
      this.commentList.append(h("li", { class: "comment empty", text: "No comments yet." }));
      return;
    }
    for (const c of entries) {
      this.commentList.append(
        h(
          "li",
          { class: "comment" },
          h("div", { class: "cmeta" }, h("time", { datetime: c.key, title: c.abs, text: c.rel })),
          h("div", { class: "ctext", text: c.text }),
        ),
      );
    }
    this.commentList.scrollTop = this.commentList.scrollHeight;
  }

  /** Enable the add button only with text; grow the textarea to fit. */
  commentDirty() {
    if (this.commentBtn) this.commentBtn.disabled = !this.commentInput.value.trim() || this.busy;
    const el = this.commentInput;
    if (el.tagName !== "TEXTAREA") return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }

  current() {
    this.labels.commitPending();
    return {
      name: this.name.value,
      status: this.status.value,
      board: this.board.value.trim(),
      body: this.body.value,
      labels: this.labels.get(),
      props: rowsToProps(this.rows),
    };
  }

  patch() {
    return buildPatch(this.orig, this.current());
  }

  dirty() {
    if (this.mode === "create") return false;
    return hasPatch(this.patch());
  }

  showError(msg) {
    this.error.textContent = msg;
    this.error.hidden = !msg;
  }

  showBanner(message) {
    clear(this.banner);
    this.banner.hidden = false;
    this.banner.append(
      h("span", { text: message }),
      h("button", { type: "button", class: "btn small", text: "Reload", onclick: () => this.reload() }),
      this.gone ? null : h("button", { type: "button", class: "btn small danger", text: "Overwrite", onclick: () => this.overwrite() }),
    );
  }

  hideBanner() {
    this.banner.hidden = true;
    clear(this.banner);
  }

  async reload() {
    try {
      const d = await api.get(String(this.detail.id));
      this.detail = d;
      this.mtime = d.mtime;
      this.orig = snapshot(d);
      this.gone = false;
      this.fill(this.orig);
      this.hideBanner();
      this.ctx.onSaved?.(true);
    } catch (e) {
      this.showError(e.message);
    }
  }

  async overwrite() {
    try {
      const d = await api.get(String(this.detail.id));
      this.mtime = d.mtime;
      await this.save(true);
    } catch (e) {
      this.showError(e.message);
    }
  }

  /** SSE changed: refetch the open ticket. */
  async externalChange() {
    if (this.mode !== "edit" || this.disposed || this.busy) return;
    let d;
    try {
      d = await api.get(String(this.detail.id));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404 && !this.gone) {
        this.gone = true;
        this.showBanner("This ticket no longer exists on disk (moved, deleted or id changed).");
      }
      return;
    }
    if (this.disposed || d.mtime === this.mtime) return;
    if (this.onlyAutomationsChanged(d)) {
      // runner status update: refresh just the section and the stored mtime, keep the form and any edits
      this.detail = { ...this.detail, mtime: d.mtime, automations: d.automations, data: d.data };
      this.mtime = d.mtime;
      fillAutomations(this.autoWrap, d.automations, new Date());
      this.syncReset();
      return;
    }
    if (this.dirty()) return this.showBanner("This ticket changed on disk");
    this.detail = d;
    this.mtime = d.mtime;
    this.orig = snapshot(d);
    this.fill(this.orig);
    this.hideBanner();
  }

  /** True when the only on-disk difference from what the form loaded is the `automations` key. */
  onlyAutomationsChanged(d) {
    if (this.gone || !this.autoWrap) return false;
    const strip = (x) => JSON.stringify([snapshot(x), x.comments ?? {}, x.hasId, x.readOnly]);
    const rest = (x) => {
      const { automations: _automations, ...r } = x.data ?? {};
      return JSON.stringify(r);
    };
    return strip(d) === strip(this.detail) && rest(d) === rest(this.detail) && d.path === this.detail.path;
  }

  /** Clear the automations run history (loop-guard counter); no automations are triggered. */
  async resetAutomations() {
    if (this.busy) return;
    this.showError("");
    this.busy = true;
    try {
      await api.patch(String(this.detail.id), { resetAutomations: true, mtime: this.mtime });
      const d = await api.get(String(this.detail.id));
      this.detail = { ...this.detail, mtime: d.mtime, automations: d.automations, data: d.data };
      this.mtime = d.mtime;
      fillAutomations(this.autoWrap, d.automations, new Date());
      this.syncReset();
      this.ctx.onSaved?.(true);
    } catch (e) {
      this.handleError(e);
    } finally {
      this.busy = false;
    }
  }

  async addComment() {
    const text = this.commentInput.value.trim();
    if (!text || this.busy) return;
    this.showError("");
    this.busy = true;
    this.commentDirty();
    try {
      const r = await api.comment(String(this.detail.id), text, this.mtime);
      this.commentInput.value = "";
      this.commentDirty();
      this.mtime = r.mtime;
      this.detail = { ...this.detail, mtime: r.mtime, comments: { ...this.detail.comments, [r.key]: text } };
      this.renderComments();
      this.commentInput.focus();
      this.ctx.onSaved?.(true);
    } catch (e) {
      this.handleError(e);
    } finally {
      this.busy = false;
      this.commentDirty();
    }
  }

  handleError(e) {
    if (e instanceof ApiError && e.code === "stale") this.showBanner("This ticket changed on disk");
    else this.showError(e.message);
  }

  async save() {
    this.showError("");
    if (this.mode === "create") {
      const v = this.current();
      if (!v.name.trim()) {
        this.showError("Name is required");
        this.name.focus();
        return;
      }
      try {
        this.busy = true;
        const r = await api.create(buildCreate(v, this.commentInput.value));
        toast(`Created #${display(r.id)}`, "ok");
        closeDialog();
        this.ctx.onSaved?.();
      } catch (e) {
        this.showError(e.message);
      } finally {
        this.busy = false;
      }
      return;
    }
    if (this.readOnly) return;
    const p = this.patch();
    if (!hasPatch(p)) {
      closeDialog();
      return;
    }
    if (p.name !== undefined && !p.name.trim()) {
      this.showError("Name cannot be empty");
      return;
    }
    try {
      this.busy = true;
      await api.patch(String(this.detail.id), { ...p, mtime: this.mtime });
      toast("Saved", "ok");
      closeDialog();
      this.ctx.onSaved?.();
    } catch (e) {
      this.handleError(e);
    } finally {
      this.busy = false;
    }
  }
}

dlg().addEventListener("close", () => {
  current?.dispose();
  current = null;
});
