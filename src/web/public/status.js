// Automation status UI: dots, detail section, card indicator row.
import { h, clear } from "./dom.js";
import { absoluteTime, automationLabel, automationsText, relativeTime, runningText, summarizeAutomations } from "./logic.js";

/** Small status dot; `state` is done|running|failed|unknown. */
export function dot(state, label) {
  return h("span", { class: `sdot ${state}`, role: "img", title: label, "aria-label": label });
}

/** Fill `wrap` (a <div> inside the <dl>) with the Automations dt/dd; empty when no entries. */
export function fillAutomations(wrap, automations, now = new Date()) {
  clear(wrap);
  const sum = summarizeAutomations(automations);
  if (!sum.total) return;
  const rows = sum.list.map((i) => {
    const rel = relativeTime(i.at, now);
    const nonZero = i.exit !== null && i.exit !== "" && Number(i.exit) !== 0;
    return h(
      "li",
      { class: `auto-row ${i.state}` },
      dot(i.state, automationLabel(i, now)),
      h("span", { class: "auto-name mono", text: i.name }),
      h("span", { class: "auto-word", text: i.state }),
      rel ? h("span", { class: "muted", title: absoluteTime(i.at), text: rel }) : null,
      nonZero ? h("span", { class: "muted", text: `exit ${i.exit}` }) : null,
      i.error ? h("div", { class: "auto-error", text: i.error }) : null,
    );
  });
  wrap.append(h("dt", { text: "Automations" }), h("dd", {}, h("ul", { class: "auto-rows", "aria-label": automationsText(sum) }, rows)));
}

export function automationsWrap(automations) {
  const wrap = h("div", { class: "auto-wrap" });
  fillAutomations(wrap, automations);
  return wrap;
}

/** Card indicator {el, text}, or null when the ticket has no automation entries. */
export function cardIndicator(autos) {
  const sum = summarizeAutomations(autos);
  if (!sum.total) return null;
  const running = runningText(sum);
  const el = h(
    "div",
    { class: "card-autos" },
    h(
      "span",
      { class: "dots" },
      sum.worstFirst.map((i) => dot(i.state, automationLabel(i))),
    ),
    running ? h("span", { class: "running-names", title: running, text: running }) : null,
  );
  return { el, text: automationsText(sum) };
}
