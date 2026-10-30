import { createKanban, type AutomationInfo, type AutomationLive } from "../../core/index.js";

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
  const fmt = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join("  ").trimEnd();
  return [fmt(head), ...rows.map(fmt)].join("\n");
}

const whenText = (a: AutomationInfo): string => {
  const w = a.when;
  const parts = [w.moved_to !== undefined ? `moved_to ${w.moved_to}` : `created_in ${w.created_in}`];
  if (w.labels?.length) parts.push(`labels ${w.labels.join(",")}`);
  for (const [k, v] of Object.entries(w.props ?? {})) parts.push(`${k}=${String(v)}`);
  return parts.join(" ");
};

const startedText = (l: AutomationLive): string => l.startedAt.replace("T", " ");

/** Output of `kb automations`. Read-only; never runs or writes anything. */
export function automations(cwd: string, o: AutomationsOpts = {}): string {
  const now = o.now ?? (() => new Date());
  const ov = createKanban({ dir: cwd, now }).automationOverview({ board: o.board });
  const text = o.format === "text";
  if (!o.all) {
    if (!text) return JSON.stringify({ live: ov.live, count: ov.live.length }, null, 2);
    if (!ov.live.length) return "No automations running.";
    return table(
      ["RULE", "BOARD", "TICKET", "ELAPSED", "STARTED"],
      ov.live.map((l) => [l.rule, l.board, `#${String(l.ticket.id)} ${l.ticket.name}`, fmtDuration(l.elapsedMs), startedText(l)]),
    );
  }
  const nowMs = now().getTime();
  if (!text) {
    const list = ov.rules.map((r) => ({
      name: r.name, board: r.board, enabled: r.enabled, guard: r.guard, timeout: r.timeout, when: r.when, run: r.run,
      running: r.running, lastRun: r.lastRun, counts: r.counts,
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
    ov.rules.map((r) => [r.name, r.board, r.enabled ? (r.guard ? "yes" : "yes (guard off)") : "no", whenText(r), fmtTimeout(r.timeout), String(r.running), last(r)]),
  );
}
