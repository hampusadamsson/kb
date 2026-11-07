import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { errorResponse } from "../src/api/api.js";
import { KanbanError } from "../src/index.js";
import { PUBLIC_DIR, readPublic } from "../src/web/assets.js";
import { startServer, type RunningServer } from "../src/web/server.js";
import { EventHub } from "../src/web/watch.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-weberr-"));
  fs.writeFileSync(path.join(dir, "kanban.yaml"), "columns: [todo, done]\n");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("server error handling after listen", () => {
  it("keeps an error listener and survives an emitted error", async () => {
    const servers: http.Server[] = [];
    const orig = http.createServer.bind(http);
    const spy = vi.spyOn(http, "createServer").mockImplementation(((...args: any[]) => {
      const s = (orig as any)(...args) as http.Server;
      servers.push(s);
      return s;
    }) as typeof http.createServer);
    const logged: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logged.push(a.join(" ")));
    let srv: RunningServer | undefined;
    try {
      srv = await startServer({ dir, port: 0 });
      expect(servers).toHaveLength(1);
      const s = servers[0];
      expect(s.listenerCount("error")).toBeGreaterThan(0);
      expect(() => s.emit("error", new Error("EMFILE: too many open files"))).not.toThrow();
      expect(logged.join("\n")).toContain("EMFILE");
    } finally {
      await srv?.close().catch(() => {}); // the emitted error already closed the server
      errSpy.mockRestore();
      spy.mockRestore();
    }
  });
});

interface FakeRes {
  writes: string[];
  ended: number;
}

const fakeRes = (over: Partial<Record<"writableEnded" | "destroyed", boolean>> = {}): ServerResponse & FakeRes => {
  const res: any = {
    writes: [] as string[],
    ended: 0,
    writableEnded: false,
    destroyed: false,
    writeHead: () => res,
    write: (m: string) => {
      res.writes.push(m);
      return true;
    },
    on: () => res,
    end: () => {
      res.ended++;
      return res;
    },
  };
  return Object.assign(res, over) as ServerResponse & FakeRes;
};

describe("EventHub.broadcast", () => {
  it("skips and drops clients whose response ended or was destroyed", () => {
    const hub = new EventHub(dir);
    try {
      const live = fakeRes();
      const ended = fakeRes({ writableEnded: true });
      const dead = fakeRes({ destroyed: true });
      for (const res of [live, ended, dead]) hub.add(res);
      for (const res of [live, ended, dead]) res.writes.length = 0; // drop the connect preamble

      hub.notifyRuns();
      expect(live.writes).toEqual(["event: runs\ndata: {}\n\n"]);
      expect(ended.writes).toEqual([]);
      expect(dead.writes).toEqual([]);

      // skipped clients were deleted from the set, not just skipped once
      ended.writableEnded = false;
      dead.destroyed = false;
      hub.notifyRuns();
      expect(ended.writes).toEqual([]);
      expect(dead.writes).toEqual([]);

      hub.close();
      expect(live.ended).toBe(1);
      expect(ended.ended).toBe(0);
      expect(dead.ended).toBe(0);
    } finally {
      hub.close();
    }
  });
});

