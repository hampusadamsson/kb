import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const coreDir = path.resolve(import.meta.dirname, "../src/core");

const forbidden: [string, RegExp][] = [
  ["commander import", /from\s+["']commander["']|require\(["']commander["']\)/],
  ["cli import", /from\s+["'](?:\.\.?\/)+cli(?:\/|\.js|["'])/],
  ["process.stdout", /process\.stdout/],
  ["process.stderr", /process\.stderr/],
  ["process.exit", /process\.exit/],
  ["process.argv", /process\.argv/],
  ["process.env", /process\.env/],
  ["readline", /readline/],
];

describe("architecture: src/core is UI-agnostic", () => {
  const files = fs.readdirSync(coreDir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"));
  it("finds core files", () => expect(files.length).toBeGreaterThan(0));
  for (const f of files) {
    it(`${f} has no UI dependencies`, () => {
      const src = fs.readFileSync(path.join(coreDir, f), "utf8");
      const hits = forbidden.filter(([, re]) => re.test(src)).map(([n]) => n);
      expect(hits).toEqual([]);
    });
  }
});
