import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const coreDir = path.resolve(import.meta.dirname, "../src/core");
const apiDir = path.resolve(import.meta.dirname, "../src/api");

const forbidden: [string, RegExp][] = [
  ["commander import", /from\s+["']commander["']|require\(["']commander["']\)/],
  ["cli import", /from\s+["'](?:\.\.?\/)+cli(?:\/|\.js|["'])/],
  ["web import", /from\s+["'](?:\.\.?\/)+web(?:\/|\.js|["'])/],
  ["process.stdout", /process\.stdout/],
  ["process.stderr", /process\.stderr/],
  ["process.exit", /process\.exit/],
  ["process.argv", /process\.argv/],
  ["process.env", /process\.env/],
  ["readline", /readline/],
];

describe("architecture: src/core is UI-agnostic", () => {
  const files = fs.readdirSync(coreDir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
  it("finds core files", () => expect(files.length).toBeGreaterThan(0));
  for (const f of files) {
    it(`${f} has no UI dependencies`, () => {
      const src = fs.readFileSync(path.join(coreDir, f), "utf8");
      const hits = forbidden.filter(([, re]) => re.test(src)).map(([n]) => n);
      expect(hits).toEqual([]);
    });
  }
});

const apiForbidden: [string, RegExp][] = [
  ["commander import", /from\s+["']commander["']|require\(["']commander["']\)/],
  ["cli import", /from\s+["'](?:\.\.?\/)+cli(?:\/|\.js|["'])/],
  ["web import", /from\s+["'](?:\.\.?\/)+web(?:\/|\.js|["'])/],
  ["mcp import", /from\s+["'](?:\.\.?\/)+mcp(?:\/|\.js|["'])/],
  ["node:http", /from\s+["']node:http["']|require\(["']node:http["']\)/],
  ["process.stdout", /process\.stdout/],
  ["process.stderr", /process\.stderr/],
  ["process.exit", /process\.exit/],
];

describe("architecture: src/api is HTTP- and UI-agnostic", () => {
  const files = fs.readdirSync(apiDir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
  it("finds api files", () => expect(files.length).toBeGreaterThan(0));
  for (const f of files) {
    it(`${f} has no UI dependencies`, () => {
      const src = fs.readFileSync(path.join(apiDir, f), "utf8");
      const hits = apiForbidden.filter(([, re]) => re.test(src)).map(([n]) => n);
      expect(hits).toEqual([]);
    });
  }
});
