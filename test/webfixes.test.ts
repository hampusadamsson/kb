import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createKanban, KanbanError } from "../src/index.js";
import { startServer, type RunningServer } from "../src/web/server.js";

let dir: string;
let srv: RunningServer;
const ticket = (id: string, name: string) => `---\ntype: ticket\nid: ${id}\nname: ${name}\nstatus: todo\n---\nb\n`;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-webfix-"));
  fs.writeFileSync(path.join(dir, "kanban.yaml"), 'columns: [todo, doing, done]\nglob: "**/*.md"\n');
  fs.writeFileSync(path.join(dir, "1-a.md"), ticket("1", "Alpha"));
  srv = await startServer({ dir, port: 0 });
});
afterEach(async () => {
  await srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const J = { "content-type": "application/json" };
const send = (method: string, p: string, body?: unknown, headers: Record<string, string> = J) =>
  fetch(srv.url + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

/** raw request so we can set Host freely */
const raw = (p: string, host: string) =>
  new Promise<number>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: srv.port, path: p, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on("error", reject);
    req.end();
  });

describe("csrf", () => {
  it("requires JSON content type on writes", async () => {
    for (const ct of [{}, { "content-type": "text/plain" }, { "content-type": "application/x-www-form-urlencoded" }]) {
      const r = await send("POST", "/api/fix", { dryRun: true }, ct);
      expect(r.status).toBe(415);
      expect(((await r.json()) as any).code).toBe("unsupported");
    }
    expect((await send("PATCH", "/api/tickets/1", {}, {})).status).toBe(415);
    expect((await send("POST", "/api/fix", { dryRun: true }, { "content-type": "application/json; charset=utf-8" })).status).toBe(200);
    expect((await send("POST", "/api/fix")).status).toBe(200); // JSON type, empty body
  });

  it("checks Sec-Fetch-Site", async () => {
    for (const v of ["cross-site", "same-site"]) {
      expect((await send("POST", "/api/fix", {}, { ...J, "sec-fetch-site": v })).status).toBe(403);
    }
    for (const v of ["same-origin", "none"]) {
      expect((await send("POST", "/api/fix", {}, { ...J, "sec-fetch-site": v })).status).toBe(200);
    }
  });

  it("still refuses foreign Origin", async () => {
    expect((await send("POST", "/api/fix", {}, { ...J, origin: "http://evil.example" })).status).toBe(403);
  });
});

describe("host allow-list", () => {
  it("rejects foreign Host on loopback for api, static and events", async () => {
    for (const p of ["/api/board", "/", "/app.js", "/api/events"]) {
      expect(await raw(p, "evil.example:" + srv.port)).toBe(421);
      expect(await raw(p, "evil.example")).toBe(421);
      expect(await raw(p, "localhost:1")).toBe(421);
    }
    expect(await raw("/api/board", `localhost:${srv.port}`)).toBe(200);
    expect(await raw("/api/board", `127.0.0.1:${srv.port}`)).toBe(200);
    const r = await fetch(srv.url + "/api/board", { headers: {} });
    expect(r.status).toBe(200);
  });

  it("returns the documented body", async () => {
    const r = await new Promise<string>((resolve) =>
      http.get({ host: "127.0.0.1", port: srv.port, path: "/", headers: { host: "x.test" } }, (res) => {
        let s = "";
        res.on("data", (c) => (s += c));
        res.on("end", () => resolve(s));
      }),
    );
    expect(JSON.parse(r)).toMatchObject({ error: "host not allowed" });
  });

  it("does not enforce when bound to a wildcard host", async () => {
    const s = await startServer({ dir, port: 0, host: "0.0.0.0" });
    try {
      const code = await new Promise<number>((resolve, reject) =>
        http
          .get({ host: "127.0.0.1", port: s.port, path: "/api/board", headers: { host: "my-lan-box:" + s.port } }, (res) => {
            res.resume();
            resolve(res.statusCode!);
          })
          .on("error", reject),
      );
      expect(code).toBe(200);
    } finally {
      await s.close();
    }
  });
});

describe("file validation", () => {
  it("API rejects unsafe file values", async () => {
    for (const file of ["/etc/x.md", "../x.md", "a/../../x.md", "notes.txt", "sub/x"]) {
      const r = await send("POST", "/api/tickets", { name: "N", file });
      expect(r.status, file).toBe(400);
      expect(((await r.json()) as any).code).toBe("invalid");
    }
    const ok = await send("POST", "/api/tickets", { name: "N", file: "sub/x.md" });
    expect(ok.status).toBe(201);
    expect(fs.existsSync(path.join(dir, "sub", "x.md"))).toBe(true);
  });

  it("core add rejects outside / non-md, allows inside", () => {
    const kb = createKanban({ dir });
    const code = (f: string) => {
      try {
        kb.add({ name: "N", file: f });
      } catch (e) {
        return e instanceof KanbanError ? e.code : "other";
      }
    };
    expect(code("../escape.md")).toBe("invalid");
    expect(code(path.join(os.tmpdir(), "escape.md"))).toBe("invalid");
    expect(code("x.txt")).toBe("invalid");
    expect(code("deep/er/y.md")).toBeUndefined();
    expect(code(path.join(dir, "abs.md"))).toBeUndefined();
    expect(fs.existsSync(path.join(os.tmpdir(), "escape.md"))).toBe(false);
  });
});

describe("robustness", () => {
  it("malformed percent-encoding gives 400", async () => {
    const r = await fetch(srv.url + "/api/tickets/%E0%A4%A");
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).code).toBe("invalid");
  });

  it("oversized body gets a 413", async () => {
    const r = await fetch(srv.url + "/api/tickets", {
      method: "POST",
      headers: J,
      body: JSON.stringify({ name: "x", body: "a".repeat(2 * 1024 * 1024) }),
    });
    expect(r.status).toBe(413);
    expect(((await r.json()) as any).code).toBe("too-large");
  });

  it("two comments in the same minute both persist", async () => {
    const s = await startServer({ dir, port: 0, now: () => new Date(2026, 0, 2, 3, 4, 5) });
    try {
      const post = (text: string) =>
        fetch(s.url + "/api/tickets/1/comments", { method: "POST", headers: J, body: JSON.stringify({ text }) });
      const a = (await (await post("one")).json()) as any;
      const b = (await (await post("two")).json()) as any;
      expect(a.key).not.toBe(b.key);
      const d = (await (await fetch(s.url + "/api/tickets/1")).json()) as any;
      expect(Object.values(d.comments)).toEqual(["one", "two"]);
    } finally {
      await s.close();
    }
  });
});

