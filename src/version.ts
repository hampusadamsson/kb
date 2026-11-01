// Package version. Importing package.json keeps every consumer honest: tsc emits a JSON import
// (dist/version.js sits one level below the package root, so ../package.json resolves for both the
// npm package and a checked-out build).
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = (pkg as { version?: string }).version ?? "0.0.0";
