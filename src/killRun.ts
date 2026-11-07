// Kill a running automation from *another* process (the CLI vs. a `kb web` server).
//
// The only handle that survives across processes is the pid stored in the ticket's `automations`
// frontmatter. Signalling a stale pid is the one dangerous operation here, so the pid is verified
// (alive, expected process group, shell command) before anything is sent.
import { execFileSync } from "node:child_process";
import os from "node:os";
import { consumeKilled, markKilled } from "./killMarker.js";
import { killTree, signalGroup, signalPid } from "./procTree.js";

export interface KillTarget {
  pid?: number;
  pgid?: number;
  host?: string;
  /** how long the run has been going according to the ticket; guards against pid reuse */
  elapsedMs?: number;
}

export type KillResult =
  | { ok: true; pid: number; pgid: number; /** every pid signalled, incl. escaped descendants */ all?: number[] }
  | { ok: false; reason: string };

const alive = (target: number): boolean => signalPid(target, 0);

/** True when a pid still exists (signal 0 probe). Cheap enough to run on every Live-tab request. */
export { alive as pidAlive };

/** `ps` view of a pid: process group and age in ms. Undefined when ps is unavailable or the pid is gone. */
function psInfo(pid: number): { pgid: number; ageMs: number } | undefined {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "pgid=,etime="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = /^(\d+)\s+(\S+)$/.exec(out);
    if (!m) return undefined;
    // etime: [[dd-]hh:]mm:ss (unknown layouts fall back to NaN → no age check)
    const parts = m[2].split(/[-:]/).map(Number);
    const [dd, hh, mm, ss] =
      parts.length === 4 ? parts : parts.length === 3 ? [0, ...parts] : parts.length === 2 ? [0, 0, ...parts] : [0, 0, 0, NaN];
    const known = [dd, hh, mm, ss].every((n) => Number.isFinite(n));
    const ageMs = known ? ((dd * 24 + hh) * 60 + mm) * 60_000 + ss * 1000 : NaN;
    return { pgid: Number(m[1]), ageMs };
  } catch {
    return undefined;
  }
}

export interface KillOptions {
  /** config dir; the kill marker is written under <root>/.kb/killed */
  root: string;
  /** how long SIGTERM gets before SIGKILL (default 2000 ms) */
  graceMs?: number;
  /** how long to watch for the process to die afterwards (default 3000 ms) */
  waitMs?: number;
  /** pids (and their descendants) never to signal, e.g. the caller when pids were recycled */
  reserved?: number[];
}

/**
 * Terminate one run and everything it spawned: verify, then SIGTERM/SIGKILL the whole process tree
 * (including children that moved to their own process group, e.g. agent harnesses and daemons).
 * Never throws; a refusal explains itself in `reason`.
 */
export async function killRun(t: KillTarget, opts: KillOptions): Promise<KillResult> {
  const graceMs = opts.graceMs ?? 2000;
  const waitMs = opts.waitMs ?? 3000;
  if (t.host && t.host !== os.hostname()) {
    return { ok: false, reason: `started on ${t.host} (this is ${os.hostname()}); cannot kill from here` };
  }
  const pid = t.pid;
  if (!pid) return { ok: false, reason: "no pid recorded (entry predates kill support, or the owner died)" };
  const info = psInfo(pid);
  if (!info && !alive(pid)) {
    return { ok: false, reason: `pid ${pid} is not reachable (gone, or owned by another user)` };
  }
  const pgid = t.pgid ?? pid;
  if (info) {
    if (info.pgid !== pgid) {
      return { ok: false, reason: `pid ${pid} is now in group ${info.pgid}, expected ${pgid} (pid reused)` };
    }
    // A recycled pid would belong to a much younger process than the run is long.
    // (The command name is not usable: `bash -s` execs its last command, so a run often looks like `sleep`.)
    if (t.elapsedMs !== undefined && Number.isFinite(info.ageMs)) {
      const slackMs = 60_000;
      if (info.ageMs + slackMs < t.elapsedMs) {
        return {
          ok: false,
          reason: `pid ${pid} has only existed ${Math.round(info.ageMs / 1000)}s but the run is ${Math.round(t.elapsedMs / 1000)}s old (pid reused); the entry is stale`,
        };
      }
    }
  }

  // Tell the owner to record this as a user kill rather than a SIGTERM crash. Written *before* the
  // signal on purpose: the owner sees the exit as soon as SIGTERM lands, long before killTree's
  // grace period is over, so a marker written afterwards would never be consumed. Every failure
  // path withdraws it again, so a failed attempt cannot relabel a later, unrelated death.
  markKilled(opts.root, pid);
  const fail = (reason: string): KillResult => {
    consumeKilled(opts.root, pid);
    return { ok: false, reason };
  };

  // Kill the tree, not just the group: children that called setsid()/spawned detached keep running
  // in their own group and would otherwise survive, leaving the agent loop going after a "kill".
  let r: Awaited<ReturnType<typeof killTree>>;
  try {
    r = await killTree([pid], { graceMs, waitMs, reserved: opts.reserved });
  } catch (e) {
    return fail(`cannot signal pid ${pid} (${(e as Error).message})`);
  }
  if (!r.all.length) return fail(`cannot signal pid ${pid} (permission denied?)`);
  if (r.survivors.length) return fail(`pid ${pid} survived SIGKILL (still running: ${r.survivors.join(", ")})`);
  // The run's own group is always reported so callers can show what was targeted.
  signalGroup(pgid, 0);
  return { ok: true, pid, pgid, all: r.all };
}
