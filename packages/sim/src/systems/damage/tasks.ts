/**
 * Task derivation for the problems damage response owns (D93, D94): `machineDamaged` →
 * `repairDamage`; `hullScar` → `patchHull` underway with a kit aboard, `plateHull` at port with a
 * plate aboard; `hullDamaged` → commerce's `buyParts` (`buySpec`); `compartmentToCheck` →
 * `checkCompartment`. Merged by `systems/work/` with the other systems' rules.
 *
 * Gate stub: no tasks.
 *
 * Owner: W2 of ship life slice 5.
 */
import type { TaskDerivationTable } from "../../core/types/work";

export const damageTaskDerivations: Pick<
  TaskDerivationTable,
  "machineDamaged" | "hullScar" | "hullDamaged" | "compartmentToCheck"
> = {
  machineDamaged: () => [],
  hullScar: () => [],
  hullDamaged: () => [],
  compartmentToCheck: () => [],
};
