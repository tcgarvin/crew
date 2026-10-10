/**
 * Expeditions A1 (§8.1): what a combatant does with a decision, as primitives the combat loop
 * (`combat.ts`) composes into the seven actions (`takeCover`, `advance`, `fire`, `melee`,
 * `guardPassage`, `retreat`, `rescue`): walking through `systems/spatial/movement.ts`
 * `requestMove`/`stopMovement`, lining up a shot, and the `fight` activity with its label.
 *
 * The `fight` activity (call 6) is a personal activity the planner keeps out of and work does not
 * step; its action is a `wait` that nothing interrupts, and its `label` is what the combat system
 * last decided ("in cover", "firing", "advancing", ...).
 *
 * Owner after the gate: W2 of expeditions A1.
 */
import { findItemDef } from "../../core/defs";
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly, TileCoord } from "../../core/types/common";
import type { WeaponDef } from "../../core/types/content";
import type { ActorId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import { requestMove, stopMovement } from "../spatial/movement";
import { releaseReservations } from "../spatial/reservations";
import { abortActivity } from "../work/execute";

export const COMBAT_ACTIONS = [
  "takeCover",
  "advance",
  "fire",
  "melee",
  "guardPassage",
  "retreat",
  "rescue",
] as const;
export type CombatAction = (typeof COMBAT_ACTIONS)[number];

/** §8.1: someone with nothing in hand fights with their fists: a weak baton that grazes. */
export const FISTS: WeaponDef = {
  kind: "baton",
  range: 1,
  aimSeconds: 0.6,
  hit: 0.5,
  severity: "graze",
  damageType: "blunt",
  stun: false,
};

/** The weapon in `actor`'s hands, if any (the first by item id). */
export function heldWeapon(
  ctx: Pick<StepCtx, "state" | "content">,
  actor: DeepReadonly<Actor>,
): WeaponDef | undefined {
  const held = Object.values(ctx.state.items)
    .filter((i) => i.location.kind === "carriedBy" && i.location.actorId === actor.id)
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  for (const item of held) {
    const weapon = findItemDef(ctx.content, ctx.state, item.defId)?.weapon;
    if (weapon !== undefined) return weapon;
  }
  return undefined;
}

/** Is `actor` in the `fight` activity? */
export function inFight(actor: DeepReadonly<Actor>): boolean {
  return actor.activity.kind === "personal" && actor.activity.activity === "fight";
}

/** Put `actor` into the `fight` activity (ending whatever they were doing), labelled `label`. */
export function enterFight(ctx: StepCtx, actor: Actor, label: string): void {
  if (inFight(actor)) {
    setLabel(actor, label);
    return;
  }
  abortActivity(ctx, actor, "interrupted");
  // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
  delete actor.pendingIntent;
  actor.activity = {
    kind: "personal",
    activity: "fight",
    urgency: "essentialOperation",
    action: {
      kind: "wait",
      stage: "waiting",
      progress: 0,
      startedTick: ctx.tick,
      interruptible: false,
    },
    sinceTick: ctx.tick,
    label,
  };
}

/** Write the fight label the HUD shows. */
export function setLabel(actor: Actor, label: string): void {
  const activity = actor.activity;
  if (activity.kind === "personal" && activity.activity === "fight" && activity.label !== label) {
    activity.label = label;
  }
}

/** The tile `actor` is walking to, if they are walking. */
export function destination(actor: DeepReadonly<Actor>): TileCoord | undefined {
  const movement = actor.movement;
  return movement.kind === "moving" ? movement.path[movement.path.length - 1] : undefined;
}

/**
 * Walk to `tile` (a no-op when already walking there or standing on it). False when no route is
 * known, leaving the actor where they are.
 */
export function goTo(ctx: StepCtx, actor: Actor, tile: TileCoord): boolean {
  const going = destination(actor);
  if (going !== undefined && going.x === tile.x && going.y === tile.y) return true;
  const location = actor.location;
  if (
    going === undefined &&
    location.kind === "onDeck" &&
    Math.floor(location.x) === tile.x &&
    Math.floor(location.y) === tile.y
  ) {
    return true;
  }
  return requestMove(ctx.state, actor.id, tile, ctx.caches, ctx.config);
}

/** Stop walking (at the next tile centre). */
export function halt(ctx: StepCtx, actor: Actor): void {
  if (actor.movement.kind === "moving") stopMovement(ctx.state, ctx.caches, actor.id);
}

/** Line up a shot at `targetId` (kept if already lining one up at them). */
export function aimAt(ctx: StepCtx, actor: Actor, targetId: ActorId): void {
  const combatant = actor.combatant;
  if (combatant === undefined || combatant.aim?.targetId === targetId) return;
  combatant.aim = { targetId, sinceTick: ctx.tick };
}

/** Stop lining up a shot. */
export function lowerAim(actor: Actor): void {
  // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
  if (actor.combatant?.aim !== undefined) delete actor.combatant.aim;
}

/** `rescue`: `carrier` takes up `carried`, who goes `carriedBy` them. */
export function pickUp(ctx: StepCtx, carrier: Actor, carried: Actor): void {
  halt(ctx, carried);
  releaseReservations(ctx.caches, carried.id);
  carried.movement = { kind: "stationary" };
  carried.location = { kind: "carriedBy", actorId: carrier.id };
}

/** `rescue`: set `carried` down where `carrier` stands. */
export function setDown(carrier: DeepReadonly<Actor>, carried: Actor): void {
  const at = carrier.location;
  if (at.kind !== "onDeck") return;
  carried.location = { kind: "onDeck", deckId: at.deckId, x: at.x, y: at.y };
}

/** Who `carrier` has in their arms, if anyone. */
export function carriedBy(ctx: Pick<StepCtx, "state">, carrierId: ActorId): Actor | undefined {
  return Object.values(ctx.state.actors).find(
    (a) => a.location.kind === "carriedBy" && a.location.actorId === carrierId,
  );
}
