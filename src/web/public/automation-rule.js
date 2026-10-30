// One automation rule: collapsible card (header summary + When / Run / Options / Test sections).
import { api } from "./api.js";
import { h, clear, chipInput } from "./dom.js";
import { describeTestRun, effectiveColumn, testBody } from "./logic.js";
import { EVENT_OPTIONS, insertAtCursor, VARIABLES, durationText, previewScript, ruleIssues, ruleSummary, ruleTitle, sampleFor, statusText } from "./automation-logic.js";

const CONFIRM = "This really runs the script on this machine with a sample ticket.";
let seq = 0;

/** Distinct, non-blank column values of a board's column rows, with the rule's current column included. */
function columnOptions(cols, rule) {
  const vals = cols.map((r) => r.value.trim()).filter(Boolean);
  const cur = effectiveColumn(cols, rule.column);
  return vals.includes(cur) || !cur ? vals : [...vals, cur];
}

const unknownVars = (run) => {
  const known = new Set(VARIABLES.map((v) => v[0]));
  const bad = [];
  for (const m of run.matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)) {
    const v = m[1];
    if (!known.has(v) && !(v.startsWith("props.") && v.length > 6) && !bad.includes(v)) bad.push(v);
  }
  return bad;
};

/**
 * Rule card. ctx = { rules, cols, board(), tickets(), isOpen(r), setOpen(r, bool), onChange(), onDuplicate(r), onDelete(r), runOf(r) }.
 * Returns { el, focusName(), focusToggle(), update() }.
 */
