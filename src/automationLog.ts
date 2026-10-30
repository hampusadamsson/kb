import fs from "node:fs";
import path from "node:path";
import type { AutomationRecord } from "./core/automation.js";

const MAX_BYTES = 256 * 1024;
const KEEP_LINES = 200;
const OUT_CAP = 4 * 1024;

export interface AutomationLog {
  append(rec: AutomationRecord): void;
  /** newest first */
  recent(n?: number): AutomationRecord[];
}

const clip = (s: string): string => (Buffer.byteLength(s) > OUT_CAP ? Buffer.from(s).subarray(0, OUT_CAP).toString("utf8") + "\n[truncated]" : s);

export function createAutomationLog(dir: string): AutomationLog {
  const folder = path.join(dir, ".kb");
  const file = path.join(folder, "automation.log");
  return {
    append(rec) {
      try {
        const r = { ...rec, result: { ...rec.result, stdout: clip(rec.result.stdout), stderr: clip(rec.result.stderr) } };
        fs.mkdirSync(folder, { recursive: true });
        fs.appendFileSync(file, JSON.stringify(r) + "\n");
        if (fs.statSync(file).size > MAX_BYTES) {
          const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
          fs.writeFileSync(file, lines.slice(-KEEP_LINES).join("\n") + "\n");
        }
      } catch {
        // logging must never break a command
      }
    },
    recent(n = 20) {
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        return [];
      }
      const out: AutomationRecord[] = [];
      const lines = text.split("\n");
      for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
        if (!lines[i].trim()) continue;
        try {
          const v: unknown = JSON.parse(lines[i]);
          if (v && typeof v === "object") out.push(v as AutomationRecord);
        } catch {
          // corrupt line
        }
      }
      return out;
    },
  };
}
