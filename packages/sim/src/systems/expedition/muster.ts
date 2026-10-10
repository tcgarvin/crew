/**
 * Expeditions A1 (§8.5, plan call 12): the muster. The expedition system hands `muster` to each
 * party member in turn as commerce hands out `lookForWork` (`pendingIntent` `personal` at
 * `essentialOperation`, re-handed until it starts, giving way to survival); the plan walks to the
 * arms locker's `use` position, an `arm` work step whose commit puts the best weapon left in the
 * locker into their hands (blasters to the best `fighting` first, batons next, nothing for the
 * rest), then down to the foot of the personnel ramp.
 *
 * Gate stubs: `handOutMuster` hands nothing out and `musterPlan` is blocked, so nobody musters;
 * `runArm` counts its ticks. `lockerWeapons` is complete (the squad rules read it).
 *
 * Owner after the gate: W2 of expeditions A1.
 */
import { findItemDef } from "../../core/defs";
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly } from "../../core/types/common";
import type { ContentBundle } from "../../core/types/content";
import type { ItemId } from "../../core/types/ids";
import type { ReadonlyWorldState, StepCtx } from "../../core/types/pipeline";
import type { ActivityStep } from "../../core/types/work";
import { shipDeckId } from "../../core/world";
import { type PlanResult, blocked } from "../work/plans";
import type { StepResult } from "../work/steps";

/** A weapon lying in the arms locker. */
export interface LockerWeapon {
  readonly itemId: ItemId;
  readonly kind: "blaster" | "baton";
}

/**
 * The weapons lying on the ship deck's `armsLocker` zones (by item id), blasters first. Empty on a
 * deck without a locker.
 */
export function lockerWeapons(state: ReadonlyWorldState, content: ContentBundle): LockerWeapon[] {
  const deck = content.decks[shipDeckId(state)];
  if (deck === undefined) return [];
  const tiles = new Set(
    deck.zones
      .filter((zone) => zone.tags.includes("armsLocker"))
      .flatMap((zone) => zone.tiles.map((t) => `${t.x},${t.y}`)),
  );
  const out: LockerWeapon[] = [];
  for (const item of Object.values(state.items)) {
    const location = item.location;
    if (location.kind !== "onDeck" || location.deckId !== deck.id) continue;
    if (!tiles.has(`${Math.floor(location.x)},${Math.floor(location.y)}`)) continue;
    const weapon = findItemDef(content, state, item.defId)?.weapon;
    if (weapon !== undefined) out.push({ itemId: item.id, kind: weapon.kind });
  }
  return out.sort((a, b) =>
    a.kind === b.kind
      ? a.itemId.localeCompare(b.itemId, "en", { numeric: true })
      : a.kind === "blaster"
        ? -1
        : 1,
  );
}

/** Hand `muster` to the party members who have not mustered yet. Gate stub: nobody. */
export function handOutMuster(_ctx: StepCtx): void {}

/** The muster's plan for `actor`. Gate stub: blocked, so a stray `muster` intent goes nowhere. */
export function musterPlan(_ctx: StepCtx, _actor: Actor): PlanResult {
  return blocked("unreachableTarget");
}

/**
 * The `arm` work step at the locker. Gate stub: counts its ticks and arms nobody (W2 commits the
 * weapon into their hands on the last tick).
 */
export function runArm(
  _ctx: StepCtx,
  _actor: DeepReadonly<Actor>,
  step: Extract<ActivityStep, { kind: "work" }>,
): StepResult {
  step.ticksDone += 1;
  return step.ticksDone >= step.ticksNeeded ? "done" : "wait";
}
