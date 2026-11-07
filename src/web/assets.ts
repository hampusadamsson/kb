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
 * Reads a file below the public dir. Returns undefined when the asset does not exist or when it
 * resolves (via symlinks) outside the public dir: a lexical check is not enough, since a symlink
 * inside the public dir can point anywhere on disk.
 */
export function readPublic(rel: string): Buffer | undefined {
  try {
    const root = fs.realpathSync(PUBLIC_DIR);
    const target = fs.realpathSync(path.resolve(PUBLIC_DIR, rel));
    if (target !== root && !target.startsWith(root + path.sep)) return undefined;
    return fs.readFileSync(target);
  } catch {
    return undefined;
  }
}
