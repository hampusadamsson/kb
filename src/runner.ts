// Real automation runner (bash). Lives outside src/core: core only knows the AutomationRunner interface.
import { spawn } from "node:child_process";
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

export function createShellRunner(opts: { timeoutMs?: number } = {}): AutomationRunner {
  const timeoutMs = opts.timeoutMs ?? 30000;
  return {
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
          const child = spawn("bash", ["-c", command], {
            cwd: o.cwd,
            env: { ...process.env, ...o.env },
            detached: true, // own process group so the timeout kills children too
            stdio: ["ignore", "pipe", "pipe"],
          });
          child.stdout.on("data", (c: Buffer) => out.push(c));
          child.stderr.on("data", (c: Buffer) => err.push(c));
          child.on("error", (e) => finish({ exitCode: null, error: e.message }));
          child.on("close", (code, signal) =>
            finish(signal ? { exitCode: null, error: `killed by ${signal}` } : { exitCode: code }),
          );
          timer = setTimeout(() => {
            try {
              if (child.pid) process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
            finish({ exitCode: null, error: `timeout after ${timeoutMs / 1000}s` });
          }, timeoutMs);
        } catch (e) {
          finish({ exitCode: null, error: (e as Error).message });
        }
      });
    },
  };
}
