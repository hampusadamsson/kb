// Static web UI assets. They are read from dist/web/public in a normal npm install.
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
export const PUBLIC_DIR = path.resolve(HERE, "public");

/** True when `p` is a directory on disk. */
export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Reads a file below the public dir. `rel` must already be normalized and free of `..`
 * (the HTTP handler validates this). Returns undefined when the asset does not exist.
 */
export function readPublic(rel: string): Buffer | undefined {
  try {
    return fs.readFileSync(path.resolve(PUBLIC_DIR, rel));
  } catch {
    return undefined;
  }
}
