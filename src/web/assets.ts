// Static web UI assets. In a normal Node install they are read from dist/web/public; inside the
// single-executable binary (see scripts/build-sea.mjs) they are embedded and read via node:sea.
import fs from "node:fs";
import path from "node:path";

// import.meta.dirname works in the ESM build; esbuild rewrites it for the CJS bundle.
const HERE = import.meta.dirname;
export const PUBLIC_DIR = path.resolve(HERE, "public");

interface SeaApi {
  isSea(): boolean;
  getAsset(key: string): string | ArrayBuffer;
}

let cached: SeaApi | null | undefined;

/** node:sea when running as a single executable, otherwise null. */
function sea(): SeaApi | null {
  if (cached !== undefined) return cached;
  try {
    const builtin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    cached = (builtin?.("node:sea") as SeaApi | undefined) ?? null;
  } catch {
    cached = null;
  }
  return cached;
}

export const isSea = (): boolean => sea()?.isSea() === true;

/** Directories only exist in a filesystem install; the SEA build has assets, not directories. */
export function isDir(p: string): boolean {
  if (isSea()) return false;
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
  const s = sea();
  if (s?.isSea()) {
    try {
      const v = s.getAsset(`web/${rel}`);
      return typeof v === "string" ? Buffer.from(v) : Buffer.from(v);
    } catch {
      return undefined;
    }
  }
  try {
    return fs.readFileSync(path.resolve(PUBLIC_DIR, rel));
  } catch {
    return undefined;
  }
}
