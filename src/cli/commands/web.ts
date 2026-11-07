import { spawn } from "node:child_process";
import { createKanban } from "../../core/index.js";
import { createAutomationLog } from "../../automationLog.js";
import { LiveRuns } from "../../liveRuns.js";
import { createShellRunner } from "../../runner.js";
import { startServer, type RunningServer } from "../../web/server.js";

export interface WebOpts {
  host?: string;
  port?: string | number;
  open?: boolean; // false for --no-open
  automation?: boolean; // false for --no-automation
}

export interface WebIO {
  out: (s: string) => void;
  err: (s: string) => void;
  opener: (url: string) => void;
}

export function defaultOpener(url: string): void {
  try {
    const [cmd, args]: [string, string[]] =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["cmd", ["/c", "start", "", url]]
          : ["xdg-open", [url]];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // ignore
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function parsePort(v: string | number): number {
  const s = String(v).trim();
  const n = Number(s);
  if (!/^\d+$/.test(s) || !Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`invalid port "${s}" (expected an integer 0-65535)`);
  }
  return n;
}

/** The port to bind: the --port flag wins over web.port; both go through parsePort. */
export function resolvePort(flag: string | number | undefined, config: number | undefined): number | undefined {
  if (flag !== undefined) return parsePort(flag);
  return config !== undefined ? parsePort(config) : undefined;
}

export function automationExposureWarning(host: string, automationsEnabled: boolean): string | undefined {
  if (!automationsEnabled || LOOPBACK.has(host.toLowerCase())) return undefined;
  return `warning: listening on ${host} without authentication; automations can run commands on this machine. Use --no-automation to disable.`;
}

export const SHUTDOWN_DEADLINE_MS = 5000;

export async function runWeb(
  cwd: string,
  opts: WebOpts,
  io: WebIO,
): Promise<RunningServer & { shutdown(deadlineMs?: number): Promise<void> }> {
  const { config } = createKanban({ dir: cwd }).load(); // throws if config missing/invalid
  const host = opts.host ?? config.web?.host ?? "127.0.0.1";
  // explicit --port wins over web.port, which wins over the built-in default
  const wanted = resolvePort(opts.port, config.web?.port);
  const port = wanted ?? 4747;
  // a deliberate port (flag or config) must not silently auto-increment; 0 always means OS-assigned
  const strictPort = wanted !== undefined && wanted !== 0;

  const live = new LiveRuns();
  const runner = opts.automation === false ? undefined : createShellRunner({ registry: live });
  const server = await startServer({
    dir: cwd,
    host,
    port,
    strictPort,
    runner,
    live,
    log: createAutomationLog(cwd),
  });
  const wildcard = host === "0.0.0.0" || host === "::";
  const url = wildcard ? `http://localhost:${server.port}` : server.url;
  io.out(`kb web running at ${url}`);
  if (wildcard) io.out(`listening on ${host}:${server.port}`);
  if (!LOOPBACK.has(host)) {
    io.err(`warning: no auth — anyone who can reach ${host}:${server.port} can read and edit your tickets`);
  }
  const exposure = automationExposureWarning(host, runner !== undefined);
  if (exposure) io.err(exposure);
  if (opts.open !== false) io.opener(url);
  return {
    ...server,
    async shutdown(deadlineMs = SHUTDOWN_DEADLINE_MS) {
      try {
        await server.close();
      } finally {
        let t: NodeJS.Timeout | undefined;
        const deadline = new Promise<void>((r) => (t = setTimeout(r, deadlineMs)));
        try {
          await Promise.race([server.settled(), deadline]);
        } finally {
          // runs even when settled() rejects or the deadline wins: never leave the timer
          // pending or automation children alive.
          clearTimeout(t);
          runner?.killAll();
        }
      }
    },
  };
}
