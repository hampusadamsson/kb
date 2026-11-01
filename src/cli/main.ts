#!/usr/bin/env node
import { buildProgram } from "./program.js";

// No top-level await: keep the entry point loadable by older CJS interop tooling.
buildProgram()
  .parseAsync()
  .catch((e: unknown) => {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
  });
