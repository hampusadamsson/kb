import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/web/server.js";

let dir: string;
let srv: RunningServer;
const ticket = (id: string, name: string, extra = "") =>
  `---\ntype: ticket\nid: ${id}\nname: ${name}\nstatus: todo\n${extra}---\nbody ${name}\n`;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-web-"));
  fs.writeFileSync(
    path.join(dir, "kanban.yaml"),
    'columns: [todo, doing, done]\nglob: "**/*.md"\nboards:\n  other:\n    columns: [backlog, active]\n',
  );
  fs.writeFileSync(path.join(dir, "1-a.md"), ticket("1", "Alpha", "labels: [bug]\npriority: high\n"));
  fs.writeFileSync(path.join(dir, "2-b.md"), ticket("2", "Beta"));
  srv = await startServer({ dir, port: 0 });
});
afterEach(async () => {
  await srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(srv.url + p, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: r.status, headers: r.headers, json: (await r.json()) as any };
};

describe("web api", () => {
  it("lists the board with views and filters", async () => {
    const r = await call("GET", "/api/board");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.json.boardNames).toEqual(["default", "other"]);
    expect(r.json.columns.other).toEqual(["backlog", "active"]);
    const todo = r.json.boards[0].columns[0].tickets;
    expect(todo.map((t: any) => t.id)).toEqual([1, 2]);
    expect(todo[0]).toMatchObject({ name: "Alpha", labels: ["bug"], props: { priority: "high" }, hasId: true, duplicate: false, readOnly: false });
    expect(todo[0].raw).toBeUndefined();
    expect(typeof todo[0].mtime).toBe("number");

    const f = await call("GET", "/api/board?label=bug&property=priority:high&board=default");
    expect(f.json.boards[0].columns[0].tickets.map((t: any) => t.id)).toEqual([1]);
    expect((await call("GET", "/api/board?text=beta")).json.boards[0].columns[0].tickets).toHaveLength(1);
    expect((await call("GET", "/api/board?board=nope")).status).toBe(404);
  });

  it("ticket detail and not-found", async () => {
    const r = await call("GET", "/api/tickets/1");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: 1, body: "body Alpha\n", comments: {}, data: { type: "ticket", priority: "high" } });
    const n = await call("GET", "/api/tickets/99");
    expect(n.status).toBe(404);
    expect(n.json.code).toBe("not-found");
  });

  it("creates tickets", async () => {
    const r = await call("POST", "/api/tickets", { name: "New", labels: ["x"], properties: { n: 3 }, body: "hi" });
    expect(r.status).toBe(201);
    expect(r.json.id).toBe("003");
    expect(fs.existsSync(path.join(dir, r.json.path))).toBe(true);
    expect((await call("GET", "/api/tickets/3")).json.props).toEqual({ n: 3 });
    expect((await call("POST", "/api/tickets", {})).status).toBe(400);
    expect((await call("POST", "/api/tickets", { name: "x", id: "1" })).status).toBe(409);
    expect((await call("POST", "/api/tickets", { name: "x", labels: "a" })).status).toBe(400);
  });

  it("patches tickets", async () => {
    const r = await call("PATCH", "/api/tickets/1", {
      status: "doing", addLabels: ["new"], removeLabels: ["bug"], setProps: { priority: "low" }, body: "changed",
    });
    expect(r.status).toBe(200);
    const d = (await call("GET", "/api/tickets/1")).json;
    expect(d).toMatchObject({ status: "doing", column: "doing", labels: ["new"], props: { priority: "low" }, body: "changed\n" });
    expect((await call("PATCH", "/api/tickets/1", { unsetProps: ["priority"] })).status).toBe(200);
    expect((await call("PATCH", "/api/tickets/1", {})).status).toBe(400);
    expect((await call("PATCH", "/api/tickets/99", { name: "x" })).status).toBe(404);
  });

  it("rejects stale mtime", async () => {
    const d = (await call("GET", "/api/tickets/1")).json;
    const stale = await call("PATCH", "/api/tickets/1", { name: "X", mtime: d.mtime - 1000 });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: "stale", currentMtime: d.mtime });
    expect((await call("GET", "/api/tickets/1")).json.name).toBe("Alpha");
    const good = await call("PATCH", "/api/tickets/1", { name: "X", mtime: d.mtime });
    expect(good.status).toBe(200);
    const again = await call("PATCH", "/api/tickets/1", { name: "Y", mtime: d.mtime });
    // file rewritten: mtime normally moves on; allow equal-ms edge by checking the fresh one
    if (good.json.mtime !== d.mtime) expect(again.status).toBe(409);
    const c = await call("POST", "/api/tickets/1/comments", { text: "t", mtime: d.mtime - 1000 });
    expect(c.status).toBe(409);
  });

  it("refuses duplicate and missing-id tickets", async () => {
    fs.writeFileSync(path.join(dir, "dup.md"), ticket("2", "Dup"));
    fs.writeFileSync(path.join(dir, "noid.md"), "---\ntype: ticket\nname: NoId\nstatus: todo\n---\n");
    expect((await call("PATCH", "/api/tickets/2", { name: "x" })).status).toBe(409);
    expect((await call("GET", "/api/tickets/2")).status).toBe(409);
    const b = await call("GET", "/api/board");
    const all = b.json.boards[0].columns[0].tickets;
    const dups = all.filter((t: any) => String(t.id) === "2");
    expect(dups).toHaveLength(2);
    expect(dups.every((t: any) => t.duplicate && t.readOnly)).toBe(true);
    const noid = all.find((t: any) => t.name === "NoId");
    expect(noid).toMatchObject({ hasId: false, duplicate: false, readOnly: true, id: null });
    expect(b.json.warnings.length).toBeGreaterThan(0);
  });

  it("adds comments", async () => {
    const r = await call("POST", "/api/tickets/1/comments", { text: "hello" });
    expect(r.status).toBe(201);
    expect(typeof r.json.key).toBe("string");
    expect((await call("GET", "/api/tickets/1")).json.comments[r.json.key]).toBe("hello");
    expect((await call("POST", "/api/tickets/1/comments", {})).status).toBe(400);
    expect((await call("POST", "/api/tickets/99/comments", { text: "x" })).status).toBe(404);
  });

  it("validates and fixes (dry-run by default)", async () => {
    fs.writeFileSync(path.join(dir, "noid.md"), "---\ntype: ticket\nname: NoId\nstatus: todo\n---\n");
    const v = await call("GET", "/api/validate");
    expect(v.json.errors.some((e: any) => e.message === "missing id")).toBe(true);
    const dry = await call("POST", "/api/fix");
    expect(dry.json.dryRun).toBe(true);
    expect(dry.json.changes).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, "noid.md"), "utf8")).not.toContain("id:");
    const real = await call("POST", "/api/fix", { dryRun: false });
    expect(real.json.changes).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, "noid.md"), "utf8")).toContain("id:");
    expect((await call("GET", "/api/validate")).json.errors).toEqual([]);
  });

  it("guards same origin on state changes", async () => {
    const evil = await call("POST", "/api/tickets", { name: "e" }, { Origin: "http://evil.example" });
    expect(evil.status).toBe(403);
    expect(evil.json.error).toBeTruthy();
    expect((await call("PATCH", "/api/tickets/1", { name: "e" }, { Origin: "http://evil.example" })).status).toBe(403);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".md"))).toHaveLength(2);
    const host = new URL(srv.url).host;
    expect((await call("POST", "/api/tickets", { name: "ok" }, { Origin: `http://${host}` })).status).toBe(201);
    expect((await call("POST", "/api/tickets", { name: "ok2" })).status).toBe(201);
  });

  it("handles bad input and routing", async () => {
    expect((await call("POST", "/api/tickets", "{nope")).status).toBe(400);
    expect((await call("POST", "/api/tickets", "[1]")).status).toBe(400);
    const big = await call("POST", "/api/tickets", { name: "x".repeat(1024 * 1024 + 10) }).catch(() => ({ status: 413 }));
    expect(big.status).toBe(413);
    const u = await call("GET", "/api/nope");
    expect(u.status).toBe(404);
    expect(u.json.code).toBe("not-found");
    const m = await call("DELETE", "/api/board");
    expect(m.status).toBe(405);
    expect((await call("GET", "/api/fix")).status).toBe(405);
  });

  it("reports missing config", async () => {
    fs.rmSync(path.join(dir, "kanban.yaml"));
    const r = await call("GET", "/api/board");
    expect(r.status).toBe(500);
    expect(r.json.code).toBe("config");
    expect(r.json.error).toContain("kb init");
  });
});

