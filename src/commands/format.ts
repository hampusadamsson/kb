export function useColor(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

export interface Style {
  bold(s: string): string;
  dim(s: string): string;
}

export function makeStyle(color: boolean): Style {
  const wrap = (a: number, b: number) => (s: string) => (color ? `\x1b[${a}m${s}\x1b[${b}m` : s);
  return { bold: wrap(1, 22), dim: wrap(2, 22) };
}

export function fmtId(id: unknown): string {
  if (id === undefined || id === null) return "?";
  if (typeof id === "number" && Number.isInteger(id)) return String(id).padStart(3, "0");
  return String(id);
}

export function fmtValue(v: unknown): string {
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export interface Result {
  out: string;
  warnings: string[];
}
