// Real automation runner (bash). Lives outside src/core: core only knows the AutomationRunner interface.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { KILLED_BY_USER, type AutomationRunner, type RunResult } from "./core/automation.js";
import { isoWithOffset } from "./core/events.js";
import type { LiveHandle, LiveRuns } from "./liveRuns.js";
import { killTree } from "./procTree.js";

const CAP = 64 * 1024;
const MARKER = "\n[output truncated]";

class Capture {
  private chunks: Buffer[] = [];
  private size = 0;
  private cut = false;
  push(c: Buffer): void {
    if (this.size >= CAP) {
      this.cut = true;
      return;
    }
    const room = CAP - this.size;
    if (c.length > room) {
      this.chunks.push(c.subarray(0, room));
      this.size = CAP;
      this.cut = true;
    } else {
      this.chunks.push(c);
      this.size += c.length;
    }
  }
  text(): string {
    return Buffer.concat(this.chunks).toString("utf8") + (this.cut ? MARKER : "");
  }
}

const GRACE_MS = 100;

/**
 * Kill a run and its whole tree. The group alone is not enough: a script that spawns an agent
 * harness or daemon detached puts it in another group, where it outlives the shell and keeps going.
 */
function killGroup(child: ChildProcess): void {
  const pid = child.pid;
  // Fire-and-forget: signals are sent synchronously by killTree before its first await.
  void killTree(pid ? [pid] : [], { immediate: true, waitMs: 0 });
  if (!pid) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

const TERM_GRACE_MS = 2000;
/** Upper bound on how long the timeout path waits for its kill before reporting anyway. */
const KILL_CAP_MS = TERM_GRACE_MS + 5000;

export function createShellRunner(opts: { timeoutMs?: number; registry?: LiveRuns } = {}): AutomationRunner & { killAll(): void } {
  /** global override (tests); normally the timeout comes per run from the rule */
  const defaultTimeoutMs = opts.timeoutMs;
  const registry = opts.registry;
  const live = new Set<ChildProcess>();
  return {
    killAll() {
      for (const c of live) killGroup(c);
      registry?.clear();
    },
    run(command, o) {
      return new Promise<RunResult>((resolve) => {
        const t = o.timeoutMs ?? defaultTimeoutMs;
        const timeoutMs = t !== undefined && t > 0 ? t : undefined;
        const out = new Capture();
        const err = new Capture();
        let done = false;
        const finish = (r: Omit<RunResult, "stdout" | "stderr">): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          clearTimeout(killCap);
          handle?.remove();
          resolve({ ...r, stdout: out.text(), stderr: err.text() });
        };
        let timer: NodeJS.Timeout | undefined;
        let killCap: NodeJS.Timeout | undefined;
        let handle: LiveHandle | undefined;
        let killedByUser = false;
        /** set as soon as the timeout fires: the timeout path finishes the run, once the tree is dead */
        let timingOut = false;
        /** a real exit that arrived while timingOut was set; it wins over the synthetic timeout result */
        let pendingExit: Omit<RunResult, "stdout" | "stderr"> | undefined;
        try {
          const child = spawn("bash", ["-s"], {
            cwd: o.cwd,
            env: { ...process.env, ...o.env },
            detached: true, // own process group so the timeout kills children too
            stdio: ["pipe", "pipe", "pipe"],
          });
          live.add(child);
          if (child.pid) o.onSpawn?.({ pid: child.pid, pgid: child.pid });
          child.stdin.on("error", () => {}); // EPIPE if bash exits early
          child.stdin.end(command);
          child.stdout.on("data", (c: Buffer) => {
            out.push(c);
            handle?.append(c.toString("utf8"));
          });
          child.stderr.on("data", (c: Buffer) => {
            err.push(c);
            handle?.append(c.toString("utf8"));
          });
          if (registry && child.pid) {
            const pid = child.pid;
            handle = registry.add(
              {
                runId: randomUUID(),
                kind: o.meta?.test ? "test" : "rule",
                board: o.meta?.board,
                rule: o.meta?.rule,
                ticketId: o.meta?.ticketId,
                ticketName: o.meta?.ticketName,
                path: o.meta?.path,
                command,
                pid,
                startedAt: isoWithOffset(new Date()),
                timeoutMs: timeoutMs ?? null,
              },
              () => {
                if (done || killedByUser) return !done;
                killedByUser = true;
                void killTree([pid], { graceMs: TERM_GRACE_MS, waitMs: 0 });
                return true;
              },
            );
          }
          child.on("error", (e) => {
            live.delete(child);
            finish({ exitCode: null, error: e.message });
          });
          child.on("exit", (code, signal) => {
            live.delete(child);
            const r = killedByUser
              ? { exitCode: null, error: KILLED_BY_USER }
              : signal
                ? { exitCode: null, error: `killed by ${signal}` }
                : { exitCode: code };
            // brief grace so buffered output flushes; background jobs may hold the pipes open
            let settled = false;
            const end = (): void => {
              if (settled) return;
              settled = true;
              clearTimeout(g);
              child.stdout.destroy();
              child.stderr.destroy();
              // While a timeout is in progress the tree may still be alive: the timeout path finishes
              // the run after the kill, so reporting it here would hide a still-running tree. The exit
              // result is queued instead and wins over the synthetic timeout result, so a child that
              // exits by itself during the timeout window is reported with its real exit code.
              if (timingOut) pendingExit = r;
              else finish(r);
            };
            const g = setTimeout(end, GRACE_MS);
            const pending = [child.stdout, child.stderr].filter((s) => !s.destroyed);
            let open = pending.length;
            if (open === 0) return end();
            for (const s of pending) {
              s.once("close", () => {
                if (--open === 0) end();
              });
            }
          });
          if (timeoutMs !== undefined) {
            timer = setTimeout(() => {
              // SIGTERM the tree, then SIGKILL whatever survives (killTree escalates on its own).
              // Await it: finishing first would report the run done while its tree is still alive, and
              // a one-shot CLI exit would never send the SIGKILL, leaving the run orphaned.
              timingOut = true;
              const pid = child.pid;
              const timedOut = (): void => {
                finish({ exitCode: null, error: `timed out after ${timeoutMs / 1000}s`, timedOut: true });
              };
              // The kill is awaited so the report is not sent while the tree is still alive, but it
              // must not be able to swallow the report: killTree snapshots the tree with a blocking
              // `ps` (procTree.listProcs) that has no timeout, so a wedged ps never settles. Cap the
              // wait; if the cap wins, report anyway. finish is guarded by `done`, so a double report is
              // impossible.
              //
              // Only an exit that is NOT an error/signal-kill (i.e. the child exited on its own with a
              // real exit code) wins over the synthetic timeout result. An exit caused by our own
              // SIGTERM (error: "killed by SIGTERM") must NOT mask `timedOut: true`: that exit is this
              // timeout path's own kill, not the child deciding to stop, so a normal timeout would
              // otherwise be misreported as a SIGTERM kill.
              const report = (): void => {
                timingOut = false;
                if (pendingExit && !pendingExit.error) finish(pendingExit);
                else timedOut();
              };
              killCap = setTimeout(report, KILL_CAP_MS);
              void killTree(pid ? [pid] : [], { graceMs: TERM_GRACE_MS, waitMs: 0 }).then(report, report);
            }, timeoutMs);
          }
        } catch (e) {
          finish({ exitCode: null, error: (e as Error).message });
        }
      });
    },
  };
}
