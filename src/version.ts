// Reads the package version once at startup. Works from src/ (tsx/vitest) and dist/ (published package),
// since both live one level below the package root.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");

/** "0.0.0" when package.json cannot be read (e.g. an exotic bundling setup). */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(PKG, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
