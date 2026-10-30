import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILE, STARTER_CONFIG } from "../config.js";

export function init(cwd: string): string {
  const file = path.join(cwd, CONFIG_FILE);
  if (fs.existsSync(file)) throw new Error(`${CONFIG_FILE} already exists`);
  fs.writeFileSync(file, STARTER_CONFIG);
  return `created ${CONFIG_FILE}`;
}
