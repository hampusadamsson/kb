import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createKanban } from "../core/index.js";
import { errorResponse, handleApi } from "./api.js";
import { EventHub } from "./watch.js";

export interface ServerOptions {
  dir: string;
  host?: string;
  port?: number;
  strictPort?: boolean;
  now?: () => Date;
}

export interface RunningServer {
  url: string;
  port: number;
  host: string;
  close(): Promise<void>;
}

const DEFAULT_PORT = 4747;
const PORT_TRIES = 50;
const MAX_BODY = 1024 * 1024;
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "public");

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

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "too-large", "request body too large (max 1 MB)"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("error", reject);
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim() === "") return resolve({});
      try {
        const v: unknown = JSON.parse(text);
        if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
        resolve(v as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, "bad-json", "request body must be a JSON object"));
      }
    });
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
  let file = path.resolve(PUBLIC_DIR, "." + rel);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 404, { error: "not found", code: "not-found" });
  }
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    const data = fs.readFileSync(file);
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "Content-Length": data.length,
    });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    sendJson(res, 404, { error: "not found", code: "not-found" });
  }
}

function listen(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => reject(e);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const host = opts.host ?? "127.0.0.1";
  const wanted = opts.port ?? DEFAULT_PORT;
  const dir = path.resolve(opts.dir);
  const hub = new EventHub(dir);

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/api") {
      return serveStatic(req, res, url.pathname);
    }
    res.setHeader("Cache-Control", "no-store");
    if (method !== "GET" && method !== "HEAD" && !sameOrigin(req)) {
      return sendJson(res, 403, { error: "cross-origin request refused", code: "forbidden" });
    }
    if (url.pathname === "/api/events") {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed", code: "method-not-allowed" });
      return hub.add(res);
    }
    const body = method === "GET" || method === "HEAD" ? {} : await readBody(req);
    const kb = createKanban({ dir, now: opts.now }); // fresh view per request
    const r = handleApi(kb, { method, path: url.pathname, query: url.searchParams, body });
    sendJson(res, r.status, r.body);
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch((e: unknown) => {
      if (res.headersSent) return res.destroy();
      if (e instanceof HttpError) sendJson(res, e.status, { error: e.message, code: e.code });
      else {
        const r = errorResponse(e);
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
        hub.close();
        throw busy
          ? new Error(`port ${port} is in use${opts.strictPort || wanted === 0 ? "" : ` (tried ${wanted}-${port})`}`)
          : e;
      }
      port++;
    }
  }

  const actual = (server.address() as { port: number }).port;
  const shown = host.includes(":") ? `[${host}]` : host;
  return {
    url: `http://${shown}:${actual}`,
    port: actual,
    host,
    close: () =>
      new Promise<void>((resolve, reject) => {
        hub.close();
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}
