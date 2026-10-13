/**
 * §strike-lever (D106): the narrator's `strike`, one hit through the one damage entry point
 * (`applyDamage`), so the body rules decide whether the person goes down or dies and the bleeding,
 * healing and incapacity that follow are the bodies system's. Valid for a living person on the
 * ship's floor or the site's (on deck, or carried there), never someone ashore or off the ship;
 * `byActorId`, when given, is someone living. Apply emits `struck` (narrative, the ticker's `how`
 * line off the fight) before the hit's own events, then the reactions a hit in the fight gets:
 * crew who see a crewmate hurt take `sawCrewHurt` (the party by line of sight in the fight, crew in
 * the same room aboard), and a crew striker whose blow killed takes `killedSomeone`. In the fight
 * the next combat tick takes the down and the dead out (`syncBody`, `combat.ts`). Who sees it is
 * `witness.ts`'s, shared with accidents (§accidents-aboard).
 */
import {
  type ApplyCtx,
  type CommandHandler,
  NO_TEMP_REFS,
  type ValidateCtx,
  causedBy,
  ok,
  reject,
  stepCtxOfApply,
} from "../../core/commands";
import { addThought } from "../../core/thoughts";
import type { Actor } from "../../core/types/actor";
import type { CommandOfKind, CommandRejection } from "../../core/types/commands";
import type { DeepReadonly } from "../../core/types/common";
import { BODY_PARTS, DAMAGE_TYPES, WOUND_SEVERITIES } from "../../core/types/content";
import { STRIKE_HOW_MAX } from "../../core/types/decisions";
import type { ActorId } from "../../core/types/ids";
import { applyDamage } from "./damage";
import { witnessHurt } from "./witness";

const oneOf = (list: readonly string[], value: unknown): boolean =>
  typeof value === "string" && list.includes(value);

/** On the ship's floor or the site's: on deck, or carried by someone who is. */
function onTheFloor(actor: DeepReadonly<Actor>): boolean {
  if (actor.availability === "offShip") return false;
  return actor.location.kind === "onDeck" || actor.location.kind === "carriedBy";
}

/** Why `who` cannot be struck (or strike), or undefined. */
function personProblem(
  ctx: ValidateCtx,
  id: ActorId,
  role: "actorId" | "byActorId",
): string | undefined {
  const actor = ctx.state.actors[id];
  if (actor === undefined) return `${role}: no one "${id}"`;
  if (actor.availability === "dead") return `${role}: ${actor.name} is already dead`;
  if (!onTheFloor(actor)) return `${role}: ${actor.name} is not on the ship or the site`;
  return undefined;
}

function strikeProblem(
  ctx: ValidateCtx,
  command: CommandOfKind<"strike">,
): CommandRejection | undefined {
  const { actorId, severity, type, part, byActorId, how } = command.payload;
  const invalid = (reason: string): CommandRejection => ({ code: "invalidPayload", reason });
  if (!oneOf(WOUND_SEVERITIES, severity)) return invalid(`severity "${String(severity)}"`);
  if (!oneOf(DAMAGE_TYPES, type)) return invalid(`type "${String(type)}"`);
  if (part !== undefined && !oneOf(BODY_PARTS, part)) return invalid(`part "${String(part)}"`);
  if (typeof how !== "string" || how.trim() === "") return invalid("how says what happened");
  if (how.length > STRIKE_HOW_MAX) return invalid(`how is over ${STRIKE_HOW_MAX} characters`);
  const target = personProblem(ctx, actorId, "actorId");
  if (target !== undefined) return { code: "preconditionFailed", reason: target };
  if (byActorId !== undefined) {
    const by = personProblem(ctx, byActorId, "byActorId");
    if (by !== undefined) return { code: "preconditionFailed", reason: by };
  }
  return undefined;
}

export const strike: CommandHandler<"strike", null> = {
  validate(ctx, command) {
    const problem = strikeProblem(ctx, command);
    return problem === undefined ? ok(null) : reject(problem.code, `strike: ${problem.reason}`);
  },
  apply(ctx, command) {
    const { actorId, severity, type, part, byActorId, how } = command.payload;
    const target = ctx.state.actors[actorId];
    if (target === undefined) throw new Error(`strike: validated actor ${actorId} vanished`);
    const inFight = target.combatant !== undefined;
    const by = byActorId === undefined ? {} : { byActorId };
    ctx.emit({
      ...causedBy(command),
      type: "struck",
      subjectIds: byActorId === undefined ? [actorId] : [actorId, byActorId],
      payload: { actorId, severity, type, how: how.trim(), inFight, ...by },
    });
    const step = stepCtxOfApply(ctx);
    const result = applyDamage(step, actorId, {
      severity,
      type,
      ...(part === undefined ? {} : { part }),
      ...by,
      ...(inFight ? {} : { narrated: true as const }),
    });
    if (type !== "stun") witnessHurt(step, target);
    const striker = byActorId === undefined ? undefined : ctx.state.actors[byActorId];
    if (result.died && striker?.crew === true && ctx.content.thoughts.killedSomeone !== undefined) {
      addThought(step, striker, "killedSomeone", actorId);
    }
    return NO_TEMP_REFS;
  },
};
