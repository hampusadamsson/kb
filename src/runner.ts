// Real automation runner (bash). Lives outside src/core: core only knows the AutomationRunner interface.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { KILLED_BY_USER, type AutomationRunner, type RunResult } from "./core/automation.js";
import { isoWithOffset } from "./core/events.js";
import type { LiveHandle, LiveRuns } from "./liveRuns.js";

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

function killGroup(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

const TERM_GRACE_MS = 2000;

export function createShellRunner(opts: { timeoutMs?: number; registry?: LiveRuns } = {}): AutomationRunner & { killAll(): void } {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const registry = opts.registry;
  const live = new Set<ChildProcess>();
  return {
    killAll() {
      for (const c of live) killGroup(c);
      registry?.clear();
    },
    run(command, o) {
      return new Promise<RunResult>((resolve) => {
        const out = new Capture();
        const err = new Capture();
        let done = false;
        const finish = (r: Omit<RunResult, "stdout" | "stderr">): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          handle?.remove();
          resolve({ ...r, stdout: out.text(), stderr: err.text() });
        };
        let timer: NodeJS.Timeout | undefined;
        let handle: LiveHandle | undefined;
        let killedByUser = false;
        try {
          const child = spawn("bash", ["-s"], {
            cwd: o.cwd,
            env: { ...process.env, ...o.env },
            detached: true, // own process group so the timeout kills children too
            stdio: ["pipe", "pipe", "pipe"],
          });
          live.add(child);
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
                timeoutMs,
              },
              () => {
                if (done || killedByUser) return !done;
                killedByUser = true;
                try {
                  process.kill(-pid, "SIGTERM");
                } catch {
                  try {
                    child.kill("SIGTERM");
                  } catch {
                    // already gone
                  }
                }
                setTimeout(() => {
                  try {
                    process.kill(-pid, 0);
                    process.kill(-pid, "SIGKILL");
                  } catch {
                    // group is gone
                  }
                }, TERM_GRACE_MS).unref();
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
              finish(r);
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
          timer = setTimeout(() => {
            killGroup(child);
            finish({ exitCode: null, error: `timeout after ${timeoutMs / 1000}s` });
          }, timeoutMs);
        } catch (e) {
          finish({ exitCode: null, error: (e as Error).message });
        }
      });
    },
  };
}
