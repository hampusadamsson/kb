import { createKanban } from "../../core/index.js";

export interface ValidateResult {
  out: string;
  errors: number;
  warnings: number;
}

export function validate(cwd: string): ValidateResult {
  const r = createKanban({ dir: cwd }).validate();
  const lines = r.issues.map((i) =>
    i.path ? `${i.severity}: ${i.path}: ${i.message}` : `${i.severity}: ${i.message}`,
  );
  const errors = r.errors.length;
  const warnings = r.warnings.length;
  lines.push(errors + warnings === 0 ? "ok" : `${errors} errors, ${warnings} warnings`);
  return { out: lines.join("\n"), errors, warnings };
}
