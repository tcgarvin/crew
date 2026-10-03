/** Validation issue shapes and the helpers every validation level shares. */

export type ValidationLevel = "structural" | "referential" | "physical";

export interface ValidationIssue {
  readonly level: ValidationLevel;
  /** JSON path into the bundle, e.g. `["machines", "machine.pump.mk1", "faults", 0, "key"]`. */
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export type Path = readonly (string | number)[];

export function issue(level: ValidationLevel, path: Path, message: string): ValidationIssue {
  return { level, path, message };
}

export function checkDuplicateLocalKeys(
  keys: readonly string[],
  path: Path,
  kind: string,
  issues: ValidationIssue[],
): void {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) {
      issues.push(issue("referential", path, `duplicate ${kind} key "${key}"`));
    }
    seen.add(key);
  }
}
