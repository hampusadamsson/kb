// Settings → Live: automation runs currently in progress, with elapsed time, output tail and Kill.
import { api } from "./api.js";
import { h, clear } from "./dom.js";
import { absoluteTime, relativeTime } from "./logs-logic.js";
import {
  announce,
  externalNote,
  formatElapsed,
  hasTimeout,
  isExternal,
  killConfirm,
  killLabel,
  progressFraction,
  runTitle,
  sortRuns,
  timeoutText,
} from "./live-logic.js";

let ctx = { openTicket: async () => {}, onChange: () => {} };
let runs = [];
let disabled = false;
let error = "";
let fetchedAt = Date.now(); // client time of the last fetch; elapsed = server elapsedMs + (now - fetchedAt)
let seq = 0;
let st = null; // mount state
let tick = null;
let poll = null;
const killing = new Set();
const killErrors = new Map();
const expanded = new Set();
const missing = new Set();

export function configure(c) {
  ctx = { ...ctx, ...c };
}

export const count = () => runs.length;
export const isMounted = () => Boolean(st && document.body.contains(st.root));

const elapsed = (r) => r.elapsedMs + (Date.now() - fetchedAt);

/** Fetch the run list (SSE `runs`, polling, boot). */
export async function refresh() {
  const my = ++seq;
  try {
    const r = await api.automationRuns();
    if (my !== seq) return;
    const next = sortRuns(r.runs ?? []);
    const said = announce(runs, next);
    runs = next;
    disabled = Boolean(r.disabled);
    error = "";
    fetchedAt = Date.now();
    for (const id of [...killing]) if (!runs.some((x) => x.runId === id)) killing.delete(id);
    if (said && st?.live) st.live.textContent = said;
  } catch (e) {
    if (my !== seq) return;
    error = e.message;
  }
  ctx.onChange();
  if (sig() !== drawn) draw();
}

export function mount(panel) {
  unmount();
  st = { root: panel, live: h("p", { class: "sr-only", role: "status", "aria-live": "polite" }), body: h("div", { class: "live-body" }) };
  panel.append(st.live, st.body);
  draw();
  refresh();
  tick = setInterval(updateTimes, 1000);
  poll = setInterval(refresh, 2000);
}

export function unmount() {
  clearInterval(tick);
  clearInterval(poll);
  tick = poll = null;
  st = null;
  drawn = "";
}

function updateTimes() {
  if (!isMounted()) return unmount();
  for (const r of runs) {
    const row = st.root.querySelector(`[data-run="${CSS.escape(r.runId)}"]`);
    if (!row) continue;
    const e = elapsed(r);
    row.querySelector(".live-elapsed").textContent = formatElapsed(e);
    row.querySelector(".live-left").textContent = timeoutText(e, r.timeoutMs);
    const bar = row.querySelector(".live-bar > span");
    if (bar) bar.style.width = `${Math.round(progressFraction(e, r.timeoutMs) * 100)}%`;
  }
}

async function kill(r) {
  if (!window.confirm(killConfirm(r))) return;
  killing.add(r.runId);
  killErrors.delete(r.runId);
  draw();
  try {
    await api.killRun(r.runId);
  } catch (e) {
    killing.delete(r.runId);
    if (e.code === "not-found") killErrors.set(r.runId, "Already finished.");
    else killErrors.set(r.runId, e.message);
    draw();
  }
  refresh();
}

function ticketLink(r) {
  if (!r.ticketId) return h("span", { class: "muted", text: "—" });
  const label = `#${r.ticketId}${r.ticketName ? " " + r.ticketName : ""}`;
  if (missing.has(r.ticketId)) return h("span", { class: "muted", title: "Ticket no longer exists", text: label });
  return h("button", {
    type: "button",
    class: "link-btn",
    text: label,
    title: "Open ticket",
    onclick: async () => {
      try {
        await ctx.openTicket(r.ticketId);
      } catch {
        missing.add(r.ticketId);
        draw();
      }
    },
  });
}

function bar(e, r) {
  const s = h("span");
  s.style.width = `${Math.round(progressFraction(e, r.timeoutMs) * 100)}%`; // CSSOM: allowed by the CSP
  return s;
}

const sig = () =>
  JSON.stringify([
    disabled,
    error,
    runs.map((r) => [r.runId, expanded.has(r.runId) ? r.output : 0]),
    [...killing],
    [...killErrors],
    [...missing],
  ]);
let drawn = "";

function runRow(r) {
  const e = elapsed(r);
  const open = expanded.has(r.runId);
  const oid = `live-out-${r.runId}`;
  const isKilling = killing.has(r.runId);
  const external = isExternal(r);
  return h(
    "li",
    { class: "live-row", "data-run": r.runId },
    h(
      "div",
      { class: "live-head" },
      h("span", { class: "sdot running", title: "Running", "aria-hidden": "true" }),
      h("strong", { class: "live-title", text: runTitle(r) }),
      r.board ? h("span", { class: "pill", text: r.board }) : null,
      ticketLink(r),
      external ? h("span", { class: "pill", title: externalNote(), text: "other process" }) : null,
      h("span", { class: "spacer" }),
      h("button", {
        type: "button",
        class: "btn small danger",
        text: isKilling ? "Killing…" : "Kill",
        disabled: isKilling,
        "aria-label": killLabel(r),
        onclick: () => kill(r),
      }),
    ),
    h(
      "div",
      { class: "live-meta muted" },
      h("span", { title: absoluteTime(r.startedAt), text: `started ${relativeTime(r.startedAt) || r.startedAt}` }),
      h("span", { class: "mono live-elapsed", title: "Elapsed", text: formatElapsed(e) }),
      hasTimeout(r.timeoutMs)
        ? h("span", { class: "live-bar", title: `Timeout ${formatElapsed(r.timeoutMs)}`, role: "presentation" }, bar(e, r))
        : null,
      h("span", { class: "mono live-left", text: timeoutText(e, r.timeoutMs) }),
    ),
    h("div", { class: "mono live-cmd", title: r.command, text: r.command }),
    killErrors.has(r.runId) ? h("p", { class: "form-error", role: "alert", text: killErrors.get(r.runId) }) : null,
    // Output only exists for runs this server started; hide the toggle rather than show an empty pane.
    external
      ? h("p", { class: "muted live-ext-note", text: externalNote() })
      : [
          h("button", {
            type: "button",
            class: "link-btn live-toggle",
            "aria-expanded": String(open),
            "aria-controls": oid,
            text: open ? "Hide output" : "Show output",
            onclick: () => {
              if (open) expanded.delete(r.runId);
              else expanded.add(r.runId);
              draw();
            },
          }),
          open
            ? h("pre", {
                class: "mono auto-out live-out",
                id: oid,
                tabIndex: 0,
                "aria-label": "Latest output",
                text: r.output || "(no output yet)",
              })
            : null,
        ],
  );
}

function draw() {
  if (!st) return;
  if (!isMounted()) return unmount();
  const keep = st.root.scrollTop;
  drawn = sig();
  clear(st.body);
  if (error) st.body.append(h("p", { class: "form-error", role: "alert", text: error }));
  if (disabled) st.body.append(h("p", { class: "muted", text: "Automations are disabled (--no-automation)." }));
  else if (!runs.length && !error)
    st.body.append(
      h("p", { class: "muted", text: "No automations are running. Runs appear here while they execute; finished runs are in Logs." }),
    );
  else if (runs.length) st.body.append(h("ul", { class: "live-list", "aria-label": "Running automations" }, runs.map(runRow)));
  st.root.scrollTop = keep;
}
