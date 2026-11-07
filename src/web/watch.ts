import fs from "node:fs";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { CONFIG_FILE, loadConfig, matchesTicketGlob, type Config } from "../core/index.js";

const IGNORED = new Set(["node_modules", "dist", ".git", ".kb"]);
const KEEPALIVE_MS = 25_000;
const DEBOUNCE_MS = 100;
const MAX_WAIT_MS = 1000;

/** One shared fs watcher fanning out `changed` events to SSE clients. */
export class EventHub {
  private clients = new Set<ServerResponse>();
  private watcher: fs.FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private keepAlive: NodeJS.Timeout;
  private config: Config | undefined;
  private firstPending = 0;
  /** a dead watcher is re-armed once; a second failure is only logged (no loop) */
  private rearmed = false;
  private closed = false;

  constructor(private readonly dir: string) {
    try {
      this.watcher = this.createWatcher();
    } catch {
      this.watcher = undefined; // no live updates, API still works
    }
    this.keepAlive = setInterval(() => this.broadcast(": keep-alive\n\n"), KEEPALIVE_MS);
    this.keepAlive.unref();
  }

  /** Create the watcher and route its errors to `onWatcherError`. */
  private createWatcher(): fs.FSWatcher {
    const watcher = fs.watch(this.dir, { recursive: true }, (_ev, filename) => this.onFile(filename));
    watcher.on("error", (e: unknown) => this.onWatcherError(e));
    return watcher;
  }

  private onWatcherError(err: unknown): void {
    console.error("kb web: watcher error:", err);
    if (this.closed) return;
    if (this.rearmed) {
      // re-arm at most once: no infinite retry loop, but do not leak the dead handle
      try {
        this.watcher?.close();
      } catch {
        // already dead
      }
      return;
    }
    this.rearmed = true;
    try {
      this.watcher?.close();
    } catch {
      // already dead
    }
    this.watcher = undefined;
    try {
      this.watcher = this.createWatcher();
    } catch {
      // re-arm failed: live updates stay off, API still works
    }
  }

  private relevant(filename: string | Buffer | null): boolean {
    if (!filename) return true;
    const rel = filename.toString();
    const parts = rel.split(path.sep);
    if (parts.some((p) => IGNORED.has(p))) return false;
    if (rel === CONFIG_FILE) {
      this.config = undefined; // reload on next use
      return true;
    }
    if (!this.config) {
      try {
        this.config = loadConfig(this.dir);
      } catch {
        // config unreadable: fall back to any markdown file (not cached)
        return rel.endsWith(".md");
      }
    }
    return matchesTicketGlob(this.config, rel);
  }

  private onFile(filename: string | Buffer | null): void {
    if (this.closed) return; // a queued fs callback may fire after close()
    if (!this.relevant(filename)) return;
    const now = Date.now();
    if (!this.timer) this.firstPending = now;
    clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, this.firstPending + MAX_WAIT_MS - now));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.broadcast("event: changed\ndata: {}\n\n");
    }, wait);
  }

  /** Tell clients the set of running automations changed. */
  notifyRuns(): void {
    if (this.closed) return;
    this.broadcast("event: runs\ndata: {}\n\n");
  }

  private broadcast(msg: string): void {
    for (const res of this.clients) {
      if (res.writableEnded || res.destroyed) {
        this.clients.delete(res);
        continue;
      }
      res.write(msg);
    }
  }

  /** Take over a response as an SSE stream. */
  add(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write("retry: 2000\n: connected\n\n");
    this.clients.add(res);
    res.on("error", () => this.clients.delete(res));
    res.on("close", () => this.clients.delete(res));
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.keepAlive);
    this.watcher?.close();
    this.watcher = undefined;
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}