describe("static files", () => {
  it("serves index.html", async () => {
    const r = await fetch(srv.url + "/");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(await r.text()).toContain("/app.js");
    expect((await fetch(srv.url + "/index.html")).status).toBe(200);
    expect((await fetch(srv.url + "/missing.js")).status).toBe(404);
  });

  it("blocks traversal", async () => {
    for (const p of ["/..%2f..%2fpackage.json", "/%2e%2e/%2e%2e/package.json", "/../../package.json", "/..%2f..%2f..%2fpackage.json"]) {
      const r = await fetch(srv.url + p);
      expect([400, 404]).toContain(r.status);
      expect(await r.text()).not.toContain('"name": "kb"');
    }
    // raw (non-normalised) request path
    const status = await new Promise<number>((resolve, reject) => {
      http.get({ host: srv.host, port: srv.port, path: "/../../package.json" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on("error", reject);
    });
    expect([400, 404]).toContain(status);
  });
});

async function openEvents(url: string) {
  const ac = new AbortController();
  const res = await fetch(url + "/api/events", { signal: ac.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  const waitFor = async (needle: string, ms = 2000): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (!buf.includes(needle)) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      pending ??= reader.read();
      const r = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), left))]);
      if (r !== null) pending = undefined;
      if (r === null || r.done) return buf.includes(needle);
      buf += dec.decode(r.value);
    }
    return true;
  };
  return { res, waitFor, clear: () => (buf = ""), close: () => ac.abort() };
}

