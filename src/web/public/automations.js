// Settings → Automations: board switcher, toolbar, rule cards, empty state with starters, delete + undo.
import { api } from "./api.js";
import { h, clear } from "./dom.js";
import { newRule } from "./logic.js";
import { STARTERS, duplicateRule, filterRules, invalidCount, lastRuns, ruleCount, ruleTitle, starterRule } from "./automation-logic.js";
import { ruleCard } from "./automation-rule.js";

const open = new WeakMap(); // rule → expanded (survives redraws)
let selected = 0; // selected board index (survives settings re-renders)
const FILTER_MIN = 6;

/**
 * Automations tab content. boards = [{ name(), rules, cols, test() }] (default board first; rules/cols are
 * the live form arrays). onChange = dirty callback.
 */
export function automationsTab({ boards, onChange }) {
  if (selected >= boards.length) selected = 0;
  const root = h("div", { class: "autos" });
  const draw = () => {
    clear(root);
    root.append(intro());
    if (boards.length > 1) root.append(switcher());
    root.append(boardView(boards[selected]));
  };

  const switcher = () =>
    h(
      "div",
      { class: "autos-boards", role: "group", "aria-label": "Board" },
      boards.map((b, i) => {
        const bad = invalidCount(b.rules, b.cols);
        return h(
          "button",
          {
            type: "button",
            class: "btn autos-board",
            "aria-pressed": String(i === selected),
            onclick: () => ((selected = i), draw(), root.querySelector(".autos-board[aria-pressed='true']")?.focus()),
          },
          h("span", { text: `${b.name()}${i === 0 ? " (default)" : ""}` }),
          h("span", { class: "autos-count", text: String(b.rules.length), "aria-label": ruleCount(b.rules.length) }),
          bad ? h("span", { class: "arule-mark", title: "Has automations that need attention", "aria-label": "needs attention", text: "!" }) : null,
        );
      }),
    );

  const boardView = (b) => {
    const view = h("div", { class: "autos-board-view" });
    const listBox = h("div", { class: "auto-list" });
    const undoBox = h("div", { class: "autos-undo", role: "status", "aria-live": "polite" });
    let q = "";
    let tickets = [];
    let runs = new Map();
    let runsKnown = false;
    let cards = new Map();
    let undoTimer;

    api
      .board(`board=${encodeURIComponent(b.test())}`)
      .then((d) => {
        const bd = d.boards?.[0];
        tickets = bd ? [...bd.unsorted, ...bd.columns.flatMap((c) => c.tickets)] : [];
        runs = lastRuns(tickets);
        runsKnown = true;
        if (view.isConnected) drawList();
      })
      .catch(() => {});

    const ctx = {
      rules: b.rules,
      cols: b.cols,
      board: b.test,
      tickets: () => tickets,
      runOf: (r) => runs.get(r.name.trim()) ?? null,
      runsKnown: () => runsKnown,
      isOpen: (r, invalid) => open.get(r) ?? !!invalid,
      setOpen: (r, on) => open.set(r, on),
      onChange: () => (onChange(), refreshBar()),
      onDuplicate: (r) => {
        const copy = duplicateRule(r, b.rules);
        b.rules.splice(b.rules.indexOf(r) + 1, 0, copy);
        add(copy, true);
      },
      onDelete: (r) => {
        const i = b.rules.indexOf(r);
        b.rules.splice(i, 1);
        onChange();
        drawList();
        showUndo(r, i);
        (listBox.querySelector(".arule-toggle") ?? view.querySelector(".autos-add"))?.focus();
      },
    };

    const showUndo = (r, i) => {
      clear(undoBox);
      clearTimeout(undoTimer);
      undoBox.append(
        h("span", { text: `Deleted “${ruleTitle(r)}”. ` }),
        h("button", {
          type: "button",
          class: "btn small",
          text: "Undo",
          onclick: () => {
            clearTimeout(undoTimer);
            clear(undoBox);
            b.rules.splice(Math.min(i, b.rules.length), 0, r);
            onChange();
            drawList();
            cards.get(r)?.focusToggle();
          },
        }),
      );
      undoTimer = setTimeout(() => clear(undoBox), 12000);
    };

    const add = (r, focus) => {
      if (!b.rules.includes(r)) b.rules.push(r);
      open.set(r, true);
      q = "";
      onChange();
      drawAll();
      if (focus) cards.get(r)?.focusName();
    };

    const addBtn = h("button", { type: "button", class: "btn primary autos-add", text: "Add automation", onclick: () => add(newRule(b.cols), true) });
    const search = h("input", {
      type: "search", class: "autos-search", placeholder: "Filter automations…", "aria-label": "Filter automations",
      oninput: (e) => ((q = e.target.value), drawList()),
    });
    const bar = h("div", { class: "autos-bar" }, h("div", { class: "autos-bar-info" }), search, addBtn);
    const refreshBar = () => {
      const info = bar.firstChild;
      const bad = invalidCount(b.rules, b.cols);
      info.textContent = `${b.name()}: ${ruleCount(b.rules.length)}${bad ? ` · ${bad} need${bad === 1 ? "s" : ""} attention` : ""}`;
      bar.hidden = !b.rules.length;
      search.hidden = b.rules.length < FILTER_MIN;
    };

    const empty = () =>
      h(
        "div",
        { class: "autos-empty" },
        h("h4", { text: `No automations on ${b.name()} yet` }),
        h("p", { class: "muted", text: "An automation runs a shell script when a ticket is moved to a column or created in one. Start from a template or build your own." }),
        h(
          "div",
          { class: "autos-starters" },
          STARTERS.map((s) =>
            h("button", { type: "button", class: "autos-starter", onclick: () => add(starterRule(s, b.cols, b.rules, newRule), true) }, h("strong", { text: s.title }), h("span", { class: "muted", text: s.detail })),
          ),
        ),
        h("button", { type: "button", class: "btn primary", text: "Add automation", onclick: () => add(newRule(b.cols), true) }),
      );

    function drawList() {
      clear(listBox);
      cards = new Map();
      refreshBar();
      if (!b.rules.length) return void listBox.append(empty());
      const shown = filterRules(b.rules, q);
      if (!shown.length) listBox.append(h("p", { class: "muted", text: `No automations match “${q}”.` }));
      for (const r of shown) {
        const c = ruleCard(r, ctx);
        cards.set(r, c);
        listBox.append(c.el);
      }
    }
    function drawAll() {
      drawList();
    }

    view.append(
      h("p", { class: "muted hint", text: "Rules apply only to this board; they are not inherited from other boards. Order does not matter: every matching rule runs." }),
      bar,
      undoBox,
      listBox,
    );
    drawList();
    return view;
  };

  const intro = () =>
    h(
      "details",
      { class: "tr-details autos-help" },
      h("summary", { text: "How automations work" }),
      h("p", { class: "muted", text: "When a ticket is moved to (or created in) a column and matches the optional labels and properties, the script runs on this machine in the folder of kanban.yaml. Placeholders such as {{ id }} are replaced by shell-quoted ticket values. The last run is shown on each rule; full history is in the Logs tab." }),
      h("p", { class: "muted", text: "Changes are saved with Save config below. Test run executes the script for real. A runaway script can be stopped from the Live tab." }),
    );

  draw();
  return root;
}
