import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/web/server.js";

let dir: string;
let srv: RunningServer;
const ticket = (id: string, status: string) => `---\ntype: ticket\nid: "${id}"\nname: T${id}\nstatus: ${status}\n---\nb\n`;
const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-webcfg-"));
  fs.writeFileSync(path.join(dir, "kanban.yaml"), "# c\ncolumns: [todo, doing, done]\n");
  fs.writeFileSync(path.join(dir, "1.md"), ticket("001", "doing"));
  srv = await startServer({ dir, port: 0 });
});
afterEach(async () => {
  await srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(srv.url + p, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as any };
};

describe("web config api", () => {
  it("GET returns an editable config with mtime", async () => {
    const r = await call("GET", "/api/config");
    expect(r.status).toBe(200);
    expect(r.json.config).toEqual({ name: "default", glob: "*.md", columns: ["todo", "doing", "done"], boards: {} });
    expect(typeof r.json.mtime).toBe("number");
  });

  it("PUT dry-run reports changes and writes nothing", async () => {
    const { config, mtime } = (await call("GET", "/api/config")).json;
    const r = await call("PUT", "/api/config", {
      config: { ...config, columns: ["todo", "wip", "done"] },
      renames: { columns: { "": { doing: "wip" } } },
      dryRun: true,
      mtime,
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ dryRun: true, configChanged: true });
    expect(r.json.changes).toEqual([{ path: "1.md", id: "001", field: "status", from: "doing", to: "wip" }]);
    expect(read("1.md")).toContain("status: doing");
    expect(read("kanban.yaml")).toContain("doing");
  });

  it("PUT applies a rename, migrates tickets, keeps comments; board reflects it", async () => {
    const { config, mtime } = (await call("GET", "/api/config")).json;
    const r = await call("PUT", "/api/config", {
      config: { ...config, columns: ["todo", "wip", "done"] },
      renames: { columns: { "": { doing: "wip" } } },
      mtime,
    });
    expect(r.status).toBe(200);
    expect(r.json.dryRun).toBe(false);
    expect(read("1.md")).toContain("status: wip");
    expect(read("kanban.yaml")).toContain("# c");
    const b = (await call("GET", "/api/board")).json;
    expect(b.columns.default).toEqual(["todo", "wip", "done"]);
    expect(b.boards[0].columns[1].tickets).toHaveLength(1);
  });

  it("PUT refuses removing a used column (400) and writes nothing", async () => {
    const { config } = (await call("GET", "/api/config")).json;
    const r = await call("PUT", "/api/config", { config: { ...config, columns: ["todo", "done"] } });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("invalid");
    expect(r.json.error).toContain("1.md");
    expect(read("kanban.yaml")).toContain("doing");
  });

  it("PUT validation errors are 400; bad mtime type is 400", async () => {
    const { config } = (await call("GET", "/api/config")).json;
    expect((await call("PUT", "/api/config", { config: { ...config, columns: [] } })).status).toBe(400);
    expect((await call("PUT", "/api/config", { config: { ...config, columns: ["a", "a"] } })).status).toBe(400);
    expect((await call("PUT", "/api/config", { config })).status).toBe(200);
    expect((await call("PUT", "/api/config", { config, mtime: "x" })).status).toBe(400);
    expect((await call("PUT", "/api/config", {})).status).toBe(400);
  });

  it("PUT with a stale mtime is 409 stale", async () => {
    const { config, mtime } = (await call("GET", "/api/config")).json;
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dir, "kanban.yaml"), t, t);
    const r = await call("PUT", "/api/config", { config, mtime });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("stale");
    // without mtime = overwrite
    expect((await call("PUT", "/api/config", { config })).status).toBe(200);
  });

  it("PUT is guarded like other writes (JSON content type, same origin)", async () => {
    const { config } = (await call("GET", "/api/config")).json;
    const bad = await fetch(srv.url + "/api/config", {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ config }),
    });
    expect(bad.status).toBe(415);
    const evil = await fetch(srv.url + "/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ config }),
    });
    expect(evil.status).toBe(403);
  });

  it("wrong method on /api/config is 405", async () => {
    expect((await call("POST", "/api/config", {})).status).toBe(405);
  });
});
