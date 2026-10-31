import { createKanban, idKey, type AutomationInfo, type AutomationLive } from "../../core/index.js";
import { killRun, pidAlive } from "../../killRun.js";

export interface AutomationsOpts {
  board?: string;
  all?: boolean;
  format?: "json" | "text";
  /** injectable clock (tests) */
  now?: () => Date;
}

/** "45s", "3m", "2h", "5d". */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Exact timeout label: "30s", "90s", "5m", "2h". */
export function fmtTimeout(seconds: number): string {
  if (!seconds) return "-";
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function table(head: string[], rows: string[][]): string {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r: string[]) =>
    r
      .map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i])))
      .join("  ")
      .trimEnd();
  return [fmt(head), ...rows.map(fmt)].join("\n");
}

const whenText = (a: AutomationInfo): string => {
  const w = a.when;
  const parts = [w.moved_to !== undefined ? `moved_to ${w.moved_to}` : `created_in ${w.created_in}`];
  if (w.labels?.length) parts.push(`labels ${w.labels.join(",")}`);
  for (const [k, v] of Object.entries(w.props ?? {})) parts.push(`${k}=${String(v)}`);
  return parts.join(" ");
};

export interface KillOpts {
  /** only this board */
  board?: string;
  /** ticket id (exact or numeric) */
  ticket?: string;
  /** rule name */
  rule?: string;
  /** select every running automation (required when no -t/-r is given) */
  all?: boolean;
  format?: "json" | "text";
  /** list what would be killed, signal nothing */
  dryRun?: boolean;
  /** SIGTERM → SIGKILL grace, ms */
  graceMs?: number;
  /** how long to wait for the process to disappear, ms */
  waitMs?: number;
  /** injectable clock (tests) */
  now?: () => Date;
}

export interface KillReport {
  killed: KillOutcome[];
  failed: KillOutcome[];
  dryRun: boolean;
  out: string;
}

export interface KillOutcome {
  rule: string;
  board: string;
  ticket: { id: unknown; name: string };
  pid?: number;
  startedAt: string;
  ok: boolean;
  reason?: string;
}

/**
 * `kb automations kill`: terminate running automations from any process.
 * Selectors combine (AND): -t/--ticket, -r/--rule, -b/--board. `--all` is required to allow a
 * multi-target kill, so a bare `kb automations kill` can never take down everything by accident.
 */
