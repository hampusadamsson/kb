// Real automation runner (bash). Lives outside src/core: core only knows the AutomationRunner interface.
import { spawn, type ChildProcess } from "node:child_process";
import type { AutomationRunner, RunResult } from "./core/automation.js";

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

export function createShellRunner(opts: { timeoutMs?: number } = {}): AutomationRunner & { killAll(): void } {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const live = new Set<ChildProcess>();
  return {
    killAll() {
      for (const c of live) killGroup(c);
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
          resolve({ ...r, stdout: out.text(), stderr: err.text() });
        };
        let timer: NodeJS.Timeout | undefined;
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
          child.stdout.on("data", (c: Buffer) => out.push(c));
          child.stderr.on("data", (c: Buffer) => err.push(c));
          child.on("error", (e) => {
            live.delete(child);
            finish({ exitCode: null, error: e.message });
          });
          child.on("exit", (code, signal) => {
            live.delete(child);
            const r = signal ? { exitCode: null, error: `killed by ${signal}` } : { exitCode: code };
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
