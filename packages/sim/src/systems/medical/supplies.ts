/**
 * §medical-supplies: the `medical` units aboard, every such def counted, as the narrator's digest
 * shows them against `medical.reserve`.
 */
import type { ContentBundle } from "../../core/types/content";
import type { ReadonlyWorldState } from "../../core/types/pipeline";
import { unitsAboard } from "../equipment/supplies";

export function medicalUnitsAboard(
  state: Pick<ReadonlyWorldState, "items" | "jobs">,
  content: Pick<ContentBundle, "items">,
): number {
  let units = 0;
  for (const [defId, count] of unitsAboard(state)) {
    if (content.items[defId]?.tags.includes("medical") === true) units += count;
  }
  return units;
}
