// Process-tree helpers for killing a run *including* children that left its process group.
//
// A run is spawned as `bash -s` in its own process group, so signalling that group normally
// suffices. Anything the script starts that creates its own group escapes: agent harnesses and
// daemons spawn detached (`setsid`/`detached: true`), and `nohup`/`&` children can outlive the
// shell. Those are still *descendants* of the run while the shell lives, so the tree is collected
// before signalling and every pid and every distinct group is killed.
import { execFileSync } from "node:child_process";

export interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
}

/** All processes from `ps`; empty when ps is unavailable (kill falls back to the group only). */
export function listProcs(): Proc[] {
  try {
    const out = execFileSync("ps", ["-Ao", "pid=,ppid=,pgid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    });
    const procs: Proc[] = [];
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
      if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]) });
    }
    return procs;
  } catch {
    return [];
  }
}

export interface Tree {
  /** the roots given (existing only) */
  pids: number[];
  /** roots plus every descendant, deepest last */
  all: number[];
  /** process groups of the collected pids, excluding 0/1 */
  pgids: number[];
}

/**
 * Collect `roots` and all their descendants. `all` is ordered so children come before parents
 * (safe to signal in order). A pid in `reserved` and its *ancestors* are never included: the
 * reserved pids are the ones that must survive (this process), and signalling an ancestor would
 * take them down. Descendants of a reserved pid are fair game — that is exactly what a run is.
 */
export function collectTree(roots: number[], procs: Proc[], reserved: number[] = []): Tree {
  const byParent = new Map<number, number[]>();
  const known = new Set<number>();
  for (const p of procs) {
    known.add(p.pid);
    const list = byParent.get(p.ppid);
    if (list) list.push(p.pid);
    else byParent.set(p.ppid, [p.pid]);
  }
  const ppidOf = new Map(procs.map((p) => [p.pid, p.ppid]));
  const pgidOf = new Map(procs.map((p) => [p.pid, p.pgid]));

  // Protect the reserved pids and everything above them (their ancestors).
  const blocked = new Set<number>();
  for (const r of reserved) {
    let cur: number | undefined = r;
    while (cur !== undefined && cur > 1 && !blocked.has(cur)) {
      blocked.add(cur);
      cur = ppidOf.get(cur);
    }
    blocked.add(r);
  }

  const present = roots.filter((r) => known.has(r) && !blocked.has(r));
  const all: number[] = [];
  const seen = new Set<number>();
  const walk = (pid: number): void => {
    if (seen.has(pid) || blocked.has(pid)) return;
    seen.add(pid);
    for (const k of byParent.get(pid) ?? []) walk(k);
    all.push(pid); // post-order: children before their parent
  };
  for (const r of present) walk(r);

  const pgids = new Set<number>();
  for (const pid of all) {
    const g = pgidOf.get(pid);
    if (g !== undefined && g > 1) pgids.add(g);
  }
  return { pids: present, all, pgids: [...pgids] };
}

/** True when `pid` exists (signal 0 probe). */
export function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Send `sig` to a pid; false when it is gone or not ours. */
export function signalPid(pid: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

/** Send `sig` to a whole process group (never group 0/1); false when the group is gone. */
export function signalGroup(pgid: number, sig: NodeJS.Signals | 0): boolean {
  if (pgid <= 1) return false;
  try {
    process.kill(-pgid, sig);
    return true;
  } catch {
    return false;
  }
}

export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface KillTreeOptions {
  /** SIGTERM grace before SIGKILL (default 2000 ms) */
  graceMs?: number;
  /** how long to wait for the tree to disappear after SIGKILL (default 3000 ms) */
  waitMs?: number;
  /** pids (and their ancestors) that must never be signalled — e.g. this process */
  reserved?: number[];
  /** collect the tree fresh instead of using a snapshot taken at spawn time */
  procs?: Proc[];
  /** skip the SIGTERM phase and SIGKILL straight away (shutdown paths) */
  immediate?: boolean;
}

export interface KillTreeResult {
  /** roots that were alive when the kill started */
  pids: number[];
  /** every pid that was signalled */
  all: number[];
  /** groups that were signalled */
  pgids: number[];
  /** pids still alive at the end (should be empty) */
  survivors: number[];
}

/**
 * Terminate a process tree: SIGTERM every group and pid (children first), SIGKILL after `graceMs`
 * for whatever survives, and report anything still alive at the end. Never throws.
 */
export async function killTree(roots: number[], opts: KillTreeOptions = {}): Promise<KillTreeResult> {
  const graceMs = opts.graceMs ?? 2000;
  const waitMs = opts.waitMs ?? 3000;
  const reserved = [process.pid, ...(opts.reserved ?? [])];
  // Snapshot first: signalling the shell can orphan its children, after which the tree is unfindable.
  const tree = collectTree(roots, opts.procs ?? listProcs(), reserved);
  const { all, pgids } = tree;
  if (!all.length) return { pids: [], all: [], pgids: [], survivors: [] };

  const termAll = (): void => {
    if (opts.immediate) return;
    for (const pgid of pgids) signalGroup(pgid, "SIGTERM");
    for (const pid of all) signalPid(pid, "SIGTERM");
  };
  const killAll = (): void => {
    for (const pgid of pgids) signalGroup(pgid, "SIGKILL");
    for (const pid of all) signalPid(pid, "SIGKILL");
  };

  termAll();
  const t0 = Date.now();
  while (!opts.immediate && Date.now() - t0 < graceMs) {
    if (!all.some(exists)) return { pids: tree.pids, all, pgids, survivors: [] };
    await delay(50);
  }
  killAll();
  const t1 = Date.now();
  let survivors = all.filter(exists);
  while (survivors.length && Date.now() - t1 < waitMs) {
    await delay(50);
    survivors = survivors.filter(exists);
  }
  return { pids: tree.pids, all, pgids, survivors };
}
