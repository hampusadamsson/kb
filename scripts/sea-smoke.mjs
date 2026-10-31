#!/usr/bin/env node
// Smoke test for the single-executable binary produced by build-sea.mjs. Runs it from a temp
// board with no Node in scope, exercises the CLI and starts the web server to prove the embedded
// UI assets work.
//
//   node scripts/sea-smoke.mjs [path-to-binary]
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const bin = path.resolve(process.argv[2] ?? "build/kb");
const root = process.cwd();
const fail = (msg) => {
  console.error(`sea smoke: ${msg}`);
  process.exit(1);
};
if (!fs.existsSync(bin)) fail(`binary not found: ${bin}`);

const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kb-sea-smoke-"));
const run = (...args) => execFileSync(bin, args, { cwd: tmp, encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });

try {
  if (run("--version").trim() !== version) fail(`--version did not print ${version}`);
  if (!run("--help").includes("kb <command>")) fail("--help does not look like kb");

  run("init");
  run("add", "Binary ticket", "-l", "binary");
  const ls = JSON.parse(run("ls"));
  if (ls.total !== 1 || ls.tickets[0].name !== "Binary ticket") fail(`unexpected ls output: ${JSON.stringify(ls)}`);

  // web server + embedded assets
  const port = 4700 + Math.floor(Math.random() * 200);
  const child = spawn(bin, ["web", "--port", String(port), "--no-open"], {
    cwd: tmp,
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin" },
  });
  const base = `http://127.0.0.1:${port}`;
  const wait = async () => {
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`${base}/api/config`);
        if (r.ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("web server did not start");
  };
  try {
    await wait();
    for (const p of ["/", "/app.js", "/style.css", "/api/config"]) {
      const r = await fetch(base + p);
      if (!r.ok) fail(`GET ${p} -> ${r.status}`);
    }
    const html = await (await fetch(`${base}/`)).text();
    if (!html.includes("<title>kb</title>")) fail("index.html does not look like the kb UI");
    const trav = await fetch(`${base}/../../package.json`);
    if (trav.status !== 404) fail(`path traversal returned ${trav.status}`);
  } finally {
    child.kill("SIGTERM");
  }

  const size = (fs.statSync(bin).size / 1024 / 1024).toFixed(1);
  console.log(`sea smoke: ok (${path.basename(bin)}, ${size} MB, version ${version})`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
