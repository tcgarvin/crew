/**
 * One validation path for authored and generated content (review §E.2, D13).
 *
 * - **L1 structural**: Zod, implemented here.
 * - **L2 referential**: every definition ID resolves across the bundle (plus dynamic defs); record
 *   keys equal their value's `id`; `gen.` namespace only for generated content; local keys unique
 *   within their def; scenario placement/fault keys exist; `unique` items have `maxStack: 1`;
 *   port routes symmetric; price bands `min <= max`. **TODO (W10).**
 * - **L3 semantic/physical**: tile rows match width/height and use declared symbols; doors and
 *   openings sit on compartment boundaries, ramps on hull edges; footprints in bounds, on floor and
 *   non-overlapping; interaction positions reachable and adjacent to footprints; deck connected;
 *   zones on floor; spawn points on floor; recipe tools satisfiable by some item def.
 *   **TODO (W10, with W3 geometry helpers).**
 * - L4 (simulation smoke) lives in `apps/cli`, not here.
 */
import type { ContentBundle } from "@crew/sim";
import { contentBundleSchema } from "./bundle";

export type ValidationLevel = "structural" | "referential" | "physical";

export interface ValidationIssue {
  readonly level: ValidationLevel;
  /** JSON path into the bundle, e.g. `["machines", "machine.pump.mk1", "faults", 0, "key"]`. */
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export type ValidationResult =
  | { readonly ok: true; readonly bundle: ContentBundle }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/** Thrown by validation levels that are not built yet. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet`);
    this.name = "NotImplementedError";
  }
}

/** L1: shape, types, enums, bounds. */
export function validateStructure(input: unknown): ValidationResult {
  const parsed = contentBundleSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, bundle: parsed.data };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      level: "structural" as const,
      path: issue.path.map((segment) => (typeof segment === "symbol" ? String(segment) : segment)),
      message: issue.message,
    })),
  };
}

/** L2: cross-references. TODO (W10). */
export function validateReferences(_bundle: ContentBundle): readonly ValidationIssue[] {
  throw new NotImplementedError("L2 referential content validation");
}

/** L3: geometry and physical plausibility. TODO (W10). */
export function validatePhysical(_bundle: ContentBundle): readonly ValidationIssue[] {
  throw new NotImplementedError("L3 physical content validation");
}

/**
 * Full validation, L1 → L3, stopping at the first level with issues. Until L2/L3 exist this throws
 * `NotImplementedError` for any structurally valid bundle; call `validateStructure` for L1 only.
 */
export function validateBundle(input: unknown): ValidationResult {
  const structural = validateStructure(input);
  if (!structural.ok) {
    return structural;
  }
  for (const level of [validateReferences, validatePhysical]) {
    const issues = level(structural.bundle);
    if (issues.length > 0) {
      return { ok: false, issues };
    }
  }
  return structural;
}
