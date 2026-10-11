/**
 * §strike-lever (D106): the narrator's `strike`, one hit through the one damage entry point
 * (`applyDamage`), so the body rules decide whether the person goes down or dies and the bleeding,
 * healing and incapacity that follow are the bodies system's. Valid for a living person on the
 * ship's floor or the site's (on deck, or carried there), never someone ashore or off the ship;
 * `byActorId`, when given, is someone living. Apply emits `struck` (narrative, the ticker's `how`
 * line off the fight) before the hit's own events, then the reactions a hit in the fight gets:
 * crew who see a crewmate hurt take `sawCrewHurt` (the party by line of sight in the fight, crew in
 * the same room aboard), and a crew striker whose blow killed takes `killedSomeone`. In the fight
 * the next combat tick takes the down and the dead out (`syncBody`, `combat.ts`).
 */
import {
  type ApplyCtx,
  type CommandHandler,
  NO_TEMP_REFS,
  type ValidateCtx,
  causedBy,
  ok,
  reject,
} from "../../core/commands";
import { addThought } from "../../core/thoughts";
import type { Actor } from "../../core/types/actor";
import type { CommandOfKind, CommandRejection } from "../../core/types/commands";
import type { DeepReadonly } from "../../core/types/common";
import { BODY_PARTS, DAMAGE_TYPES, WOUND_SEVERITIES } from "../../core/types/content";
import { STRIKE_HOW_MAX } from "../../core/types/decisions";
import type { ActorId, CompartmentId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import { groundOf, onSite, tileOfActor } from "../expedition/ground";
import { lineOfSight } from "../expedition/los";
import { upright } from "../expedition/morale";
import { applyDamage } from "./damage";

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

/** A command applies outside any system's run: no cadence, the caches' dirty flags. */
function stepCtxOf(ctx: ApplyCtx): StepCtx {
  return { ...ctx, elapsedTicks: 0, dirty: ctx.caches.dirty };
}

/** The room `actorId` stands in aboard, by the actor index. */
function roomOf(ctx: ApplyCtx, actorId: ActorId): CompartmentId | undefined {
  const index = ctx.caches.index.actorsByCompartment;
  for (const [room, ids] of Object.entries(index)) {
    if (ids.includes(actorId)) return room as CompartmentId;
  }
  return undefined;
}

/**
 * Crew who see `hurt` (a crew member) hit: in the fight, the party on their feet on the site floor
 * with a line of sight, as a shot's hit (`combat.ts`); aboard, the crew on their feet in the room.
 */
function witnesses(ctx: ApplyCtx, hurt: Actor): Actor[] {
  const others = Object.values(ctx.state.actors).filter(
    (a) => a.id !== hurt.id && a.crew && a.passenger !== true && a.availability === "available",
  );
  const ground = hurt.combatant === undefined ? undefined : groundOf(ctx);
  if (ground !== undefined) {
    const at = tileOfActor(ctx.state, hurt);
    if (at === undefined) return [];
    return others.filter((friend) => {
      const c = friend.combatant;
      if (c?.side !== "us" || !upright(c) || !onSite(ctx, friend)) return false;
      const from = tileOfActor(ctx.state, friend);
      return from !== undefined && lineOfSight(ground.berth, from, at);
    });
  }
  const room = roomOf(ctx, hurt.id);
  if (room === undefined) return [];
  const here = ctx.caches.index.actorsByCompartment[room] ?? [];
  return others.filter((friend) => here.includes(friend.id));
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
    const step = stepCtxOf(ctx);
    const result = applyDamage(step, actorId, {
      severity,
      type,
      ...(part === undefined ? {} : { part }),
      ...by,
      ...(inFight ? {} : { narrated: true as const }),
    });
    const seen = ctx.content.thoughts.sawCrewHurt !== undefined;
    if (seen && target.crew && target.passenger !== true && type !== "stun") {
      for (const friend of witnesses(ctx, target)) addThought(step, friend, "sawCrewHurt", actorId);
    }
    const striker = byActorId === undefined ? undefined : ctx.state.actors[byActorId];
    if (result.died && striker?.crew === true && ctx.content.thoughts.killedSomeone !== undefined) {
      addThought(step, striker, "killedSomeone", actorId);
    }
    return NO_TEMP_REFS;
  },
};
