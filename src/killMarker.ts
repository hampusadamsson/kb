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

/** Record that `pid` is being killed on purpose. Never throws. */
export function markKilled(root: string, pid: number): void {
  try {
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
