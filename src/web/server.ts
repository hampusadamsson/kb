import http from "node:http";
import path from "node:path";
import { createKanban, KanbanError } from "../core/index.js";
import type { AutomationLog } from "../automationLog.js";
import { createEventLog, type EventLog } from "../eventLog.js";
import type { AutomationRunner } from "../core/automation.js";
import { pidAlive } from "../killRun.js";
import type { LiveRuns } from "../liveRuns.js";
import { errorResponse, handleApi } from "../api/api.js";
import { isDir, PUBLIC_DIR, readPublic } from "./assets.js";
import { EventHub } from "./watch.js";

export interface ServerOptions {
  dir: string;
  host?: string;
  port?: number;
  strictPort?: boolean;
  now?: () => Date;
  /** runs automations; absent → none run */
  runner?: AutomationRunner;
  /** registry the runner reports running automations to (enables the Live tab and kill) */
  live?: LiveRuns;
  /** legacy automation log */
  log?: AutomationLog;
  /** audit event log (default: <dir>/.kb/events.log) */
  events?: EventLog;
}

export interface RunningServer {
  url: string;
  port: number;
  host: string;
  /** resolves when automation runs started by requests have finished */
  settled(): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_PORT = 4747;
const PORT_TRIES = 50;
const MAX_BODY = 1024 * 1024;
/** how long an oversize request may keep (not) sending while we discard its remainder */
const DRAIN_GRACE_MS = 3000;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

const CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** thrown by `readBody` when it already wrote the response itself and the caller must not answer again */
class BodyAnswered extends Error {}

function sendJson(res: http.ServerResponse, status: number, body: unknown, end = true): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Length": Buffer.byteLength(data),
    ...(status === 413 ? { Connection: "close" } : {}),
  });
  if (end) res.end(data);
  else res.write(data);
}

function readBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    // The 413 is written (headers and body) as soon as the first oversize chunk arrives, so the
    // client sees it even if it never finishes writing. The response is *ended* only once the
    // remainder has been drained: ending it while the peer is still writing makes Node tear the
    // socket down mid-write, and the client then sees ECONNRESET instead of the 413.
    const overflow = (): void => {
      tooLarge = true;
      chunks.length = 0; // memory stays bounded: nothing beyond MAX_BODY is ever buffered
      sendJson(res, 413, { error: "request body too large (max 1 MB)", code: "too-large" }, false);
      // Bound the drain: a client that sends >1 MB and then stalls must not pin the socket open.
      const timer = setTimeout(() => req.destroy(), DRAIN_GRACE_MS);
      timer.unref();
      const flush = (): void => {
        clearTimeout(timer);
        if (!res.writableEnded) res.end();
      };
      req.once("end", flush);
      req.once("close", () => clearTimeout(timer));
      req.once("error", () => clearTimeout(timer));
      settle(() => reject(new BodyAnswered()));
    };
    req.on("data", (c: Buffer) => {
      if (tooLarge) return; // discarding the remainder
      size += c.length;
      if (size > MAX_BODY) overflow();
      else chunks.push(c);
    });
    req.on("error", (e: Error) => settle(() => reject(e)));
    req.on("end", () =>
      settle(() => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (text.trim() === "") return resolve({});
        try {
          const v: unknown = JSON.parse(text);
          if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
          resolve(v as Record<string, unknown>);
        } catch {
          reject(new HttpError(400, "bad-json", "request body must be a JSON object"));
        }
      }),
    );
  });
}

function sameOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function hostAllowed(req: http.IncomingMessage, allowed: Set<string> | undefined): boolean {
  if (!allowed) return true;
  return allowed.has((req.headers.host ?? "").toLowerCase());
}

function secFetchOk(req: http.IncomingMessage): boolean {
  const v = req.headers["sec-fetch-site"];
  if (v === undefined) return true;
  return v === "same-origin" || v === "none";
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { error: "method not allowed", code: "method-not-allowed" });
  }
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: "bad path", code: "invalid" });
  }
  if (rel.includes("\0")) return sendJson(res, 400, { error: "bad path", code: "invalid" });
  let target = path.resolve(PUBLIC_DIR, "." + rel);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 404, { error: "not found", code: "not-found" });
  }
  let key = path.relative(PUBLIC_DIR, target).split(path.sep).join("/");
  if (key === "" || isDir(target)) key = key === "" ? "index.html" : `${key}/index.html`;
  const data = readPublic(key);
  if (!data) {
    sendJson(res, 404, { error: "not found", code: "not-found" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(key).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": "no-store",
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Length": data.length,
  });
  res.end(req.method === "HEAD" ? undefined : data);
}

