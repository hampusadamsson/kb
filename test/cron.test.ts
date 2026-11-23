import { describe, expect, it } from "vitest";
import { cronMatches, minuteKey, parseCron } from "../src/core/cron.js";

const spec = (expr: string) => {
  const r = parseCron(expr);
  if (!r.ok) throw new Error(r.error);
  return r.spec;
};
const arr = (s: ReadonlySet<number>) => [...s].sort((a, b) => a - b);

describe("parseCron valid", () => {
  const cases: [string, keyof ReturnType<typeof spec>, number[]][] = [
    ["* * * * *", "minute", Array.from({ length: 60 }, (_, i) => i)],
    ["*/15 * * * *", "minute", [0, 15, 30, 45]],
    ["10-30/10 * * * *", "minute", [10, 20, 30]],
    ["5/20 * * * *", "minute", [5, 25, 45]],
    ["0 0 * * *", "minute", [0]],
    ["1,5,9 * * * *", "minute", [1, 5, 9]],
    ["1-3,10 * * * *", "minute", [1, 2, 3, 10]],
    ["0/100 * * * *", "minute", [0]],
    ["0 */6 * * *", "hour", [0, 6, 12, 18]],
    ["0 * 1,15 * *", "dom", [1, 15]],
    ["0 * * JAN,mar *", "month", [1, 3]],
    ["0 * * Feb-Apr *", "month", [2, 3, 4]],
    ["0 * * * mon-fri", "dow", [1, 2, 3, 4, 5]],
    ["0 * * * SUN,sat", "dow", [0, 6]],
    ["0 * * * 7", "dow", [0]],
    ["0 * * * 0,7", "dow", [0]],
    ["0 * * * 5-7", "dow", [0, 5, 6]],
    ["  0   9  * * 1 ", "hour", [9]],
  ];
  it.each(cases)("%s -> %s", (expr, key, expected) => {
    expect(arr(spec(expr)[key] as ReadonlySet<number>)).toEqual(expected);
  });
});

describe("parseCron invalid", () => {
  const cases: [string, string[]][] = [
    ["", ["5 fields"]],
    ["* * * *", ["5 fields", "got 4"]],
    ["* * * * * *", ["5 fields", "got 6"]],
    ["@reboot", ["5 fields"]],
    ["@daily", ["5 fields"]],
    ["60 * * * *", ["minute", "60"]],
    ["* 24 * * *", ["hour", "24"]],
    ["* * 0 * *", ["day-of-month", "0"]],
    ["* * 32 * *", ["day-of-month", "32"]],
    ["* * * 13 *", ["month", "13"]],
    ["* * * 0 *", ["month", "0"]],
    ["* * * * 8", ["day-of-week", "8"]],
    ["*/0 * * * *", ["minute", "*/0"]],
    ["5-1 * * * *", ["minute", "5-1", "descending"]],
    ["* * * * fri-mon", ["day-of-week", "fri-mon"]],
    [",1 * * * *", ["minute"]],
    ["1, * * * *", ["minute"]],
    ["1,,2 * * * *", ["minute"]],
    ["*/ * * * *", ["minute", "*/"]],
    ["1- * * * *", ["minute", "1-"]],
    ["-5 * * * *", ["minute", "-5"]],
    ["1-2-3 * * * *", ["minute", "1-2-3"]],
    ["*/2/3 * * * *", ["minute", "*/2/3"]],
    ["abc * * * *", ["minute", "abc"]],
    ["* * * foo *", ["month", "foo"]],
    ["* * * * funday", ["day-of-week", "funday"]],
    ["* * * jan *x", ["day-of-week", "*x"]],
    ["1.5 * * * *", ["minute", "1.5"]],
    ["*/-1 * * * *", ["minute", "*/-1"]],
    ["* * * mon *", ["month", "mon"]],
    ["* * * * jan", ["day-of-week", "jan"]],
  ];
  it.each(cases)("%j", (expr, parts) => {
    const r = parseCron(expr);
    expect(r.ok).toBe(false);
    if (!r.ok) for (const p of parts) expect(r.error).toContain(p);
  });
});

describe("cronMatches", () => {
  // 2026-01-05 is a Monday; 2026-01-11 is a Sunday.
  const cases: [string, Date, boolean][] = [
    ["* * * * *", new Date(2026, 0, 5, 12, 34), true],
    ["34 12 * * *", new Date(2026, 0, 5, 12, 34), true],
    ["34 12 * * *", new Date(2026, 0, 5, 12, 35), false],
    ["34 12 * * *", new Date(2026, 0, 5, 13, 34), false],
    ["*/15 * * * *", new Date(2026, 0, 5, 3, 45), true],
    ["*/15 * * * *", new Date(2026, 0, 5, 3, 46), false],
    ["0 0 1 jan *", new Date(2026, 0, 1, 0, 0), true],
    ["0 0 1 jan *", new Date(2026, 1, 1, 0, 0), false],
    ["0 9 * * mon-fri", new Date(2026, 0, 5, 9, 0), true],
    ["0 9 * * mon-fri", new Date(2026, 0, 11, 9, 0), false],
    ["0 9 * * 7", new Date(2026, 0, 11, 9, 0), true],
    ["0 9 * * 0", new Date(2026, 0, 11, 9, 0), true],
    ["0 9 * * 7", new Date(2026, 0, 5, 9, 0), false],
    // DOM/DOW: both restricted -> OR
    ["0 0 15 * mon", new Date(2026, 0, 5, 0, 0), true], // Monday, not 15th
    ["0 0 15 * mon", new Date(2026, 0, 15, 0, 0), true], // 15th (Thursday)
    ["0 0 15 * mon", new Date(2026, 0, 6, 0, 0), false], // neither
    // only one restricted -> AND with wildcard
    ["0 0 15 * *", new Date(2026, 0, 5, 0, 0), false],
    ["0 0 * * mon", new Date(2026, 0, 6, 0, 0), false],
    // dom `*/2` counts as unrestricted (starts with `*`): AND semantics
    ["0 0 */2 * mon", new Date(2026, 0, 5, 0, 0), true], // Monday, odd day
    ["0 0 */2 * mon", new Date(2026, 0, 12, 0, 0), false], // Monday, even day
    ["0 0 */2 * mon", new Date(2026, 0, 7, 0, 0), false], // odd day, Wednesday
  ];
  it.each(cases)("%s @ %s -> %s", (expr, date, expected) => {
    expect(cronMatches(spec(expr), date)).toBe(expected);
  });
});

describe("minuteKey", () => {
  it("formats local time with zero padding", () => {
    expect(minuteKey(new Date(2026, 0, 2, 3, 4, 59))).toBe("2026-01-02T03:04");
    expect(minuteKey(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31T23:59");
  });
  it("is identical within a minute and differs across minutes", () => {
    expect(minuteKey(new Date(2026, 0, 2, 3, 4, 0))).toBe(minuteKey(new Date(2026, 0, 2, 3, 4, 59, 999)));
    expect(minuteKey(new Date(2026, 0, 2, 3, 4))).not.toBe(minuteKey(new Date(2026, 0, 2, 3, 5)));
  });
});
