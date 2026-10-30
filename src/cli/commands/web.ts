import { spawn } from "node:child_process";
import { createKanban } from "../../core/index.js";
import { startServer, type RunningServer } from "../../web/server.js";

export interface WebOpts {
  host?: string;
  port?: string | number;
  open?: boolean; // false for --no-open
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

export async function runWeb(cwd: string, opts: WebOpts, io: WebIO): Promise<RunningServer> {
  const host = opts.host ?? "127.0.0.1";
  const explicit = opts.port !== undefined;
  const port = explicit ? parsePort(opts.port as string | number) : 4747;
  createKanban({ dir: cwd }).load(); // throws if config missing/invalid

  const server = await startServer({ dir: cwd, host, port, strictPort: explicit });
  const wildcard = host === "0.0.0.0" || host === "::";
  const url = wildcard ? `http://localhost:${server.port}` : server.url;
  io.out(`kb web running at ${url}`);
  if (wildcard) io.out(`listening on ${host}:${server.port}`);
  if (!LOOPBACK.has(host)) {
    io.err(`warning: no auth — anyone who can reach ${host}:${server.port} can read and edit your tickets`);
  }
  if (opts.open !== false) io.opener(url);
  return server;
}