describe("headers", () => {
  it("static has framing protections, api has nosniff", async () => {
    const r = await fetch(srv.url + "/");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    const csp = r.headers.get("content-security-policy")!;
    for (const d of ["frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'"]) expect(csp).toContain(d);
    expect((await r.text())).toContain('rel="icon"');
    expect((await fetch(srv.url + "/api/board")).headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("sse", () => {
  it("sends retry and fires on temp-file + rename-over", async () => {
    const ac = new AbortController();
    const res = await fetch(srv.url + "/api/events", { signal: ac.signal });
    const reader = res.body!.getReader();
    let buf = "";
    void (async () => {
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done) return;
          buf += new TextDecoder().decode(r.value);
        }
      } catch {
        /* aborted */
      }
    })();
    const waitFor = async (s: string, ms = 3000) => {
      const end = Date.now() + ms;
      while (!buf.includes(s) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
      return buf.includes(s);
    };
    expect(await waitFor("retry: 2000")).toBe(true);
    await waitFor("event: changed", 500); // settle fixture replay
    buf = "";
    fs.writeFileSync(path.join(dir, ".1-a.tmp"), ticket("1", "Renamed"));
    fs.renameSync(path.join(dir, ".1-a.tmp"), path.join(dir, "1-a.md"));
    expect(await waitFor("event: changed")).toBe(true);
    ac.abort();
  });
});
