const OFFSET_MS = 250;
const MINUTE_MS = 60_000;

export interface SchedulerOptions {
  /** called once at start; the instance is reused so same-minute firing stays deduped */
  kanban: () => { runSchedule(now?: Date): unknown };
  now?: () => Date;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: any) => void;
}

/** Minute-aligned loop calling runSchedule once per minute. Missed ticks are not caught up. */
export function startScheduler(opts: SchedulerOptions): { stop(): void } {
  const kb = opts.kanban();
  const now = opts.now ?? (() => new Date());
  const set = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clear = opts.clearTimeoutFn ?? ((h) => clearTimeout(h));
  let timer: unknown;
  let stopped = false;

  const arm = (): void => {
    const d = now();
    const ms = MINUTE_MS - ((d.getSeconds() * 1000 + d.getMilliseconds()) % MINUTE_MS) + OFFSET_MS;
    timer = set(fire, ms);
    (timer as { unref?: () => void } | undefined)?.unref?.();
  };
  const fire = (): void => {
    if (stopped) return;
    try {
      kb.runSchedule(now());
    } catch (e) {
      console.error("kb scheduler:", e);
    }
    if (!stopped) arm();
  };

  arm();
  return {
    stop() {
      stopped = true;
      if (timer !== undefined) clear(timer);
      timer = undefined;
    },
  };
}
