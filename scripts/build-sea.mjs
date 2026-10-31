#!/usr/bin/env node
// Builds a self-contained `kb` binary with Node's Single Executable Application support.
// The web UI is embedded as SEA assets, so the binary needs no Node install and no dist/ folder.
//
//   node scripts/build-sea.mjs [--out <path>]
//
// Requires the `postject` and `esbuild` dev dependencies. Linux/macOS only; Windows would need
// the same steps with a different postject invocation (not wired up here).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const args = process.argv.slice(2);
const outArg = args.indexOf("--out");
const target = process.platform === "win32" ? "kb.exe" : "kb";
const outDir = path.resolve(root, outArg >= 0 ? args[outArg + 1] : "build");
const out = path.join(outDir, target);

const log = (msg) => console.log(`build-sea: ${msg}`);
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { cwd: root, stdio: "inherit", ...opts });

if (process.platform === "win32") {
  console.error("build-sea: Windows is not supported yet (needs a different postject/signature step)");
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kb-sea-"));
try {
  log("compiling TypeScript");
  run("npx", ["tsc"]);

  // 1. bundle to a single CJS file (SEA's main must be CJS)
  const bundle = path.join(tmp, "kb.cjs");
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  log("bundling");
  run("npx", [
    "esbuild",
    "src/cli/main.ts",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=node22",
    "--minify",
    `--outfile=${bundle}`,
    // ESM `import.meta.dirname` -> CJS `__dirname`
    "--define:import.meta.dirname=__dirname",
  ]);

  // 2. collect web assets as SEA asset entries
  const pub = path.join(root, "src/web/public");
  const assets = {};
  const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, `${prefix}/${e.name}`);
      else assets[`web/${prefix ? `${prefix}/` : ""}${e.name}`] = full;
    }
  };
  walk(pub, "");
  log(`${Object.keys(assets).length} web assets embedded`);

  // 3. SEA preparation blob
  const blob = path.join(tmp, "kb.blob");
  const cfgPath = path.join(tmp, "sea-config.json");
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, assets }, null, 2),
  );
  log("creating SEA blob");
  run("node", ["--experimental-sea-config", cfgPath]);

  // 4. inject the blob into a copy of the node binary
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(process.execPath, out);
  fs.chmodSync(out, 0o755);

  if (process.platform === "darwin") {
    // the signature must be removed before injecting, then re-applied (ad-hoc)
    try {
      execFileSync("codesign", ["--remove-signature", out], { stdio: "ignore" });
    } catch {
      /* unsigned to begin with */
    }
  }

  log("injecting");
  const postject = ["postject", out, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"];
  if (process.platform === "darwin") postject.push("--macho-segment-name", "NODE_SEA");
  run("npx", postject);

  if (process.platform === "darwin") {
    run("codesign", ["--sign", "-", out]);
  }

  // 5. verify it actually runs and serves the embedded UI
  const v = execFileSync(out, ["--version"], { encoding: "utf8" }).trim();
  if (v !== version) throw new Error(`binary reports version "${v}", expected "${version}"`);
  const help = execFileSync(out, ["--help"], { encoding: "utf8" });
  if (!help.includes("kb <command>")) throw new Error("binary --help does not look like kb");

  const size = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
  log(`ok -> ${path.relative(root, out)} (${size} MB, version ${v})`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