describe("symlinks out of the public dir are not served", () => {
  it("returns 404 for a symlink pointing outside the public dir", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "kb-outside-"));
    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, "TOP SECRET\n");
    const linkName = `kb-symlink-escape-${process.pid}-${Date.now()}.txt`;
    const link = path.join(PUBLIC_DIR, linkName);
    let server: RunningServer | undefined;
    try {
      try {
        fs.symlinkSync(secret, link);
      } catch {
        return; // OS/user cannot create symlinks: nothing to assert
      }
      // lexical containment holds, so only the realpath check can catch this
      expect(path.resolve(PUBLIC_DIR, linkName).startsWith(PUBLIC_DIR + path.sep)).toBe(true);
      expect(readPublic(linkName)).toBeUndefined();

      server = await startServer({ dir, port: 0 });
      const r = await fetch(`${server.url}/${linkName}`);
      expect(r.status).toBe(404);
      expect(await r.text()).not.toContain("TOP SECRET");
      // real assets still work
      expect((await fetch(`${server.url}/index.html`)).status).toBe(200);
    } finally {
      await server?.close();
      fs.rmSync(link, { force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("oversized request bodies", () => {
  it("rejects with 413 on the first oversize chunk without waiting for the client to finish", async () => {
    const srv = await startServer({ dir, port: 0 });
    try {
      // Write >1 MB as raw chunks and never call end(): the old code kept draining and hung.
      const decision = await new Promise<{ status?: number; err?: Error }>((resolve) => {
        const timer = setTimeout(() => resolve({ err: new Error("timed out: oversize body was not rejected promptly") }), 2000);
        const req = http.request(
          {
            host: "127.0.0.1",
            port: srv.port,
            path: "/api/tickets",
            method: "POST",
            headers: { "content-type": "application/json" },
          },
          (res) => {
            clearTimeout(timer);
            res.resume();
            resolve({ status: res.statusCode });
          },
        );
        req.on("error", (e) => {
          // a reset after the 413 response is also a valid outcome for the client side
          if (!req.destroyed) resolve({ err: e });
        });
        req.write('{"name":"');
        req.write("x".repeat(1024 * 1024 + 64));
        // deliberately no req.end()
      });
      expect(decision.err).toBeUndefined();
      expect(decision.status).toBe(413);
    } finally {
      await srv.close();
    }
  });
});

describe("EventHub watcher errors", () => {
  it("logs the error, does not rethrow, and re-arms only once", () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logged.push(a.join(" ")));
    const hub = new EventHub(dir);
    try {
      const w = (hub as unknown as { watcher?: fs.FSWatcher }).watcher;
      expect(w).toBeDefined();
      expect(w!.listenerCount("error")).toBeGreaterThan(0);
      expect(() => w!.emit("error", new Error("ENOSPC: watcher died"))).not.toThrow();
      expect(logged.join("\n")).toContain("kb web: watcher error:");
      expect(logged.join("\n")).toContain("ENOSPC");
      // one re-arm happened: a fresh, alive watcher replaced the dead one
      const rearmed = (hub as unknown as { watcher?: fs.FSWatcher }).watcher;
      expect(rearmed).toBeDefined();
      expect(rearmed).not.toBe(w);
      expect(rearmed!.listenerCount("error")).toBeGreaterThan(0);
      // a second failure is logged but must not loop: the watcher is not replaced again
      expect(() => rearmed!.emit("error", new Error("ENOSPC again"))).not.toThrow();
      expect((hub as unknown as { watcher?: fs.FSWatcher }).watcher).toBe(rearmed);
    } finally {
      hub.close();
      spy.mockRestore();
    }
  });
});

describe("EventHub after close", () => {
  it("ignores a queued fs callback: no debounce timer, no broadcast", async () => {
    const callbacks: Array<(ev: string, filename: string) => void> = [];
    const realWatch = fs.watch.bind(fs) as typeof fs.watch;
    const watchSpy = vi.spyOn(fs, "watch").mockImplementation(((p: any, o: any, cb: any) => {
      if (typeof cb === "function") callbacks.push(cb);
      return realWatch(p, o, cb);
    }) as typeof fs.watch);
    const hub = new EventHub(dir);
    try {
      expect(callbacks).toHaveLength(1);
      const onFile = callbacks[0];
      const timerOf = () => (hub as unknown as { timer?: NodeJS.Timeout }).timer;

      // sanity: before close() the same callback does arm the debounce timer
      onFile("change", "ticket.md");
      expect(timerOf()).toBeDefined();

      hub.close();
      const afterClose = timerOf(); // close() cleared it; no callback may replace it

      const broadcastSpy = vi.spyOn(hub as unknown as { broadcast: (msg: string) => void }, "broadcast");
      // a callback queued before close() fires anyway: it must not re-arm or broadcast
      onFile("change", "ticket.md");
      hub.notifyRuns();
      await new Promise((r) => setTimeout(r, 200)); // longer than the debounce window
      expect(timerOf()).toBe(afterClose); // no fresh setTimeout was armed
      expect(broadcastSpy).not.toHaveBeenCalled();
      broadcastSpy.mockRestore();
    } finally {
      hub.close();
      watchSpy.mockRestore();
    }
  });

  it("closes the dead watcher when re-arm is refused", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const hub = new EventHub(dir);
    const watcherOf = () => (hub as unknown as { watcher?: fs.FSWatcher }).watcher;
    try {
      const dead = watcherOf()!;
      dead.emit("error", new Error("ENOSPC: watcher died"));
      const rearmed = watcherOf()!;
      expect(rearmed).not.toBe(dead);
      const closeSpy = vi.spyOn(rearmed, "close");
      expect(() => rearmed.emit("error", new Error("ENOSPC again"))).not.toThrow();
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      hub.close();
      spy.mockRestore();
    }
  });
});

describe("port-bind failure", () => {
  it("unsubscribes from live runs before rethrowing", async () => {
    const blocker = http.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
    const { port } = blocker.address() as { port: number };
    const off = vi.fn<() => void>();
    const live = { onChange: () => off } as any;
    try {
      await expect(startServer({ dir, port, strictPort: true, live })).rejects.toThrow(/port .* is in use/);
      expect(off).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});

describe("500 responses over HTTP", () => {
  it("does not leak internal error text but keeps KanbanError messages", async () => {
    const events = {
      emit: () => {},
      query: () => {
        throw new Error("ENOENT: no such file or directory, open '/srv/secret/.kb/events.log'");
      },
    };
    const srv = await startServer({ dir, port: 0, events: events as any });
    try {
      const r = await fetch(`${srv.url}/api/events`);
      expect(r.status).toBe(500);
      const text = await r.text();
      expect(text).not.toContain("ENOENT");
      expect(text).not.toContain("/srv/secret");
      expect(JSON.parse(text)).toEqual({ error: "internal error", code: "internal" });

      const nf = await fetch(`${srv.url}/api/tickets/999`);
      expect(nf.status).toBe(404);
      expect(((await nf.json()) as any).error).toContain("999");
    } finally {
      await srv.close();
    }
  });
});

describe("errorResponse redaction", () => {
  it("hides internal error text from non-KanbanError throws", () => {
    const r = errorResponse(new Error("ENOENT: no such file or directory, open '/srv/secret/kanban.yaml'"));
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "internal error", code: "internal" });
    expect(JSON.stringify(r.body)).not.toContain("ENOENT");
    expect(JSON.stringify(r.body)).not.toContain("/srv/secret");
    expect(errorResponse("boom").body).toEqual({ error: "internal error", code: "internal" });
  });

  it("keeps KanbanError messages verbatim", () => {
    expect(errorResponse(new KanbanError("not-found", "ticket #9 not found"))).toEqual({
      status: 404,
      body: { error: "ticket #9 not found", code: "not-found" },
    });
    expect(errorResponse(new KanbanError("invalid", "name must not be empty"))).toEqual({
      status: 400,
      body: { error: "name must not be empty", code: "invalid" },
    });
  });
});