export function ruleCard(r, ctx) {
  const uid = `arule-${++seq}`;
  const touched = new Set(r.orig === null ? [] : ["name", "run", "column"]);
  const bodyId = `${uid}-body`;

  // ---- header ----
  const mark = h("span", { class: "arule-mark", hidden: true, title: "Needs attention", "aria-hidden": "true", text: "!" });
  const title = h("span", { class: "arule-title" });
  const flag = h("span", { class: "sr-only" });
  const statusEl = h("span", { class: "arule-status" });
  const sum = h("span", { class: "arule-sum muted" });
  const chev = h("span", { class: "arule-chev", "aria-hidden": "true", text: "▸" });
  const toggle = h(
    "button",
    { type: "button", class: "arule-toggle", "aria-expanded": "false", "aria-controls": bodyId, onclick: () => setOpen(toggle.getAttribute("aria-expanded") !== "true") },
    chev,
    h("span", { class: "arule-text" }, h("span", { class: "arule-line" }, mark, title, flag, statusEl), sum),
  );
  const sw = h("input", { type: "checkbox", role: "switch", "aria-label": `Enabled: ${ruleTitle(r)}`, checked: r.enabled, onchange: (e) => ((r.enabled = e.target.checked), ctx.onChange(), updateHead()) });
  const switchLbl = h("label", { class: "arule-switch" }, sw, h("span", { class: "arule-switch-text", text: "Enabled" }));
  const dup = h("button", { type: "button", class: "btn small", text: "Duplicate", onclick: () => ctx.onDuplicate(r) });
  const del = h("button", { type: "button", class: "btn small danger", text: "Delete", onclick: () => ctx.onDelete(r) });
  const head = h("div", { class: "arule-head" }, switchLbl, toggle, h("div", { class: "arule-actions" }, dup, del));

  // ---- body: name ----
  const nameErr = h("p", { class: "arule-err", id: `${uid}-name-err`, hidden: true });
  const nameIn = h("input", {
    type: "text", id: `${uid}-name`, placeholder: "e.g. notify-on-review", value: r.name, "aria-describedby": `${uid}-name-err`,
    oninput: (e) => ((r.name = e.target.value), ctx.onChange(), validate()),
    onblur: () => (touched.add("name"), validate()),
  });

  // ---- 1 When ----
  const evSel = h(
    "select",
    { id: `${uid}-event`, onchange: (e) => ((r.event = e.target.value), ctx.onChange(), updateHead(), updatePreview()) },
    EVENT_OPTIONS.map((o) => h("option", { value: o.value, text: o.label, selected: o.value === r.event })),
  );
  const colErr = h("p", { class: "arule-err", id: `${uid}-col-err`, hidden: true });
  const colSel = h("select", { id: `${uid}-col`, "aria-describedby": `${uid}-col-err`, onchange: (e) => ((r.column = e.target.value), touched.add("column"), ctx.onChange(), updateHead(), validate(), updatePreview()) });
  const fillCols = () => {
    clear(colSel);
    // r.column may point at a renamed column: show its new name, keep the value in sync
    r.column = effectiveColumn(ctx.cols, r.column);
    for (const c of columnOptions(ctx.cols, r)) colSel.append(h("option", { value: c, text: c, selected: c === r.column }));
  };
  fillCols();
  colSel.addEventListener("focus", fillCols);
  colSel.addEventListener("mousedown", fillCols);

  const chips = chipInput({ label: `Required labels (${ruleTitle(r)})`, placeholder: "label, Enter", values: r.labels, onChange: (v) => ((r.labels = v), ctx.onChange(), updateHead(), updatePreview()) });
  chips.input.id = `${uid}-labels`;
  const propRows = h("div", { class: "auto-props" });
  const drawProps = (focusLast) => {
    clear(propRows);
    r.props.forEach((p, i) =>
      propRows.append(
        h(
          "div",
          { class: "row" },
          h("input", { type: "text", placeholder: "property", "aria-label": `Property key ${i + 1}`, value: p.key, oninput: (e) => ((p.key = e.target.value), ctx.onChange(), updateHead(), updatePreview()) }),
          h("input", { type: "text", placeholder: "value (!x = not x)", "aria-label": `Property value ${i + 1}`, value: p.value, oninput: (e) => ((p.value = e.target.value), ctx.onChange(), updateHead(), updatePreview()) }),
          h("button", { type: "button", class: "btn small danger", text: "×", "aria-label": `Remove property ${p.key || i + 1}`, onclick: () => (r.props.splice(i, 1), ctx.onChange(), drawProps(), updateHead(), updatePreview()) }),
        ),
      ),
    );
    propRows.append(h("button", { type: "button", class: "btn small", text: "+ Add property", onclick: () => (r.props.push({ key: "", value: "" }), ctx.onChange(), drawProps(true)) }));
    if (focusLast) propRows.querySelectorAll("input")[r.props.length * 2 - 2]?.focus();
  };
  drawProps();

  // ---- 2 Run ----
  const runErr = h("p", { class: "arule-err", id: `${uid}-run-err`, hidden: true });
  const varWarn = h("p", { class: "arule-err", id: `${uid}-run-warn`, hidden: true });
  const runTa = h("textarea", {
    class: "mono arule-run", id: `${uid}-run`, rows: 3, spellcheck: false, placeholder: "echo {{ id }} >> done.txt", value: r.run,
    "aria-describedby": `${uid}-run-err ${uid}-run-warn ${uid}-run-hint`,
    oninput: () => ((r.run = runTa.value), grow(), ctx.onChange(), validate(), updatePreview()),
    onblur: () => (touched.add("run"), validate()),
  });
  const grow = () => {
    runTa.style.height = "auto";
    runTa.style.height = `${Math.min(runTa.scrollHeight + 2, 320)}px`;
  };
  const varBar = h(
    "div",
    { class: "arule-vars", role: "group", "aria-label": "Insert variable" },
    VARIABLES.map(([name, snippet, tip]) =>
      h("button", {
        type: "button", class: "chip prop arule-var", text: name, title: `Insert ${snippet}: ${tip}`,
        onclick: () => {
          const ins = insertAtCursor(runTa.value, runTa.selectionStart, runTa.selectionEnd, snippet);
          runTa.value = ins.value;
          r.run = ins.value;
          runTa.focus();
          runTa.setSelectionRange(ins.start, ins.end);
          grow();
          ctx.onChange();
          validate();
          updatePreview();
        },
      }),
    ),
  );
  const preview = h("pre", { class: "mono auto-out arule-preview", hidden: true, "aria-label": "Rendered script preview" });
  const previewWrap = h("div", { class: "field", hidden: true }, h("span", { class: "lbl", text: "Preview with a sample ticket (values are shell-quoted)" }), preview);

  // ---- 3 Options ----
  const guard = h("input", { type: "checkbox", id: `${uid}-guard`, checked: r.guard !== false, "aria-describedby": `${uid}-guard-hint`, onchange: (e) => ((r.guard = e.target.checked), ctx.onChange(), updateHead()) });

  // ---- Test ----
  const pick = h("select", { id: `${uid}-pick`, "aria-label": "Ticket for the test run" }, h("option", { value: "", text: "Sample ticket" }));
  const out = h("pre", { class: "mono auto-out", hidden: true, tabIndex: 0, "aria-label": "Test run output" });
  const res = h("p", { class: "arule-result", role: "status", "aria-live": "polite" });
  const testBtn = h("button", { type: "button", class: "btn small", text: "Run test", onclick: runTest });
  let pickedFor = -1;
  const fillPicker = () => {
    const ts = ctx.tickets();
    if (ts.length === pickedFor) return;
    pickedFor = ts.length;
    const cur = pick.value;
    clear(pick);
    pick.append(h("option", { value: "", text: "Sample ticket" }));
    for (const t of ts.slice(0, 50)) pick.append(h("option", { value: String(t.id), text: `#${t.id} ${t.name}`, selected: String(t.id) === cur }));
  };
  pick.addEventListener("focus", fillPicker);
  pick.addEventListener("mousedown", fillPicker);

  function showRes(kind, text, body) {
    res.className = `arule-result ${kind}`;
    res.textContent = text;
    out.textContent = body ?? "";
    out.hidden = !body;
  }
  async function runTest() {
    if (!r.run.trim()) return showRes("failed", "Script is empty. Enter a script first.", "");
    if (!confirm(CONFIRM)) return;
    testBtn.disabled = true;
    showRes("running", "Running…", "");
    const t0 = performance.now();
    try {
      const col = effectiveColumn(ctx.cols, r.column);
      const body = testBody(r, ctx.board());
      const s = sampleFor(r, col);
      const t = ctx.tickets().find((x) => String(x.id) === pick.value);
      if (t) Object.assign(s, { id: String(t.id), name: t.name, status: t.status ?? col, labels: t.labels ?? s.labels, props: t.props && typeof t.props === "object" ? t.props : s.props });
      body.sample = s;
      const data = await api.testAutomation(body);
      const ms = performance.now() - t0;
      const rr = data.result;
      const ok = rr.exitCode === 0 && !rr.error;
      showRes(ok ? "done" : "failed", `${ok ? "Passed" : "Failed"}: exit ${rr.exitCode ?? "(none)"}${rr.error ? `, ${rr.error}` : ""} · ${durationText(ms)}`, describeTestRun(data));
    } catch (err) {
      showRes("failed", `Could not run: ${err.message}`, "");
    } finally {
      testBtn.disabled = false;
    }
  }

  // ---- behaviour ----
  function validate() {
    const iss = ruleIssues(r, ctx.rules, ctx.cols);
    const set = (el, input, key) => {
      const msg = touched.has(key) ? iss[key] : "";
      el.textContent = msg ?? "";
      el.hidden = !msg;
      if (msg) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    };
    set(nameErr, nameIn, "name");
    set(colErr, colSel, "column");
    set(runErr, runTa, "run");
    const bad = unknownVars(r.run);
    varWarn.textContent = bad.length ? `Unknown variable${bad.length > 1 ? "s" : ""}: ${bad.map((v) => `{{ ${v} }}`).join(", ")}. Saving works, but the script will fail to render.` : "";
    varWarn.hidden = !bad.length;
    updateHead(iss);
  }
  function updatePreview() {
    const run = r.run.trim();
    previewWrap.hidden = !run;
    if (run) preview.textContent = previewScript(r.run, sampleFor(r, effectiveColumn(ctx.cols, r.column), ctx.board()), r.event);
    preview.hidden = !run;
  }
  function updateHead(iss = ruleIssues(r, ctx.rules, ctx.cols)) {
    const invalid = Object.keys(iss).length > 0;
    title.textContent = ruleTitle(r);
    title.classList.toggle("untitled", !r.name.trim());
    mark.hidden = !invalid;
    flag.textContent = invalid ? "Needs attention" : "";
    sum.textContent = ruleSummary(r, effectiveColumn(ctx.cols, r.column));
    card.classList.toggle("off", !r.enabled);
    card.classList.toggle("invalid", invalid);
    sw.checked = r.enabled;
    sw.setAttribute("aria-label", `Enabled: ${ruleTitle(r)}`);
    del.setAttribute("aria-label", `Delete ${ruleTitle(r)}`);
    dup.setAttribute("aria-label", `Duplicate ${ruleTitle(r)}`);
    const run = ctx.runOf(r);
    const off = !r.enabled;
    const state = r.orig === null ? "new" : off ? "disabled" : (run?.state ?? "none");
    statusEl.className = `arule-status ${state}`;
    clear(statusEl);
    if (state === "new") statusEl.append("not saved yet");
    else if (state === "disabled") statusEl.append("disabled");
    else if (state === "none") statusEl.append(ctx.runsKnown() ? "never run" : "");
    else statusEl.append(h("span", { class: `sdot ${state}`, "aria-hidden": "true" }), statusText(run));
    if (r.guard === false) statusEl.append(h("span", { class: "arule-nog", title: "Loop guard is off", text: " · no loop guard" }));
  }
  function setOpen(on) {
    ctx.setOpen(r, on);
    apply();
    if (on) {
      grow();
      fillPicker();
    }
  }
  function apply() {
    const on = ctx.isOpen(r, !!Object.keys(ruleIssues(r, ctx.rules, ctx.cols)).length);
    toggle.setAttribute("aria-expanded", String(on));
    body.hidden = !on;
    card.classList.toggle("open", on);
    chev.textContent = on ? "▾" : "▸";
  }

  const section = (n, label, ...kids) => {
    const id = `${uid}-s${n}`;
    return h("div", { class: "arule-sec", role: "group", "aria-labelledby": id }, h("h5", { class: "arule-sec-title", id }, h("span", { class: "arule-step", "aria-hidden": "true", text: String(n) }), label), ...kids);
  };
  const body = h(
    "div",
    { class: "arule-body", id: bodyId, hidden: true },
    h("div", { class: "field" }, h("label", { for: `${uid}-name`, text: "Name" }), nameIn, nameErr),
    section(
      1, "When",
      h("div", { class: "row arule-when" }, h("div", { class: "field" }, h("label", { for: `${uid}-event`, text: "Event" }), evSel), h("div", { class: "field" }, h("label", { for: `${uid}-col`, text: "Column" }), colSel)),
      colErr,
      h("div", { class: "field" }, h("label", { for: `${uid}-labels`, text: "Only if it has all these labels (optional)" }), chips.el),
      h("div", { class: "field" }, h("span", { class: "lbl", text: "Only if properties match (optional)" }), propRows),
      h("p", { class: "muted hint", text: "Start a property value with ! to mean “not”, e.g. priority = !low matches anything except low." }),
    ),
    section(
      2, "Run",
      h("div", { class: "field" }, h("label", { for: `${uid}-run`, text: "Shell script" }), runTa, runErr, varWarn),
      h("div", { class: "field" }, h("span", { class: "lbl", text: "Insert a variable at the cursor" }), varBar),
      h("p", { class: "muted hint", id: `${uid}-run-hint`, text: "Values are shell-quoted automatically: write placeholders bare (echo {{ name }}), not inside quotes." }),
      previewWrap,
    ),
    section(
      3, "Options",
      h("label", { class: "check", for: `${uid}-guard` }, guard, " Stop after 15 runs per ticket (loop guard)"),
      h("p", { class: "muted hint", id: `${uid}-guard-hint`, text: "Prevents rules from bouncing tickets back and forth forever. Untick to opt out." }),
    ),
    h(
      "div",
      { class: "arule-test", role: "group", "aria-label": "Test run" },
      h("h5", { class: "arule-sec-title", text: "Test run" }),
      h("p", { class: "muted hint", text: "Really runs the script on this machine (nothing is logged, no ticket is changed). Unsaved edits are used." }),
      h("div", { class: "row" }, pick, testBtn),
      res,
      out,
    ),
  );

  const card = h("div", { class: "arule", role: "group", "aria-label": ruleTitle(r) }, head, body);
  validate();
  updatePreview();
  apply();
  if (!body.hidden) grow();
  return {
    el: card,
    focusName: () => nameIn.focus(),
    focusToggle: () => toggle.focus(),
    update: () => (validate(), apply()),
    grow,
  };
}
