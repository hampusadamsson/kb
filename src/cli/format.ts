export function useColor(): boolean {
  return Boolean(process.stdout.isTTY) && !("NO_COLOR" in process.env);
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
  return String(id);
}

export function fmtValue(v: unknown): string {
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export const fmtWarning = (w: { path?: string; message: string }): string =>
  w.path ? `warning: ${w.path}: ${w.message}` : `warning: ${w.message}`;
