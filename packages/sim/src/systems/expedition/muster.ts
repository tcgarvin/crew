/**
 * Expeditions A1 (§8.5, plan call 12): the muster. The expedition system hands `muster` to each
 * party member in turn as commerce hands out `lookForWork` (`pendingIntent` `personal` at
 * `essentialOperation`, re-handed until it starts, giving way to survival); the plan walks to the
 * arms locker's `use` position, an `arm` work step whose commit puts the best weapon left in the
 * locker into their hands (blasters to the best `fighting` first, batons next, nothing for the
 * rest), then down to the foot of the personnel ramp.
 *
 * Arming makes them a combatant (side `us`, their disposition from `partyDisposition`); the
 * expedition system puts them into the fight when they stand on the site floor.
 *
 * Owner after the gate: W2 of expeditions A1.
 */
import { configTicks } from "../../core/clock";
import { findItemDef } from "../../core/defs";
import { isOnDock } from "../../core/docks";
import { rampFoot } from "../../core/sites";
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly } from "../../core/types/common";
import type { ContentBundle } from "../../core/types/content";
import type { ItemId, MachineId } from "../../core/types/ids";
import type { ReadonlyWorldState, StepCtx } from "../../core/types/pipeline";
import type { ActivityStep } from "../../core/types/work";
import { shipDeckId } from "../../core/world";
import { type PlanResult, blocked, interactionTarget, planOf } from "../work/plans";
import type { StepResult } from "../work/steps";
import { initialState, partyDisposition } from "./morale";

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

/** The arms locker's machine on the ship deck, if there is one. */
function lockerMachine(ctx: StepCtx): MachineId | undefined {
  const deckId = shipDeckId(ctx.state);
  return Object.values(ctx.state.machines)
    .filter(
      (m) =>
        m.deckId === deckId && ctx.content.machines[m.defId]?.tags.includes("armsLocker") === true,
    )
    .map((m) => m.id)
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))[0];
}

function inActivity(actor: DeepReadonly<Actor>, activity: "muster" | "fight"): boolean {
  return actor.activity.kind === "personal" && actor.activity.activity === activity;
}

/**
 * Hand `muster` to every party member who is not yet ashore in the fight: as commerce hands out
 * `lookForWork`, a `personal` intent at `essentialOperation`, written every tick until it starts
 * (the planner may overwrite a pending intent on its tick), giving way to survival. Nobody is sent
 * before there is a plan (call 11), after the party is called back, or once they broke.
 */
export function handOutMuster(ctx: StepCtx): void {
  const expedition = ctx.state.expedition;
  if (expedition === undefined || expedition.plan === undefined) return;
  if (expedition.phase === "resolved" || expedition.withdrawTick !== undefined) return;
  for (const id of expedition.party) {
    const actor = ctx.state.actors[id];
    if (actor === undefined || actor.availability !== "available") continue;
    if (inActivity(actor, "muster") || inActivity(actor, "fight")) continue;
    const combatant = actor.combatant;
    if (combatant !== undefined && combatant.state !== "steady" && combatant.state !== "wavering") {
      continue;
    }
    if (actor.activity.kind !== "idle" && actor.activity.urgency === "immediateSurvival") continue;
    if (isOnDock(ctx.content, ctx.state, actor.location)) continue;
    actor.pendingIntent = {
      kind: "personal",
      activity: "muster",
      urgency: "essentialOperation",
      trace: { candidates: 0, chosenReason: "mustering for the expedition", rejected: [] },
    };
  }
}

/**
 * The muster's plan for `actor`: to the arms locker's `use` position, the `arm` step, then down to
 * the foot of the personnel ramp. Someone already armed (a combatant) only walks down. Blocked
 * for anyone not in the party, with no ramp foot, or no locker.
 */
export function musterPlan(ctx: StepCtx, actor: Actor): PlanResult {
  const expedition = ctx.state.expedition;
  if (expedition === undefined || !expedition.party.includes(actor.id)) {
    return blocked("dependencyPending");
  }
  const foot = rampFoot(ctx.content, ctx.state);
  if (foot === undefined) return blocked("rampClosed");
  const down: ActivityStep = { kind: "moveTo", target: foot, requested: false };
  if (actor.combatant !== undefined) return planOf([down]);
  const locker = lockerMachine(ctx);
  const at = locker === undefined ? undefined : interactionTarget(ctx, actor, locker, "use");
  if (at === undefined) return blocked("unreachableTarget");
  return planOf([
    { kind: "moveTo", target: at, requested: false },
    {
      kind: "work",
      stage: "arm",
      ticksDone: 0,
      ticksNeeded: configTicks(ctx.config, ARM_SECONDS),
    },
    down,
  ]);
}

/** How long taking a weapon from the locker takes. */
export const ARM_SECONDS = 2;

/**
 * The `arm` work step at the locker. On its last tick the best weapon left goes into their hands:
 * among the party not yet armed, ranked by `fighting` (ties by id), the top as many as there are
 * blasters left take a blaster, the next as many as batons a baton, the rest nothing, so whoever
 * reaches the locker first never takes what a better fighter should have. They join the fight's
 * roll (`combatant`, side `us`) whatever they carry.
 */
export function runArm(
  ctx: StepCtx,
  actor: DeepReadonly<Actor>,
  step: Extract<ActivityStep, { kind: "work" }>,
): StepResult {
  step.ticksDone += 1;
  if (step.ticksDone < step.ticksNeeded) return "wait";
  const expedition = ctx.state.expedition;
  const self = ctx.state.actors[actor.id];
  if (expedition === undefined || self === undefined || self.combatant !== undefined) return "done";
  const unarmed = expedition.party
    .map((id) => ctx.state.actors[id])
    .filter((a): a is Actor => a !== undefined && a.combatant === undefined)
    .sort(
      (a, b) =>
        (b.skills.fighting ?? 0) - (a.skills.fighting ?? 0) ||
        a.id.localeCompare(b.id, "en", { numeric: true }),
    );
  const rank = unarmed.findIndex((a) => a.id === self.id);
  const weapons = lockerWeapons(ctx.state, ctx.content);
  const blasters = weapons.filter((w) => w.kind === "blaster");
  const batons = weapons.filter((w) => w.kind === "baton");
  const pick =
    rank < blasters.length
      ? blasters[0]
      : rank < blasters.length + batons.length
        ? batons[0]
        : undefined;
  if (pick !== undefined) {
    const item = ctx.state.items[pick.itemId];
    if (item !== undefined) {
      item.location = { kind: "carriedBy", actorId: self.id };
      ctx.caches.dirty.inventory = true;
    }
  }
  const disposition = partyDisposition(ctx.state, ctx.config, self, expedition.leaderId);
  const every = configTicks(ctx.config, ctx.config.expedition.decideEverySeconds);
  const index = expedition.party.indexOf(self.id);
  self.combatant = {
    side: "us",
    disposition,
    state: initialState(disposition.resolveBase, ctx.config.expedition.morale),
    resolve: disposition.resolveBase,
    // Staggered by their place in the party, as the planner staggers.
    lastDecidedTick: ctx.tick - (Math.max(0, index) % Math.max(1, every)),
  };
  return "done";
}
