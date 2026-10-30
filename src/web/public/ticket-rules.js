// Settings → Config: "What is a ticket?" editor (tickets rules) with a live preview.
import { api } from "./api.js";
import { h, clear, chipInput, debounce } from "./dom.js";
import { checkTickets, newTicketRule, noTicketsWarning, presetRule, PRESETS, previewText, summarizeRule, ticketsToConfig, checkRule } from "./ticket-rules-logic.js";

const KINDS = {
  include: { title: "Also treat as tickets (include)", add: "+ Add include rule", empty: "No include rules." },
  exclude: { title: "Never treat as tickets (exclude)", add: "+ Add exclude rule", empty: "No exclude rules." },
};

let seq = 0; // preview request counter; older responses are ignored

/**
 * `t` = form.tickets (mutated), `onChange` = dirty callback, `changed` = () => differs from saved,
 * `error` = () => server/form error text to show near the section.
 */
export function ticketRulesSection({ t, onChange, changed, error }) {
  const warn = h("p", { class: "notice tr-warn", role: "status" });
  const errBox = h("p", { class: "form-error", role: "alert" });
  const pv = h("div", { class: "tr-preview", "aria-live": "polite" });
  const lists = h("div", { class: "tr-lists" });

  const showError = () => {
    const e = error?.() ?? "";
    const mine = /^invalid tickets|^Ticket rules:/.test(e);
    errBox.textContent = mine ? e : "";
    errBox.hidden = !mine;
  };
  const showWarn = () => {
    const w = noTicketsWarning(t);
    warn.textContent = w;
    warn.hidden = !w;
  };

  const runPreview = async () => {
    const mine = ++seq;
    const problem = checkTickets(t);
    if (problem) return show(pv, "error", problem);
    show(pv, "loading", "Checking which files are affected…");
    try {
      const r = await api.previewTickets(ticketsToConfig(t));
      if (mine !== seq) return;
      showResult(pv, r);
    } catch (e) {
      if (mine === seq) show(pv, "error", `Preview failed: ${e.message}`);
    }
  };
  const schedule = debounce(runPreview, 400);
  const edited = () => {
    onChange();
    showWarn();
    showError();
    seq++; // invalidate in-flight responses
    if (!checkTickets(t)) show(pv, "loading", "Checking which files are affected…");
    else show(pv, "error", checkTickets(t));
    schedule();
  };

  const draw = (focus) => {
    clear(lists);
    for (const kind of ["include", "exclude"]) lists.append(listBox(kind, t[kind], edited, draw));
    if (focus) focus();
  };

  const baseline = h(
    "label",
    { class: "check tr-baseline" },
    h("input", { type: "checkbox", id: "tickets-baseline", checked: t.baseline, onchange: (e) => ((t.baseline = e.target.checked), edited()) }),
    " Files with ",
    h("code", { text: "type: ticket" }),
    " are tickets (baseline)",
  );

  draw();
  showWarn();
  showError();
  if (changed?.()) runPreview();
  return h(
    "section",
    { id: "tickets-section", class: "tickets", "aria-label": "What is a ticket?" },
    h("h3", { class: "section-title", text: "What is a ticket?" }),
    baseline,
    warn,
    lists,
    errBox,
    pv,
  );
}

function show(box, kind, text) {
  clear(box);
  box.className = `tr-preview ${kind}`;
  box.append(h("p", { text }));
}

function showResult(box, r) {
  clear(box);
  box.className = "tr-preview ok";
  box.append(h("p", { class: "tr-count", text: previewText(r) }));
  const lists = [
    ["Become tickets", r.newlyIncluded ?? [], r.gained ?? 0],
    ["Stop being tickets", r.newlyExcluded ?? [], r.lost ?? 0],
  ];
  for (const [title, paths, n] of lists) {
    if (!n) continue;
    const shown = paths.slice(0, 50);
    box.append(
      h(
        "details",
        { class: "tr-details" },
        h("summary", { text: `${title} (${n})` }),
        h("ul", { class: "mono" }, shown.map((p) => h("li", { text: p }))),
        n > shown.length ? h("p", { class: "muted", text: `… and ${n - shown.length} more` }) : null,
      ),
    );
  }
}

