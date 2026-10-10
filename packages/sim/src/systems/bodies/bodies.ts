/**
 * Expeditions A1 (§7.1): the bodies system, phase `needs` after `needs.needs`, every
 * `BODIES_EVERY_TICKS`. For everyone not dead: bleeding wounds take `bleedPerSecond` off blood
 * until they stop on their own (`woundHealsFromTick`), blood recovers while nothing bleeds, pain
 * and stun decay, wounds heal and close (`woundHealed`); then death (blood loss kills later than
 * the shot) and incapacity are re-checked, and someone down whose consciousness and movement are
 * back above the floors is `available` again (when a wound shows the body put them down). The
 * `wounded` thought is kept while a wound is open, and capacities are rewritten for everyone (plan
 * call 5: needs wrote the crew it steps earlier this tick from the body as it was). The formulas
 * are `core/body.ts`'s.
 *
 * Owner: W1 of expeditions A1.
 */
import {
  applyCapacities,
  bleedsOnHit,
  incapacityOf,
  isDeadBy,
  woundDamage,
  woundHealsFromTick,
} from "../../core/body";
import { dayTicks } from "../../core/clock";
import { addThought } from "../../core/thoughts";
import type { Actor, Wound } from "../../core/types/actor";
import type { Tick } from "../../core/types/common";
import { BODY_PARTS } from "../../core/types/content";
import type { ActorId } from "../../core/types/ids";
import type { StepCtx, System } from "../../core/types/pipeline";
import { emitSim } from "../work/events";
import { goDown, woundCause } from "./down";

/** Half a second at 20 Hz: blood and pain move slowly, and death by blood is a threshold. */
export const BODIES_EVERY_TICKS = 10;

export const bodiesSystem: System = {
  name: "bodies.bodies",
  phase: "needs",
  every: BODIES_EVERY_TICKS,
  run(ctx) {
    for (const actor of Object.values(ctx.state.actors)) {
      if (actor.availability === "dead") continue;
      stepBody(ctx, actor);
      applyCapacities(actor, ctx.config);
      recheck(ctx, actor);
    }
  },
};

/** Blood, pain, stun and healing over the `elapsedTicks` that ended at `ctx.tick`. */
function stepBody(ctx: StepCtx, actor: Actor): void {
  const { bodies, time } = ctx.config;
  const body = actor.body;
  const from = ctx.tick - ctx.elapsedTicks;
  const dt = ctx.elapsedTicks / time.tickRate;
  let blood = body.blood;
  let lastBleedTick: Tick = Number.NEGATIVE_INFINITY;
  for (const wound of body.wounds) {
    if (!wound.bleeding) continue;
    const stops = woundHealsFromTick(wound, ctx.config);
    const bledTicks = Math.max(0, Math.min(ctx.tick, stops) - Math.max(from, wound.tick));
    blood -= bodies.bleedPerSecond[wound.severity] * (bledTicks / time.tickRate);
    lastBleedTick = Math.max(lastBleedTick, Math.min(ctx.tick, stops));
    if (ctx.tick >= stops) wound.bleeding = false;
  }
  if (!body.wounds.some((wound) => wound.bleeding)) {
    const dryTicks = ctx.tick - Math.max(from, lastBleedTick);
    blood += bodies.bloodRecoverPerSecond * (dryTicks / time.tickRate);
  }
  body.blood = clamp01(blood);
  body.pain = Math.max(0, body.pain - bodies.painDecayPerSecond * dt);
  body.stun = Math.max(0, body.stun - bodies.stunDecayPerSecond * dt);
  heal(ctx, actor);
  if (body.wounds.some((wound) => wound.type !== "stun")) keepWoundedThought(ctx, actor);
}

/**
 * Part damage is the sum of the open wounds' (`woundDamage`); a wound that has healed to nothing
 * closes, and a stun wound closes once the body's stun is gone.
 */
function heal(ctx: StepCtx, actor: Actor): void {
  const body = actor.body;
  const damage = Object.fromEntries(BODY_PARTS.map((part) => [part, 0]));
  const open: Wound[] = [];
  for (const wound of body.wounds) {
    const left = woundDamage(wound, ctx.tick, ctx.config);
    const closed = wound.type === "stun" ? body.stun === 0 : left === 0 && !wound.bleeding;
    if (closed) {
      emitSim(ctx, "woundHealed", [actor.id], { actorId: actor.id, woundId: wound.id });
      continue;
    }
    open.push(wound);
    damage[wound.part] = (damage[wound.part] ?? 0) + left;
  }
  if (open.length !== body.wounds.length) body.wounds = open;
  for (const part of BODY_PARTS) {
    const next = damage[part] ?? 0;
    if (body.parts[part].damage !== next) body.parts[part].damage = next;
  }
}

/**
 * The `wounded` thought lasts its duration past the last moment a wound was open: held, its
 * expiry is pushed on quietly (it is the same thought, not a new one); absent, it is had anew.
 */
function keepWoundedThought(ctx: StepCtx, actor: Actor): void {
  const held = actor.thoughts.find((thought) => thought.key === "wounded");
  if (held === undefined) {
    addThought(ctx, actor, "wounded");
    return;
  }
  const def = ctx.content.thoughts.wounded;
  if (def === undefined) throw new Error('bodies: content has no thought "wounded"');
  held.expiresAtTick = Math.max(
    held.expiresAtTick,
    ctx.tick + dayTicks(ctx.config, def.durationDays),
  );
}

/** Death by blood, going down, and getting up again. */
function recheck(ctx: StepCtx, actor: Actor): void {
  if (isDeadBy(actor.body, ctx.config)) {
    const byActorId = lastBleederCause(actor.body.wounds);
    goDown(ctx, actor, "dead");
    emitSim(ctx, "died", byActorId === undefined ? [actor.id] : [actor.id, byActorId], {
      actorId: actor.id,
      cause: woundCause(actor.body, ctx.config),
      ...(byActorId === undefined ? {} : { byActorId }),
    });
    return;
  }
  const incapacity = incapacityOf(actor.body, ctx.config);
  if (actor.availability === "available" && incapacity !== undefined) {
    goDown(ctx, actor, "incapacitated");
    emitSim(ctx, "incapacitated", [actor.id], { actorId: actor.id, cause: incapacity });
  } else if (
    actor.availability === "incapacitated" &&
    incapacity === undefined &&
    actor.body.wounds.length > 0
  ) {
    // Only the body's own incapacity is lifted here: someone down with no wound on them (a
    // stun or a bleed leaves one open long after they are up) was put down by something else.
    actor.availability = "available";
  }
}

/** Who made the latest wound that bled, if anyone did: blood loss is put down to them. */
function lastBleederCause(wounds: readonly Wound[]): ActorId | undefined {
  let latest: Wound | undefined;
  for (const wound of wounds) {
    if (!bleedsOnHit(wound.type, wound.severity)) continue;
    if (latest === undefined || wound.tick >= latest.tick) latest = wound;
  }
  return latest?.causeActorId;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
