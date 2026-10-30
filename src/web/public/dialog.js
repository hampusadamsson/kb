// Ticket dialog: create + detail/edit (shared form).
import { api, ApiError } from "./api.js";
import { h, clear, chipInput, toast } from "./dom.js";
import {
  buildCreate,
  buildPatch,
  display,
  hasPatch,
  rowsToProps,
  snapshot,
  sortedComments,
  statusOptions,
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
    const boards = h("datalist", { id: "t-boards" }, this.ctx.boardNames.map((b) => h("option", { value: b })));
    this.labels = chipInput({ label: "Add label", placeholder: "add label ⏎", readOnly: ro });
    this.propList = h("div", { class: "prop-rows" });
    this.body = h("textarea", { id: "t-body", rows: 8, disabled: ro });
    this.board.addEventListener("change", () => this.refreshStatusOptions(this.status.value));

    const addProp = h("button", { type: "button", class: "btn small", text: "+ property", disabled: ro, onclick: () => this.addRow("", "", true) });

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
        );

    this.commentList = h("ul", { class: "comments" });
    this.commentInput = h("input", { type: "text", id: "t-comment", placeholder: create ? "optional initial comment" : "add a comment", disabled: ro });
    const commentRow = create
      ? field("Comment", "t-comment", this.commentInput)
      : h(
          "div",
          { class: "field" },
          h("label", { for: "t-comment", text: "Comments" }),
          this.commentList,
          ro
            ? null
            : h(
                "div",
                { class: "row" },
                this.commentInput,
                h("button", { type: "button", class: "btn", text: "Add comment", onclick: () => this.addComment() }),
              ),
        );
    this.commentInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !create) {
        e.preventDefault();
        this.addComment();
      } else if (e.key === "Enter") e.preventDefault();
    });

    this.saveBtn = h("button", { type: "submit", class: "btn primary", text: create ? "Create" : "Save", hidden: ro });
    const form = h(
      "form",
      { method: "dialog", class: "ticket-form", onsubmit: (e) => (e.preventDefault(), this.save()) },
      h("h2", { text: create ? "New ticket" : ro ? "Ticket (read-only)" : "Edit ticket" }),
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
        h("button", { type: "button", class: "btn", text: ro ? "Close" : "Cancel", onclick: closeDialog }),
        this.saveBtn,
      ),
    );
    return form;
  }

  focus() {
    (this.mode === "create" ? this.name : this.readOnly ? this.root.querySelector(".actions button") : this.name).focus();
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
  }

  renderComments() {
    if (this.mode === "create") return;
    clear(this.commentList);
    const entries = sortedComments(this.detail.comments);
    if (!entries.length) this.commentList.append(h("li", { class: "muted", text: "No comments yet." }));
    for (const [k, t] of entries) {
      this.commentList.append(h("li", {}, h("span", { class: "ckey mono", text: k }), h("span", { class: "ctext", text: t })));
    }
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
    if (this.dirty()) return this.showBanner("This ticket changed on disk");
    this.detail = d;
    this.mtime = d.mtime;
    this.orig = snapshot(d);
    this.fill(this.orig);
    this.hideBanner();
  }

  async addComment() {
    const text = this.commentInput.value.trim();
    if (!text || this.busy) return;
    this.showError("");
    this.busy = true;
    try {
      const r = await api.comment(String(this.detail.id), text, this.mtime);
      this.commentInput.value = "";
      this.mtime = r.mtime;
      this.detail = { ...this.detail, mtime: r.mtime, comments: { ...this.detail.comments, [r.key]: text } };
      this.renderComments();
      this.ctx.onSaved?.(true);
    } catch (e) {
      this.handleError(e);
    } finally {
      this.busy = false;
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
