#!/usr/bin/env node
// Cuts a release: checks the tree is clean and up to date, verifies, bumps the version,
// then pushes the commit and the `v<version>` tag. The tag triggers .github/workflows/release.yml.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const bump = process.argv[2];
const LEVELS = ["patch", "minor", "major"];
if (!LEVELS.includes(bump)) {
  console.error(`usage: npm run release -- <${LEVELS.join("|")}>`);
  process.exit(1);
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });

const die = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};

if (git("status", "--porcelain")) die("working tree is not clean; commit or stash first");
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== "main") die(`must release from main (currently on ${branch})`);

execFileSync("git", ["fetch", "--quiet", "origin", "main"]);
if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) die("local main is not in sync with origin/main");

run("npm", ["run", "verify"]);

const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
run("npm", ["version", bump, "-m", "chore(release): v%s"]);
const next = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
run("git", ["push", "--follow-tags", "origin", "main"]);

console.log(`\nrelease: ${version} -> v${next} pushed.`);
console.log(`release: CI is building it at ${git("remote", "get-url", "origin").replace(/\.git$/, "")}/actions/workflows/release.yml`);
