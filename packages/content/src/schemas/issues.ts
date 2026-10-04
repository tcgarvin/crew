/** Validation issue shapes and the helpers every validation level shares. */

export type ValidationLevel = "structural" | "referential" | "physical";

export type Path = readonly (string | number)[];

export interface ValidationIssue {
  readonly level: ValidationLevel;
  /** JSON path into the bundle, e.g. `["machines", "machine.pump.mk1", "faults", 0, "key"]`. */
  readonly path: Path;
  readonly message: string;
}

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

/** Each `[field, kind, keys]` list holds unique keys; a repeat is reported at `[...path, field]`. */
export function checkLocalKeyLists(
  path: Path,
  lists: readonly (readonly [field: string, kind: string, keys: readonly string[]])[],
  issues: ValidationIssue[],
): void {
  for (const [field, kind, keys] of lists) {
    checkDuplicateLocalKeys(keys, [...path, field], kind, issues);
  }
}

/** Reports `unknown <what> "<id>"` at `path` unless `id` keys `table`; returns whether it does. */
export function checkRef(
  table: Readonly<Record<string, unknown>>,
  id: string,
  what: string,
  path: Path,
  issues: ValidationIssue[],
): boolean {
  if (id in table) return true;
  issues.push(issue("referential", path, `unknown ${what} "${id}"`));
  return false;
}