function listen(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => reject(e);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      // A listening server must keep an error handler: late socket errors (EMFILE, EACCES) would
      // otherwise be thrown as uncaught exceptions and take the process down.
      server.on("error", (e: Error) => {
        console.error(`kb web: server error: ${e.message}`);
        server.close();
      });
      resolve();
    });
  });
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const host = opts.host ?? "127.0.0.1";
  const wanted = opts.port ?? DEFAULT_PORT;
  const dir = path.resolve(opts.dir);
  const hub = new EventHub(dir);
  const events = opts.events ?? createEventLog(dir);
  const offRuns = opts.live?.onChange(() => hub.notifyRuns());
  const cleanup = (): void => {
    offRuns?.();
    hub.close();
  };
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(host.toLowerCase());
  const pending = new Set<Promise<void>>();
  let allowedHosts: Set<string> | undefined; // set once the port is known; undefined = no check

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    if (!hostAllowed(req, allowedHosts)) {
      return sendJson(res, 421, { error: "host not allowed", code: "host-not-allowed" });
    }
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/api") {
      return serveStatic(req, res, url.pathname);
    }
    res.setHeader("Cache-Control", "no-store");
    const writes = method !== "GET" && method !== "HEAD";
    if (writes && (!sameOrigin(req) || !secFetchOk(req))) {
      return sendJson(res, 403, { error: "cross-origin request refused", code: "forbidden" });
    }
    if (
      writes &&
      !String(req.headers["content-type"] ?? "")
        .toLowerCase()
        .startsWith("application/json")
    ) {
      return sendJson(res, 415, { error: "content-type must be application/json", code: "unsupported" });
    }
    if (url.pathname === "/api/stream") {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed", code: "method-not-allowed" });
      return hub.add(res);
    }
    const body = method === "GET" || method === "HEAD" ? {} : await readBody(req, res);
    const kb = createKanban({
      dir,
      now: opts.now,
      runner: opts.runner,
      events,
      source: "web",
      isAlive: pidAlive,
      onAutomation: opts.log ? (rec) => opts.log!.append(rec) : undefined,
    }); // fresh view per request
    const r = await handleApi(
      kb,
      { method, path: url.pathname, query: url.searchParams, body },
      {
        runner: opts.runner,
        log: opts.log,
        events,
        live: opts.live,
        dir,
        // Redacted 500s lose all diagnostics: keep the original server-side. Expected failures
        // (HttpError/KanbanError) never reach this, so 404/409/415 stay quiet.
        onInternalError: (e) => console.error("kb web:", e),
      },
    );
    if (opts.runner) {
      const p = kb.settled().catch(() => {});
      pending.add(p);
      void p.then(() => pending.delete(p));
    }
    sendJson(res, r.status, r.body);
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch((e: unknown) => {
      if (e instanceof BodyAnswered) return; // readBody already sent the 413 and will end it
      if (res.headersSent) return res.destroy();
      if (e instanceof HttpError) sendJson(res, e.status, { error: e.message, code: e.code });
      else {
        const r = errorResponse(e);
        if (!(e instanceof KanbanError)) console.error("kb web:", e);
        sendJson(res, r.status, r.body);
      }
    });
  });

  let port = wanted;
  for (let i = 0; ; i++) {
    try {
      await listen(server, host, port);
      break;
    } catch (e) {
      const busy = (e as NodeJS.ErrnoException).code === "EADDRINUSE";
      if (!busy || opts.strictPort || wanted === 0 || i >= PORT_TRIES) {
        cleanup();
        throw busy ? new Error(`port ${port} is in use${opts.strictPort || wanted === 0 ? "" : ` (tried ${wanted}-${port})`}`) : e;
      }
      port++;
    }
  }

  const actual = (server.address() as { port: number }).port;
  if (loopback) {
    allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]"].map((n) => `${n}:${actual}`));
  }
  const shown = host.includes(":") ? `[${host}]` : host;
  return {
    url: `http://${shown}:${actual}`,
    port: actual,
    host,
    settled: async () => {
      while (pending.size) await Promise.all([...pending]);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        cleanup();
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}
