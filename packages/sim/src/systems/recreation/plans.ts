/**
 * The `recreate` plan (slice 4, calls 12 and 13): an item the activity `requires` is fetched
 * first (slice 3's acquire shape: `moveTo` its believed tile, `pickUp`; one's own `instrument` by
 * `ownerId`, a `book` split off the shelf's stack), then the venue (`resolveVenue`), then the
 * `recreate` step with the intent's `role` and `sessionId`, then the item carried home and
 * `putDown` (an owned item's locker tile, `core/berths.ts` `lockerTileOf`; the first tile of the
 * `bookShelf` zone for a book). `transitOnly` against `state.travel.stage`; `blockedByProblems`
 * against open problems. An item not where believed fails the plan (`inaccessibleSupply`).
 *
 * Owner: W1 of ship life slice 4. Gate stub: blocked (the planner offers no `recreate` yet).
 */
import type { Actor } from "../../core/types/actor";
import type { StepCtx } from "../../core/types/pipeline";
import type { Intent } from "../../core/types/work";
import { type PlanResult, blocked } from "../work/plans";

export function recreatePlan(
  _ctx: StepCtx,
  _actor: Actor,
  _intent: Extract<Intent, { kind: "personal" }>,
): PlanResult {
  return blocked("unreachableTarget");
}
