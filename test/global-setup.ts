// Builds dist once before the suite: the e2e tests spawn the compiled CLI and the web server.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

export default function setup() {
  execFileSync("npx", ["tsc"], { stdio: "inherit" });
  fs.cpSync("src/web/public", "dist/web/public", { recursive: true });
}
