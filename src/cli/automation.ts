import { createAutomationLog } from "../automationLog.js";
import { createKanban, type Kanban } from "../core/index.js";
import type { AutomationRecord } from "../core/automation.js";
import { createShellRunner } from "../runner.js";

/** Automations are off inside script runs (KB_AUTOMATION set) or with --no-automation. */
export function automationEnabled(flagOff: boolean): boolean {
  return !flagOff && !process.env.KB_AUTOMATION;
}

export interface AutomationSession {
  kanban: (cwd: string) => Kanban;
  /** wait for runs, then warn on failures */
  finish: (warn: (msg: string) => void) => Promise<void>;
}

export function automationSession(enabled: boolean): AutomationSession {
  const kbs: Kanban[] = [];
  const failed: AutomationRecord[] = [];
  const runner = enabled ? createShellRunner() : undefined;
  return {
    kanban(cwd) {
      const log = createAutomationLog(cwd);
      const kb = createKanban({
        dir: cwd,
        runner,
        automations: enabled,
        onAutomation: (rec) => {
          log.append(rec);
          if (rec.status === "failed") failed.push(rec);
        },
      });
      kbs.push(kb);
      return kb;
    },
    async finish(warn) {
      await Promise.all(kbs.map((k) => k.settled()));
      for (const r of failed) {
        const why = r.result.exitCode !== null ? `exit ${r.result.exitCode}` : (r.result.error ?? "error");
        warn(`warning: automation "${r.rule}" failed (${why})`);
      }
    },
  };
}
