/**
 * Expeditions A1 test double for the damage entry point (`systems/bodies/damage.ts`
 * `applyDamage`, W1's), so the fight's tests run before bodies land and keep running on a rule of
 * their own: the part from `hit.part`, else the config's part table by a keyed draw; the wound;
 * damage and pain by severity (a stun hit adds `stunPerHit` to `body.stun` instead); capacities;
 * then death by `isDeadBy` or incapacitation by `incapacityOf`, dropping what is in hand. It keeps
 * the body invariants (`bodyViolations`) as the real one does. No bleeding: nothing runs over time.
 */
import { applyCapacities, incapacityOf, isDeadBy } from "../../../core/body";
import { allocateId } from "../../../core/ids";
import { BODY_PARTS, type BodyPart } from "../../../core/types/content";
import type { ActorId } from "../../../core/types/ids";
import type { StepCtx } from "../../../core/types/pipeline";
import type { DamageResult, Hit } from "../../bodies/damage";
import { abortActivity } from "../../work/execute";

function partFor(ctx: StepCtx, actorId: ActorId, hit: Hit): BodyPart {
  if (hit.part !== undefined) return hit.part;
  const table =
    hit.partTable ??
    (hit.type === "stun" ? ctx.config.bodies.stunPartTable : ctx.config.bodies.partTable);
  const total = BODY_PARTS.reduce((sum, p) => sum + table[p], 0);
  let draw = ctx.rng.keyedFloat("failures", `testDamage:${actorId}`, ctx.tick) * total;
  for (const part of BODY_PARTS) {
    draw -= table[part];
    if (draw < 0) return part;
  }
  return "torso";
}

/** The double: wounds by rule, and marks the body down or dead by its thresholds. */
export function testDamage(ctx: StepCtx, actorId: ActorId, hit: Hit): DamageResult {
  const actor = ctx.state.actors[actorId];
  if (actor === undefined) throw new Error(`testDamage: no actor ${actorId}`);
  const bodies = ctx.config.bodies;
  const part = partFor(ctx, actorId, hit);
  const woundId = allocateId(ctx.state, "wound");
  const body = actor.body;
  if (hit.type === "stun") {
    body.stun = Math.min(1, body.stun + bodies.stunPerHit);
  } else {
    body.parts[part].damage += bodies.severityDamage[hit.severity];
    body.pain = Math.min(1, body.pain + bodies.severityPain[hit.severity]);
  }
  body.wounds.push({
    id: woundId,
    part,
    severity: hit.severity,
    type: hit.type,
    bleeding: false,
    tick: ctx.tick,
    ...(hit.byActorId === undefined ? {} : { causeActorId: hit.byActorId }),
  });
  applyCapacities(actor, ctx.config);
  ctx.emit({
    type: "wounded",
    subjectIds: [actorId],
    causeIds: [],
    source: "sim",
    payload: {
      actorId,
      woundId,
      part,
      severity: hit.severity,
      type: hit.type,
      ...(hit.byActorId === undefined ? {} : { byActorId: hit.byActorId }),
    },
  });
  const died = isDeadBy(body, ctx.config);
  const incapacity = died ? undefined : incapacityOf(body, ctx.config);
  if (died || incapacity !== undefined) {
    actor.availability = died ? "dead" : "incapacitated";
    abortActivity(ctx, actor, "incapacitated");
    actor.movement = { kind: "stationary" };
    const at = actor.location;
    for (const item of Object.values(ctx.state.items)) {
      if (item.location.kind !== "carriedBy" || item.location.actorId !== actorId) continue;
      if (at.kind === "onDeck") {
        item.location = { kind: "onDeck", deckId: at.deckId, x: at.x, y: at.y };
        ctx.caches.dirty.inventory = true;
      }
    }
  }
  return { woundId, part, incapacitated: incapacity !== undefined, died };
}
