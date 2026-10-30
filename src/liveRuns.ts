// Registry of automation runs currently in progress (used by the web server; not part of core).

export const OUTPUT_TAIL = 2048;
const COMMAND_MAX = 500;

export interface LiveRunInfo {
  runId: string;
  kind: "rule" | "test";
  board?: string;
  rule?: string;
  ticketId?: string;
  ticketName?: string;
  path?: string;
  command: string;
  pid: number;
  /** ISO with offset */
  startedAt: string;
  timeoutMs: number;
}

export interface LiveRun extends LiveRunInfo {
  elapsedMs: number;
  /** latest ~2 KB of stdout/stderr */
  output: string;
}

export interface LiveHandle {
  append(chunk: string): void;
  remove(): void;
}

interface Entry {
  info: LiveRunInfo;
  out: string;
  kill: () => boolean;
}

export class LiveRuns {
  private runs = new Map<string, Entry>();
  private listeners = new Set<() => void>();

  private notify(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        // listeners must not break runs
      }
    }
  }

  /** Subscribe to start/finish changes; returns an unsubscribe function. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Register a run. `kill` returns false when the process is already gone. */
  add(info: LiveRunInfo, kill: () => boolean): LiveHandle {
    const entry: Entry = { info: { ...info, command: info.command.slice(0, COMMAND_MAX) }, out: "", kill };
    this.runs.set(info.runId, entry);
    this.notify();
    return {
      append: (chunk) => {
        entry.out = (entry.out + chunk).slice(-OUTPUT_TAIL);
      },
      remove: () => {
        if (this.runs.get(info.runId) === entry) {
          this.runs.delete(info.runId);
          this.notify();
        }
      },
    };
  }

  /** Running runs, newest first. */
  list(now = Date.now()): LiveRun[] {
    return [...this.runs.values()]
      .reverse()
      .map((e) => ({ ...e.info, elapsedMs: Math.max(0, now - Date.parse(e.info.startedAt)), output: e.out }));
  }

  /** Terminate a run (SIGTERM, SIGKILL after 2 s). False when unknown or already finished. */
  kill(runId: string): boolean {
    const e = this.runs.get(runId);
    return e ? e.kill() : false;
  }

  /** Forget all runs (shutdown). */
  clear(): void {
    if (!this.runs.size) return;
    this.runs.clear();
    this.notify();
  }
}
