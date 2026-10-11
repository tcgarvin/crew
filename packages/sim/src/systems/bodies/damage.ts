/**
 * Expeditions A1 (§7.1): the one damage entry point. `applyDamage` picks the part (`hit.part`,
 * else `hit.partTable`, else `config.bodies.partTable`, or `stunPartTable` for a stun hit, on the
 * `failures` stream), writes the wound, adds damage and pain (a stun hit adds `stunPerHit` to
 * `body.stun` instead, and no damage or pain), recomputes capacities, then commits death
 * (`isDeadBy`) or incapacitation (`incapacityOf`) at once, dropping what is in hand, and emits
 * `wounded` (always), then `died` or `incapacitated`. The formulas are `core/body.ts`'s.
 *
 * Owner: W1 of expeditions A1.
 */
import { applyCapacities, bleedsOnHit, incapacityOf, isDeadBy } from "../../core/body";
import { allocateId } from "../../core/ids";
import { addThought } from "../../core/thoughts";
import type { Actor, Wound } from "../../core/types/actor";
import {
  BODY_PARTS,
  type BodyPart,
  type DamageType,
  type WoundSeverity,
} from "../../core/types/content";
import type { ActorId, WoundId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import { emitSim } from "../work/events";
import { goDown, woundCause } from "./down";

/** One hit on a body. */
export interface Hit {
  /** Where it lands; absent, drawn from `partTable` (or the config's tables). */
  readonly part?: BodyPart;
  readonly severity: WoundSeverity;
  readonly type: DamageType;
  /** Who did it, when someone did. */
  readonly byActorId?: ActorId;
  /** Relative weights for where it lands; absent, the config's (`partTable`/`stunPartTable`). */
  readonly partTable?: Readonly<Record<BodyPart, number>>;
  /**
   * §strike-lever: the narrator's strike off the fight, whose `struck` line tells what happened;
   * `wounded` carries it so the ticker does not tell it twice.
   */
  readonly narrated?: true;
}

/** What a hit did: the wound it made and whether it took the person down or killed them. */
export interface DamageResult {
  readonly woundId: WoundId;
  readonly part: BodyPart;
  readonly incapacitated: boolean;
  readonly died: boolean;
}

/**
 * Wound `actorId` with `hit`. Throws for an actor who does not exist or is already dead (the
 * caller picks living targets). A hit on someone already down adds to their wounds and may kill
 * them; it does not take them down twice.
 */
export function applyDamage(ctx: StepCtx, actorId: ActorId, hit: Hit): DamageResult {
  const actor = ctx.state.actors[actorId];
  if (actor === undefined) throw new Error(`applyDamage: no actor ${actorId}`);
  if (actor.availability === "dead") throw new Error(`applyDamage: ${actorId} is already dead`);
  const part = hit.part ?? drawPart(ctx, hit);
  const wound = writeWound(ctx, actor, part, hit);
  const by = hit.byActorId === undefined ? {} : { byActorId: hit.byActorId };
  emitSim(ctx, "wounded", subjects(actor.id, hit.byActorId), {
    actorId: actor.id,
    woundId: wound.id,
    part,
    severity: hit.severity,
    type: hit.type,
    ...by,
    ...(hit.narrated === true ? { narrated: true as const } : {}),
  });
  if (wound.type !== "stun") addThought(ctx, actor, "wounded");
  if (isDeadBy(actor.body, ctx.config)) {
    goDown(ctx, actor, "dead");
    emitSim(ctx, "died", subjects(actor.id, hit.byActorId), {
      actorId: actor.id,
      cause: woundCause(actor.body, ctx.config),
      ...by,
    });
    return { woundId: wound.id, part, incapacitated: false, died: true };
  }
  const incapacity = incapacityOf(actor.body, ctx.config);
  if (incapacity !== undefined && actor.availability !== "incapacitated") {
    goDown(ctx, actor, "incapacitated");
    emitSim(ctx, "incapacitated", [actor.id], { actorId: actor.id, cause: incapacity });
  }
  return {
    woundId: wound.id,
    part,
    incapacitated: actor.availability === "incapacitated",
    died: false,
  };
}

/** Where an unaimed hit lands: the hit's table, else the config's (stun's for a stun hit). */
function drawPart(ctx: StepCtx, hit: Hit): BodyPart {
  const bodies = ctx.config.bodies;
  const table = hit.partTable ?? (hit.type === "stun" ? bodies.stunPartTable : bodies.partTable);
  const items = BODY_PARTS.map((part) => ({ item: part, weight: table[part] }));
  return ctx.rng.weighted("failures", items);
}

/** The wound itself and what it does to the body at once: damage and pain, or stun. */
function writeWound(ctx: StepCtx, actor: Actor, part: BodyPart, hit: Hit): Wound {
  const bodies = ctx.config.bodies;
  const body = actor.body;
  const wound: Wound = {
    id: allocateId(ctx.state, "wound"),
    part,
    severity: hit.severity,
    type: hit.type,
    bleeding: bleedsOnHit(hit.type, hit.severity),
    tick: ctx.tick,
    ...(hit.byActorId === undefined ? {} : { causeActorId: hit.byActorId }),
  };
  body.wounds.push(wound);
  if (hit.type === "stun") {
    body.stun = Math.min(1, body.stun + bodies.stunPerHit);
  } else {
    body.parts[part].damage += bodies.severityDamage[hit.severity];
    body.pain = Math.min(1, body.pain + bodies.severityPain[hit.severity]);
  }
  applyCapacities(actor, ctx.config);
  return wound;
}

function subjects(actorId: ActorId, byActorId: ActorId | undefined): readonly ActorId[] {
  return byActorId === undefined ? [actorId] : [actorId, byActorId];
}
