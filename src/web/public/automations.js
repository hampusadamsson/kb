// Settings → Automations: rule builder cards (per board), test run.
import { api } from "./api.js";
import { h, clear, chipInput } from "./dom.js";
import { AUTOMATION_VARS, describeTestRun, effectiveColumn, newRule, testBody } from "./logic.js";

const CONFIRM = "This really runs the script on this machine with a sample ticket.";

/** Distinct, non-blank column values of a board's column rows, with the rule's current column included. */
function columnOptions(cols, rule) {
  const vals = cols.map((r) => r.value.trim()).filter(Boolean);
  const cur = effectiveColumn(cols, rule.column);
  return vals.includes(cur) || !cur ? vals : [...vals, cur];
}

/**
 * Automations editor for one board. `rules` = form rules array (mutated), `cols` = the board's
 * column rows (live), `board` = () => board name for test runs, `onChange` = dirty callback.
 */
export function automationList({ rules, cols, board, onChange }) {
  const box = h("div", { class: "auto-list" });
  const draw = () => {
    clear(box);
    if (!rules.length) box.append(h("p", { class: "muted empty-auto", text: "No automations on this board yet." }));
    for (const r of rules) box.append(card(r));
    box.append(
      h("button", {
        type: "button",
        class: "btn small",
        text: "+ Add automation",
        onclick: () => {
          rules.push(newRule(cols));
          onChange();
          draw();
        },
      }),
    );
  };

  const card = (r) => {
    const out = h("pre", { class: "mono auto-out", hidden: true });
    const colSel = h("select", { "aria-label": "Column", onchange: (e) => ((r.column = e.target.value), onChange()) });
    const fillCols = () => {
      clear(colSel);
      // r.column may point at a renamed column: show its new name, keep the value in sync
      r.column = effectiveColumn(cols, r.column);
      for (const c of columnOptions(cols, r)) colSel.append(h("option", { value: c, text: c, selected: c === r.column }));
    };
    fillCols();
    colSel.addEventListener("focus", fillCols);
    colSel.addEventListener("mousedown", fillCols);

    const propRows = h("div", { class: "auto-props" });
    const drawProps = () => {
      clear(propRows);
      r.props.forEach((p, i) =>
        propRows.append(
          h(
            "div",
            { class: "row" },
            h("input", { type: "text", placeholder: "property", "aria-label": "Property key", value: p.key, oninput: (e) => ((p.key = e.target.value), onChange()) }),
            h("input", { type: "text", placeholder: "value (!x = not x)", "aria-label": "Property value", value: p.value, oninput: (e) => ((p.value = e.target.value), onChange()) }),
            h("button", { type: "button", class: "btn small danger", text: "×", "aria-label": "Remove property", onclick: () => (r.props.splice(i, 1), onChange(), drawProps()) }),
          ),
        ),
      );
      propRows.append(h("button", { type: "button", class: "btn small", text: "+ Add property", onclick: () => (r.props.push({ key: "", value: "" }), onChange(), drawProps()) }));
    };
    drawProps();

    const chips = chipInput({ label: "Labels (all required)", placeholder: "label, Enter", values: r.labels, onChange: (v) => ((r.labels = v), onChange()) });

    const test = h("button", {
      type: "button",
      class: "btn small",
      text: "Test run",
      onclick: async (e) => {
        if (!r.run.trim()) return show(out, "Script is empty.");
        if (!confirm(CONFIRM)) return;
        e.target.disabled = true;
        try {
          show(out, describeTestRun(await api.testAutomation(testBody(r, board()))));
        } catch (err) {
          show(out, err.message);
        } finally {
          e.target.disabled = false;
        }
      },
    });

    return h(
      "div",
      { class: "auto-card" },
      h(
        "div",
        { class: "row" },
        h("input", { type: "text", placeholder: "Rule name", "aria-label": "Rule name", value: r.name, oninput: (e) => ((r.name = e.target.value), onChange()) }),
        h("label", { class: "check" }, h("input", { type: "checkbox", "aria-label": "Enabled", checked: r.enabled, onchange: (e) => ((r.enabled = e.target.checked), onChange()) }), " enabled"),
        h("button", { type: "button", class: "btn small danger", text: "Remove", onclick: () => (rules.splice(rules.indexOf(r), 1), onChange(), draw()) }),
      ),
      h(
        "div",
        { class: "row guard-row" },
        h("label", { class: "check" }, h("input", { type: "checkbox", "aria-label": "Loop guard", checked: r.guard !== false, onchange: (e) => ((r.guard = e.target.checked), onChange()) }), " Stop after 15 runs per ticket (loop guard)"),
        h("span", { class: "muted hint", text: "Prevents rules from bouncing tickets back and forth forever. Uncheck to opt out." }),
      ),
      h(
        "div",
        { class: "row" },
        h(
          "select",
          { "aria-label": "Event", onchange: (e) => ((r.event = e.target.value), onChange()) },
          h("option", { value: "moved_to", text: "when moved to", selected: r.event === "moved_to" }),
          h("option", { value: "created_in", text: "when created in", selected: r.event === "created_in" }),
        ),
        colSel,
      ),
      h("div", { class: "field" }, h("span", { class: "lbl", text: "…and has labels" }), chips.el),
      h("div", { class: "field" }, h("span", { class: "lbl", text: "…and properties" }), propRows),
      h("textarea", { class: "mono auto-run", rows: 3, placeholder: "echo {{ id }} >> done.txt", "aria-label": "Script", value: r.run, oninput: (e) => ((r.run = e.target.value), onChange()) }),
      h("p", { class: "muted hint", text: `Variables: ${AUTOMATION_VARS.map((v) => `{{ ${v} }}`).join(" ")}. Values are shell-quoted automatically: write placeholders bare (echo {{ name }}), not in quotes.` }),
      h("div", { class: "row" }, test, h("span", { class: "muted", text: "Runs the script for real with a sample ticket." })),
      out,
    );
  };
  draw();
  return box;
}

function show(pre, text) {
  pre.textContent = text;
  pre.hidden = false;
}
