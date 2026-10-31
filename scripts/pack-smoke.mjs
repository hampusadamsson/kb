#!/usr/bin/env node
// Verifies that the published tarball is actually usable: packs it, installs it into a temp
// project, then runs the bin and checks that the web UI assets shipped.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kb-pack-"));
const fail = (msg) => {
  console.error(`pack smoke: ${msg}`);
  process.exit(1);
};

try {
  const packed = execFileSync("npm", ["pack", "--json", "--pack-destination", tmp], { cwd: root, encoding: "utf8" });
  const [info] = JSON.parse(packed);
  const tgz = path.join(tmp, info.filename);
  if (!fs.existsSync(tgz)) fail(`tarball missing: ${tgz}`);

  const files = new Set(info.files.map((f) => f.path));
  for (const required of ["package.json", "dist/cli/main.js", "dist/index.js", "dist/web/public/index.html", "dist/web/public/app.js"]) {
    if (!files.has(required)) fail(`tarball is missing ${required}`);
  }
  if (files.has("src/version.ts")) fail("tarball ships TypeScript sources (check package.json files)");

  const app = path.join(tmp, "app");
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "kb-pack-smoke", private: true, type: "module" }));
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", tgz], { cwd: app, stdio: "inherit" });

  const bin = path.join(app, "node_modules", ".bin", process.platform === "win32" ? "kb.cmd" : "kb");
  if (!fs.existsSync(bin)) fail("bin kb was not linked");

  const run = (...args) => execFileSync(bin, args, { cwd: app, encoding: "utf8" });
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  if (run("--version").trim() !== version) fail(`--version did not print ${version}`);
  run("init");
  run("add", "Smoke ticket", "-l", "smoke");
  const ls = JSON.parse(run("ls"));
  if (ls.total !== 1) fail(`expected 1 ticket after add, got ${ls.total}`);

  console.log(`pack smoke: ok (${info.filename}, ${info.size} bytes, ${info.files.length} files)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