function listBox(kind, rules, edited, redraw) {
  const k = KINDS[kind];
  const addBtn = h("button", { type: "button", class: "btn small", text: k.add, onclick: () => add(newTicketRule()) });
  const add = (rule) => {
    rules.push(rule);
    edited();
    redraw(() => document.querySelector(`[data-tr-list="${kind}"] .tr-card:last-of-type input[data-tr="glob"]`)?.focus());
  };
  const quick = h(
    "div",
    { class: "tr-quick", role: "group", "aria-label": `Quick add ${kind} rule` },
    h("span", { class: "muted", text: "Quick add:" }),
    PRESETS[kind].map((p) => h("button", { type: "button", class: "btn small", text: p.label, onclick: () => add(presetRule(kind, p.id)) })),
  );
  const cards = h("div", { class: "tr-cards", "data-tr-list": kind });
  if (!rules.length) cards.append(h("p", { class: "muted", text: k.empty }));
  rules.forEach((r, i) =>
    cards.append(
      card(kind, r, i, edited, () => {
        rules.splice(i, 1);
        edited();
        redraw(() => document.querySelector(`[data-tr-list="${kind}"]`)?.parentElement?.querySelector("button.tr-add")?.focus());
      }),
    ),
  );
  addBtn.classList.add("tr-add");
  return h("div", { class: "tr-list", "data-tr-list": kind }, h("h4", { text: k.title }), cards, h("div", { class: "row tr-actions" }, addBtn, quick));
}

function card(kind, r, i, edited, remove) {
  const title = `${kind} rule ${i + 1}`;
  const summary = h("p", { class: "muted tr-summary" });
  const msg = h("p", { class: "form-error tr-msg", role: "alert" });
  const refresh = () => {
    summary.textContent = summarizeRule(r);
    const p = checkRule(r);
    msg.textContent = p ? `This rule ${p}` : "";
    msg.hidden = !p;
  };
  const change = () => (refresh(), edited());
  const text = (label, key, placeholder, help) =>
    h(
      "div",
      { class: "field" },
      h("span", { class: "lbl", text: label }),
      h("input", { type: "text", "data-tr": key, value: r[key], placeholder, "aria-label": `${label} (${title})`, oninput: (e) => ((r[key] = e.target.value), change()) }),
      help ? h("span", { class: "muted hint", text: help }) : null,
    );

  const propRows = h("div", { class: "auto-props" });
  const drawProps = (focusLast) => {
    clear(propRows);
    r.props.forEach((p, j) =>
      propRows.append(
        h(
          "div",
          { class: "row" },
          h("input", { type: "text", placeholder: "property", "aria-label": `Property key (${title})`, value: p.key, oninput: (e) => ((p.key = e.target.value), change()) }),
          h("input", { type: "text", placeholder: "value (!x = not x)", "aria-label": `Property value (${title})`, value: p.value, oninput: (e) => ((p.value = e.target.value), change()) }),
          h("button", { type: "button", class: "btn small danger", text: "×", "aria-label": `Remove property (${title})`, onclick: () => (r.props.splice(j, 1), change(), drawProps()) }),
        ),
      ),
    );
    propRows.append(h("button", { type: "button", class: "btn small", text: "+ Add property", onclick: () => (r.props.push({ key: "", value: "" }), change(), drawProps(true)) }));
    if (focusLast) propRows.querySelectorAll("input")[r.props.length * 2 - 2]?.focus();
  };
  drawProps();

  const chips = chipInput({ label: `Has property (${title})`, placeholder: "key, Enter (!key = must not exist)", values: r.has, onChange: (v) => ((r.has = v), change()) });
  refresh();

  return h(
    "div",
    { class: "auto-card tr-card", role: "group", "aria-label": title },
    h(
      "div",
      { class: "row" },
      h("input", { type: "text", "data-tr": "name", placeholder: "Rule name (optional)", "aria-label": `Rule name (${title})`, value: r.name, oninput: (e) => ((r.name = e.target.value), change()) }),
      h("button", { type: "button", class: "btn small danger", text: "Remove", "aria-label": `Remove ${title}`, onclick: remove }),
    ),
    text("Folder / path glob", "glob", "tasks/**/*.md", "relative to this folder"),
    text("Filename prefix", "prefix", "T-"),
    h("div", { class: "field" }, h("span", { class: "lbl", text: "Properties (all must match)" }), propRows),
    h("div", { class: "field" }, h("span", { class: "lbl", text: "Has property" }), chips.el),
    summary,
    msg,
  );
}
