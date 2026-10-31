#!/usr/bin/env node
import { buildProgram } from "./program.js";

// No top-level await: the single-executable bundle is CJS, where TLA is unsupported.
buildProgram()
  .parseAsync()
  .catch((e: unknown) => {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
  });
