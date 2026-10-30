import { spawn } from "node:child_process";
import { createKanban } from "../../core/index.js";
import { createAutomationLog } from "../../automationLog.js";
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
      process.platform === "darwin" ? ["open", [url]]
      : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // ignore
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

function parsePort(v: string | number): number {
  const s = String(v).trim();
  const n = Number(s);
  if (!/^\d+$/.test(s) || !Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`invalid port "${s}" (expected an integer 0-65535)`);
  }
  return n;
}

export function automationExposureWarning(host: string, automationsEnabled: boolean): string | undefined {
  if (!automationsEnabled || LOOPBACK.has(host.toLowerCase())) return undefined;
  return `warning: listening on ${host} without authentication; automations can run commands on this machine. Use --no-automation to disable.`;
}

export const SHUTDOWN_DEADLINE_MS = 5000;

export async function runWeb(cwd: string, opts: WebOpts, io: WebIO): Promise<RunningServer & { shutdown(deadlineMs?: number): Promise<void> }> {
  const host = opts.host ?? "127.0.0.1";
  const explicit = opts.port !== undefined;
  const port = explicit ? parsePort(opts.port as string | number) : 4747;
  createKanban({ dir: cwd }).load(); // throws if config missing/invalid

  const runner = opts.automation === false ? undefined : createShellRunner();
  const server = await startServer({
    dir: cwd,
    host,
    port,
    strictPort: explicit,
    runner,
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
        await Promise.race([server.settled(), deadline]);
        clearTimeout(t);
        runner?.killAll();
      }
    },
  };
}
