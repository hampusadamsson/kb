import fs from "node:fs";
import path from "node:path";
import type { AutomationRecord } from "./core/automation.js";

const MAX_BYTES = 256 * 1024;
const KEEP_LINES = 200;
const TAIL_BYTES = 256 * 1024;
const OUT_CAP = 4 * 1024;

/**
 * LEGACY: kept for back-compat (GET /api/automation/log, .kb/automation.log).
 * The UI should use automation.finished events from the event log (src/eventLog.ts) going forward.
 */
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
        const r = { ...rec, command: clip(rec.command), result: { ...rec.result, stdout: clip(rec.result.stdout), stderr: clip(rec.result.stderr) } };
        fs.mkdirSync(folder, { recursive: true });
        fs.appendFileSync(file, JSON.stringify(r) + "\n");
        if (fs.statSync(file).size > MAX_BYTES) {
          const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
          const tmp = `${file}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, lines.slice(-KEEP_LINES).join("\n") + "\n");
          fs.renameSync(tmp, file);
        }
      } catch {
        // logging must never break a command
      }
    },
    recent(n = 20) {
      let text: string;
      try {
        const fd = fs.openSync(file, "r");
        try {
          const size = fs.fstatSync(fd).size;
          const len = Math.min(size, TAIL_BYTES);
          const buf = Buffer.alloc(len);
          let got = 0;
          while (got < len) {
            const k = fs.readSync(fd, buf, got, len - got, size - len + got);
            if (k <= 0) break;
            got += k;
          }
          text = buf.subarray(0, got).toString("utf8");
          if (size > len) {
            const nl = text.indexOf("\n");
            text = nl < 0 ? "" : text.slice(nl + 1); // drop partial first line
          }
        } finally {
          fs.closeSync(fd);
        }
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
