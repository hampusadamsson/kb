import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/core/config.js";
import { scan } from "../src/core/tickets.js";

const CLI = path.resolve("dist/cli/main.js");
let dir: string;
const w = (f: string, s: string) => fs.writeFileSync(path.join(dir, f), s);

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-notes-"));
  w("kanban.yaml", "columns: [todo, done]\n");
  w("a-type.md", "---\ntype: {{ type }}\ntags: [type/daily, status/raw]\n---\nx\n");
  w("b-date.md", "---\ndate: {{date}}\ntitle: {{title}}\n---\n");
  w("2026-10-28.md", "---\ntags: [type/daily, status/raw]\ncreated: {{ date }}\n---\n");
  w("plain.md", "no frontmatter\n");
  w("bad-note.md", "---\nfoo: [unclosed\nbar: : :\n---\n");
  w("bad-ticket.md", "---\ntype: ticket\nfoo: [unclosed\n---\n");
  w("real.md", "---\ntype: ticket\nid: 1\nname: Real\nstatus: todo\n---\n");
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("scan ignores non-ticket notes", () => {
  it("only real tickets; only ticket parse errors", () => {
    const r = scan(dir, loadConfig(dir));
    expect(r.tickets.map((t) => t.path)).toEqual(["real.md"]);
    expect(r.diagnostics.map((d) => d.path)).toEqual(["bad-ticket.md"]);
  });
  it("no process warnings emitted", () => {
    const seen: unknown[] = [];
    const h = (w: unknown) => seen.push(w);
    process.on("warning", h);
    scan(dir, loadConfig(dir));
    return new Promise<void>((res) =>
      setTimeout(() => {
        process.off("warning", h);
        expect(seen).toEqual([]);
        res();
      }, 20),
    );
  });
});

describe("cli", () => {
  it("kb ls: stderr only has the ticket parse warning", () => {
    const r = spawnSync("node", [CLI, "ls"], { cwd: dir, encoding: "utf8" });
    expect(JSON.parse(r.stdout).total).toBe(1);
    expect(r.stderr).not.toMatch(/Warning|Keys with collection/);
    expect(r.stderr.match(/^warning:/gm)).toHaveLength(1);
    expect(r.stderr).toContain("bad-ticket.md");
  });
  it("kb validate does not mention non-ticket notes", () => {
    const r = spawnSync("node", [CLI, "validate"], { cwd: dir, encoding: "utf8" });
    const out = r.stdout + r.stderr;
    expect(out).toContain("bad-ticket.md");
    expect(out).not.toMatch(/bad-note|a-type|b-date|2026-10-28|plain\.md|Keys with collection/);
  });
  it("kb web /api/board: clean stderr", async () => {
    const child = spawn("node", [CLI, "web", "--port", "0", "--no-open"], { cwd: dir });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    try {
      const url = await new Promise<string>((res, rej) => {
        const t = setTimeout(() => rej(new Error("no url: " + out + err)), 8000);
        child.stdout.on("data", () => {
          const m = /https?:\/\/\S+/.exec(out);
          if (m) {
            clearTimeout(t);
            res(m[0]);
          }
        });
      });
      const j: any = await (await fetch(url.replace(/\/$/, "") + "/api/board")).json();
      expect(JSON.stringify(j.boards)).toContain("Real");
      expect(JSON.stringify(j)).not.toContain("a-type.md");
      expect(err).not.toMatch(/Keys with collection|\(node:/);
    } finally {
      child.kill("SIGINT");
    }
  });
});
