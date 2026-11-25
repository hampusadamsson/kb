import { createEventLog } from "../eventLog.js";
import { createAutomationLog } from "../automationLog.js";
import { createKanban, type Kanban, type KanbanOptions } from "../core/index.js";
import type { AutomationRecord } from "../core/automation.js";
import { createShellRunner } from "../runner.js";
import { depthFromEnv } from "../core/automation.js";

/** Automations are off only with --no-automation (nesting is bounded by KB_AUTOMATION_DEPTH in core). */
export function automationEnabled(flagOff: boolean): boolean {
  return !flagOff;
}

/** Event-log and depth options for CLI-created Kanbans; scripts run by automations (KB_AUTOMATION_DEPTH > 0) log as "automation". */
export function eventOpts(cwd: string): Pick<KanbanOptions, "events" | "source" | "depth"> {
  const depth = depthFromEnv(process.env);
  return { events: createEventLog(cwd), source: depth > 0 ? "automation" : "cli", depth };
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
        ...eventOpts(cwd),
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
