// Pure helpers for the Settings → Live tab.

/** "m:ss" (or "h:mm:ss" from one hour) for a duration in ms. */
export function formatElapsed(ms) {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const pad = (n) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

/** elapsed / timeout clamped to 0..1 (0 when the timeout is unknown). */
export function progressFraction(elapsedMs, timeoutMs) {
  if (!(timeoutMs > 0) || !(elapsedMs > 0)) return 0;
  return Math.min(1, elapsedMs / timeoutMs);
}

/** True when the run has a timeout (timeoutMs null/0 = none). */
export const hasTimeout = (timeoutMs) => timeoutMs > 0;

/** Remaining time text: "mm:ss left", "timing out" or "no timeout". */
export function timeoutText(elapsedMs, timeoutMs) {
  if (!hasTimeout(timeoutMs)) return "no timeout";
  const left = timeoutMs - elapsedMs;
  return left > 0 ? `${formatElapsed(left)} left` : "timing out";
}

/** Newest first by startedAt (ties keep order). Does not mutate. */
export function sortRuns(runs) {
  return runs
    .map((r, i) => [r, i])
    .sort((a, b) => Date.parse(b[0].startedAt) - Date.parse(a[0].startedAt) || a[1] - b[1])
    .map(([r]) => r);
}

/** Display name of a run. */
export const runTitle = (r) => (r.kind === "test" ? "Test run" : r.rule || "Automation");

/** True when the run belongs to another process, so its output tail is unavailable. */
export const isExternal = (r) => r.external === true;

/** Accessible label of the Kill button. */
export const killLabel = (r) =>
  r.kind === "test" ? "Kill test run" : `Kill automation ${r.rule ?? ""} on #${r.ticketId ?? "?"}`.replace("  ", " ");

/** Confirm text before killing. */
export const killConfirm = (r) =>
  r.kind === "test"
    ? "Kill this test run? The process and its children are terminated."
    : `Kill automation "${r.rule}" on #${r.ticketId}? The process and its children are terminated; the ticket is marked failed.`;

/** Extra hint for runs started outside this server. */
export const externalNote = () => "Started by another process (kb CLI or an earlier kb web); its output is not captured here.";

/** Tab label with count. */
export const liveLabel = (n) => (n ? `Live (${n})` : "Live");

/** Polite announcement for a change between two run lists, or "". */
export function announce(prev, next) {
  const had = new Set(prev.map((r) => r.runId));
  const has = new Set(next.map((r) => r.runId));
  const started = next.filter((r) => !had.has(r.runId));
  const ended = prev.filter((r) => !has.has(r.runId));
  if (started.length === 1 && !ended.length) return `${runTitle(started[0])} started`;
  if (ended.length === 1 && !started.length) return `${runTitle(ended[0])} finished`;
  if (started.length || ended.length) return `${started.length} started, ${ended.length} finished`;
  return "";
}
