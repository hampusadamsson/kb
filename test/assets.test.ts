import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { VERSION } from "../src/version.js";
import { isDir, isSea, PUBLIC_DIR, readPublic } from "../src/web/assets.js";

describe("version", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../package.json"), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});

describe("web assets (filesystem mode)", () => {
  it("is not a single executable outside the SEA build", () => {
    expect(isSea()).toBe(false);
  });
  it("reads a real asset", () => {
    const html = readPublic("index.html")?.toString("utf8") ?? "";
    expect(html).toContain("<title>kb</title>");
  });
  it("returns undefined for a missing asset instead of throwing", () => {
    expect(readPublic("nope-does-not-exist.js")).toBeUndefined();
  });
  it("resolves the public dir next to the compiled server", () => {
    expect(PUBLIC_DIR.endsWith(path.join("web", "public"))).toBe(true);
  });
  it("detects directories only on disk", () => {
    expect(isDir(PUBLIC_DIR)).toBe(true);
    expect(isDir(path.join(PUBLIC_DIR, "index.html"))).toBe(false);
    expect(isDir(path.join(PUBLIC_DIR, "nope"))).toBe(false);
  });
});