describe("events (SSE)", () => {
  it("emits changed on external file edits", async () => {
    const ev = await openEvents(srv.url);
    expect(ev.res.headers.get("content-type")).toBe("text/event-stream");
    expect(await ev.waitFor(": connected")).toBe(true);
    fs.writeFileSync(path.join(dir, "3-c.md"), ticket("3", "Gamma"));
    expect(await ev.waitFor("event: changed\ndata: {}\n\n")).toBe(true);
    ev.close();
  });

  it("emits changed on API edits, config edits, ignores other files", async () => {
    const ev = await openEvents(srv.url);
    await ev.waitFor(": connected");
    // FSEvents may replay the fixture writes from beforeEach; let them settle
    await ev.waitFor("event: changed", 500);
    ev.clear();
    fs.writeFileSync(path.join(dir, "notes.txt"), "x");
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.writeFileSync(path.join(dir, "node_modules", "x.md"), "x");
    expect(await ev.waitFor("event: changed", 500)).toBe(false);
    await call("PATCH", "/api/tickets/1", { status: "done" });
    expect(await ev.waitFor("event: changed")).toBe(true);
    ev.clear();
    fs.appendFileSync(path.join(dir, "kanban.yaml"), "# c\n");
    expect(await ev.waitFor("event: changed")).toBe(true);
    ev.close();
  });

  it("close() resolves with open SSE clients", async () => {
    const ev = await openEvents(srv.url);
    await ev.waitFor(": connected");
    const s2 = await startServer({ dir, port: 0 });
    await s2.close();
    // afterEach closes srv while the stream is still open
  });
});

describe("listening", () => {
  it("defaults to loopback and port 0 picks a free port", () => {
    expect(srv.host).toBe("127.0.0.1");
    expect(srv.port).toBeGreaterThan(0);
    expect(srv.url).toBe(`http://127.0.0.1:${srv.port}`);
  });

  it("tries next port when busy, errors with strictPort", async () => {
    const a = await startServer({ dir, port: 0 });
    const b = await startServer({ dir, port: a.port });
    expect(b.port).toBeGreaterThan(a.port);
    await expect(startServer({ dir, port: a.port, strictPort: true })).rejects.toThrow(/in use/);
    await b.close();
    await a.close();
  });

  it("close() stops listening", async () => {
    const s = await startServer({ dir, port: 0 });
    await s.close();
    await expect(fetch(s.url + "/api/board")).rejects.toThrow();
  });
});

describe("web frontend assets", () => {
  it("serves index.html referencing app.js and style.css, with CSP", async () => {
    const r = await fetch(srv.url + "/");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'self'");
    const html = await r.text();
    expect(html).toContain("/app.js");
    expect(html).toContain("/style.css");
    expect(html).not.toMatch(/\son\w+=|<style|<script(?![^>]*src=)/i);
  });
  it("serves modules and css with correct content types", async () => {
    const types: Record<string, string> = {
      "/app.js": "text/javascript", "/api.js": "text/javascript", "/logic.js": "text/javascript",
      "/board.js": "text/javascript", "/dialog.js": "text/javascript", "/dom.js": "text/javascript",
      "/filters.js": "text/javascript", "/settings.js": "text/javascript", "/style.css": "text/css",
    };
    for (const [p, t] of Object.entries(types)) {
      const r = await fetch(srv.url + p);
      expect(r.status, p).toBe(200);
      expect(r.headers.get("content-type"), p).toContain(t);
    }
  });
});
