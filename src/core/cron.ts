export interface CronSpec {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dom: ReadonlySet<number>;
  month: ReadonlySet<number>;
  /** Day of week, 0-6 with 0 = Sunday (7 is normalised to 0). */
  dow: ReadonlySet<number>;
  /** True when the dom field does not start with `*`. */
  domRestricted: boolean;
  /** True when the dow field does not start with `*`. */
  dowRestricted: boolean;
}

export type CronParseResult = { ok: true; spec: CronSpec } | { ok: false; error: string };

interface FieldDef {
  name: string;
  min: number;
  max: number;
  names?: readonly string[];
  nameBase?: number;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const FIELDS: readonly FieldDef[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { name: "day-of-week", min: 0, max: 7, names: DAYS, nameBase: 0 },
];

class FieldError extends Error {}

function bad(def: FieldDef, token: string, why: string): FieldError {
  return new FieldError(`${def.name}: invalid token "${token}" (${why})`);
}

function parseValue(def: FieldDef, token: string, whole: string): number {
  let n: number;
  if (/^\d+$/.test(token)) {
    n = Number(token);
  } else {
    const idx = def.names ? def.names.indexOf(token.toLowerCase()) : -1;
    if (idx < 0 || !/^[a-zA-Z]+$/.test(token)) {
      throw bad(def, whole, `"${token}" is not a valid value`);
    }
    n = idx + (def.nameBase ?? 0);
  }
  if (n < def.min || n > def.max) {
    throw bad(def, whole, `${n} out of range ${def.min}-${def.max}`);
  }
  return n;
}

function parseField(def: FieldDef, field: string): Set<number> {
  const out = new Set<number>();
  if (field === "") throw bad(def, field, "empty field");
  for (const token of field.split(",")) {
    if (token === "") throw bad(def, token, "empty list item");
    const parts = token.split("/");
    if (parts.length > 2) throw bad(def, token, "too many '/'");
    const [rangePart = "", stepPart] = parts;
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) throw bad(def, token, "invalid step");
      step = Number(stepPart);
      if (step < 1) throw bad(def, token, "step must be >= 1");
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = def.min;
      hi = def.max;
    } else if (rangePart === "") {
      throw bad(def, token, "empty value");
    } else if (rangePart.includes("-")) {
      const r = rangePart.split("-");
      if (r.length !== 2 || r[0] === "" || r[1] === "") {
        throw bad(def, token, "malformed range");
      }
      lo = parseValue(def, r[0] as string, token);
      hi = parseValue(def, r[1] as string, token);
      if (lo > hi) throw bad(def, token, "descending range");
    } else {
      lo = parseValue(def, rangePart, token);
      hi = stepPart === undefined ? lo : def.max;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronParseResult {
  if (typeof expr !== "string") {
    return { ok: false, error: "cron expression must be a string" };
  }
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5 || fields[0] === "") {
    const n = expr.trim() === "" ? 0 : fields.length;
    return {
      ok: false,
      error: `expected 5 fields (minute hour day-of-month month day-of-week), got ${n}`,
    };
  }
  try {
    const sets = FIELDS.map((def, i) => parseField(def, fields[i] as string));
    const dow = new Set([...(sets[4] as Set<number>)].map((v) => v % 7));
    return {
      ok: true,
      spec: {
        minute: sets[0] as Set<number>,
        hour: sets[1] as Set<number>,
        dom: sets[2] as Set<number>,
        month: sets[3] as Set<number>,
        dow,
        domRestricted: !(fields[2] as string).startsWith("*"),
        dowRestricted: !(fields[4] as string).startsWith("*"),
      },
    };
  } catch (e) {
    if (e instanceof FieldError) return { ok: false, error: e.message };
    throw e;
  }
}

export function cronMatches(spec: CronSpec, date: Date): boolean {
  if (!spec.minute.has(date.getMinutes())) return false;
  if (!spec.hour.has(date.getHours())) return false;
  if (!spec.month.has(date.getMonth() + 1)) return false;
  const domOk = spec.dom.has(date.getDate());
  const dowOk = spec.dow.has(date.getDay());
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

const p2 = (n: number): string => String(n).padStart(2, "0");

export function minuteKey(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}T${p2(date.getHours())}:${p2(date.getMinutes())}`;
}