export async function killAutomations(cwd: string, o: KillOpts = {}): Promise<KillReport> {
  const now = o.now ?? (() => new Date());
  const ov = createKanban({ dir: cwd, now, isAlive: pidAlive }).automationOverview({ board: o.board });
  const hasSelector = o.ticket !== undefined || o.rule !== undefined;
  if (!hasSelector && !o.all) {
    throw new Error("nothing selected: pass -t/--ticket <id>, -r/--rule <name>, or -a/--all");
  }
  let targets: AutomationLive[] = ov.live;
  if (o.ticket !== undefined) {
    const want = idKey(o.ticket);
    targets = targets.filter((l) => idKey(l.ticket.id) === want);
  }
  if (o.rule !== undefined) targets = targets.filter((l) => l.rule === o.rule);
  if (!targets.length) {
    const what = [o.ticket !== undefined ? `ticket ${o.ticket}` : "", o.rule !== undefined ? `rule "${o.rule}"` : ""]
      .filter(Boolean)
      .join(" / ");
    throw new Error(what ? `no automation running for ${what}` : "no automations running");
  }
  if (targets.length > 1 && !o.all) {
    const list = targets.map((l) => `  #${String(l.ticket.id)} ${l.rule}`).join("\n");
    throw new Error(`${targets.length} automations match; narrow with -t/-r or pass -a/--all to kill them all:\n${list}`);
  }

  const outcome = (l: AutomationLive, ok: boolean, reason?: string): KillOutcome => ({
    rule: l.rule,
    board: l.board,
    ticket: { id: l.ticket.id, name: l.ticket.name },
    ...(l.pid !== undefined ? { pid: l.pid } : {}),
    startedAt: l.startedAt,
    ok,
    ...(reason ? { reason } : {}),
  });
  const text = o.format === "text";

  if (o.dryRun) {
    const list = targets.map((l) => outcome(l, true));
    const out = text
      ? `would kill ${list.length} automation${list.length === 1 ? "" : "s"}:\n` +
        list.map((k) => `  ${k.rule} on #${String(k.ticket.id)} ${k.ticket.name}${k.pid ? ` (pid ${k.pid})` : " (no pid)"}`).join("\n")
      : JSON.stringify({ dryRun: true, killed: list, failed: [], count: list.length }, null, 2);
    return { killed: list, failed: [], dryRun: true, out };
  }

  const killed: KillOutcome[] = [];
  const failed: KillOutcome[] = [];
  for (const l of targets) {
    const r = await killRun(
      { pid: l.pid, pgid: l.pgid, host: l.host, elapsedMs: l.elapsedMs },
      { root: cwd, graceMs: o.graceMs, waitMs: o.waitMs },
    );
    if (r.ok) killed.push(outcome(l, true));
    else failed.push(outcome(l, false, r.reason));
  }
  const out = text
    ? [
        ...killed.map((k) => `killed ${k.rule} on #${String(k.ticket.id)} ${k.ticket.name}${k.pid ? ` (pid ${k.pid})` : ""}`),
        ...failed.map((k) => `cannot kill ${k.rule} on #${String(k.ticket.id)} ${k.ticket.name}: ${k.reason}`),
      ].join("\n")
    : JSON.stringify({ killed, failed, count: killed.length }, null, 2);
  return { killed, failed, dryRun: false, out };
}

const startedText = (l: AutomationLive): string => l.startedAt.replace("T", " ");

/** Output of `kb automations`. Read-only; never runs or writes anything. */
export function automations(cwd: string, o: AutomationsOpts = {}): string {
  const now = o.now ?? (() => new Date());
  const ov = createKanban({ dir: cwd, now, isAlive: pidAlive }).automationOverview({ board: o.board });
  const text = o.format === "text";
  if (!o.all) {
    if (!text) return JSON.stringify({ live: ov.live, count: ov.live.length }, null, 2);
    if (!ov.live.length) return "No automations running.";
    return table(
      ["RULE", "BOARD", "TICKET", "ELAPSED", "STARTED", "PID"],
      ov.live.map((l) => [
        l.rule,
        l.board,
        `#${String(l.ticket.id)} ${l.ticket.name}`,
        fmtDuration(l.elapsedMs),
        startedText(l),
        l.pid !== undefined ? String(l.pid) : "-",
      ]),
    );
  }
  const nowMs = now().getTime();
  if (!text) {
    const list = ov.rules.map((r) => ({
      name: r.name,
      board: r.board,
      enabled: r.enabled,
      guard: r.guard,
      timeout: r.timeout,
      when: r.when,
      run: r.run,
      running: r.running,
      lastRun: r.lastRun,
      counts: r.counts,
    }));
    return JSON.stringify({ automations: list, count: list.length }, null, 2);
  }
  if (!ov.rules.length) return "No automations configured.\nsee the README (Automations)";
  const last = (r: AutomationInfo): string => {
    if (!r.lastRun) return "-";
    const ms = new Date(r.lastRun.at).getTime();
    const ago = Number.isNaN(ms) ? "" : ` ${fmtDuration(nowMs - ms)} ago`;
    return `${r.lastRun.status}${ago} #${String(r.lastRun.ticketId)}`;
  };
  return table(
    ["NAME", "BOARD", "ON", "WHEN", "TIMEOUT", "RUNNING", "LAST"],
    ov.rules.map((r) => [
      r.name,
      r.board,
      r.enabled ? (r.guard ? "yes" : "yes (guard off)") : "no",
      whenText(r),
      fmtTimeout(r.timeout),
      String(r.running),
      last(r),
    ]),
  );
}
