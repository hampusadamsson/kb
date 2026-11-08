// Marks a run as killed by the user *from another process*.
//
// `kb automations kill` cannot tell the owner process how to record the death, so it drops a marker
// in `.kb/killed/<pid>` before signalling. The owner consumes it when the child exits and records
// `error: killed by user` instead of `killed by SIGTERM`, so CLI kills look like web UI kills.
// `.kb/` is gitignored and excluded from ticket scanning, so this is invisible to the board.
import fs from "node:fs";
import path from "node:path";

const dir = (root: string): string => path.join(root, ".kb", "killed");
const file = (root: string, pid: number): string => path.join(dir(root), String(pid));

/** True when `p` exists and is a directory. Cheap, synchronous, never throws. */
const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Guard against handing a pathological path to `fs.mkdirSync(…, { recursive: true })`.
 *
 * libuv's recursive mkdir walks up to the nearest existing ancestor and creates the missing chain
 * downwards. Under procfs that loop never terminates: a missing component under `/proc` reports
 * ENOENT on stat *and* returns ENOENT from mkdir, so libuv retries forever instead of failing. A
 * `markKilled("/proc/nope/does/not/exist")` therefore spun at ~96% CPU and never returned. That
 * would block a caller (and a whole test worker) indefinitely, which the "never throws" contract
 * cannot excuse — so refuse before entering the loop.
 *
 * The root is what is checked, not `dirname(dir)`: `<root>/.kb` legitimately does not exist yet on
 * the first kill of a board, and recursive mkdir is exactly what should create it. Verifying that
 * the root itself is an existing directory reduces every mkdir to the fixed `.kb` + `.kb/killed`
 * pair beneath a real directory, with no user-supplied depth left to walk.
 */
const rootUsable = (root: string): boolean => {
  if (!isDir(root)) return false;
  // A `.kb` that exists but is not a directory makes the write fail anyway; treat it as unusable.
  const kb = path.join(root, ".kb");
  return !fs.existsSync(kb) || isDir(kb);
};

/** Record that `pid` is being killed on purpose. Never throws. */
export function markKilled(root: string, pid: number): void {
  try {
    if (!rootUsable(root)) return;
    fs.mkdirSync(dir(root), { recursive: true });
    fs.writeFileSync(file(root, pid), String(Date.now()));
  } catch {
    // a failed marker only costs a nicer error message
  }
}

/** True (and removes the marker) when someone killed `pid` on purpose. Never throws. */
export function consumeKilled(root: string, pid: number): boolean {
  try {
    fs.unlinkSync(file(root, pid));
    return true;
  } catch {
    return false;
  }
}
