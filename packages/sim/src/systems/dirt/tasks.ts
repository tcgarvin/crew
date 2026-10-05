/**
 * Task derivation for `compartmentDirty` (D82): one `cleanCompartment` task, `requiredTools:
 * ["mop"]`, target `{ kind: "compartment" }`, `interactionTiles` the room's `mopTilesPerTrip`
 * dirtiest cells at or above half the `untidy` threshold (dirtiest first), progress
 * `{ kind: "room" }`, `estimatedWorkSeconds: mopSecondsPerTile × tiles`, `baseUrgency` the
 * problem's. Merged by `systems/work/` with the other systems' rules.
 *
 * Gate stub: derives nothing.
 *
 * Owner: W2 of ship life slice 3.
 */
import type { DeriveTasks } from "../../core/types/work";

const deriveCompartmentDirty: DeriveTasks<"compartmentDirty"> = () => [];

export const dirtTaskDerivations = {
  compartmentDirty: deriveCompartmentDirty,
};
