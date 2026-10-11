/**
 * §memory-levers, §thought-and-reveal-levers (D106): the narrator's `plantMemory`, `fallOut` and
 * `giveThought`, through the social system's own memories (`plantMemory`, `addMemory`) and the
 * thoughts (`addThought`). Guards are the impossible only: the people exist, are alive and aboard
 * (crew or passengers, not off the ship), a pair is two people, the key is one the set has.
 *
 * - `plantMemory` emits `memoryPlanted` (notable, no ticker line) and the `affinityChanged` the
 *   memory makes.
 * - `fallOut` plants `wrongedOverSomeone` both ways and runs a debate's argument (`argue`: the
 *   `argued` thought and memory both ways), then emits `argument` with its `over`, whose ticker line
 *   is "Jax Okonkwo and Priya Kessler have fallen out over Ysolde Maren".
 * - `giveThought` adds the thought as the sim would and emits `thoughtGiven` (notable, no line).
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
import { NARRATOR_MEMORY_KEYS } from "../../core/types/content";
import { FALL_OUT_OVER_MAX } from "../../core/types/decisions";
import type { ActorId } from "../../core/types/ids";
import { argue } from "./outcomes";
import { plantMemory as plant } from "./relationships";

const invalid = (reason: string): CommandRejection => ({ code: "invalidPayload", reason });
const precondition = (reason: string): CommandRejection => ({
  code: "preconditionFailed",
  reason,
});

/** Why `id` cannot feel or be felt about by a lever, or undefined: nobody, the dead, off the ship. */
function aboardProblem(ctx: ValidateCtx, id: ActorId, role: string): CommandRejection | undefined {
  const actor: DeepReadonly<Actor> | undefined = ctx.state.actors[id];
  if (actor === undefined) return { code: "unknownEntity", reason: `${role}: no one "${id}"` };
  if (actor.availability === "dead") return precondition(`${role}: ${actor.name} is dead`);
  if (!actor.crew) return precondition(`${role}: ${actor.name} is not crew or a passenger`);
  if (actor.availability === "offShip") {
    return precondition(`${role}: ${actor.name} is not aboard`);
  }
  return undefined;
}

/** Why two people cannot be a pair for a lever, or undefined. */
function pairProblem(
  ctx: ValidateCtx,
  a: ActorId,
  b: ActorId,
  roles: readonly [string, string],
): CommandRejection | undefined {
  if (a === b) return invalid(`${roles[0]} and ${roles[1]} are the same person`);
  return aboardProblem(ctx, a, roles[0]) ?? aboardProblem(ctx, b, roles[1]);
}

function handlerOf<K extends "plantMemory" | "fallOut" | "giveThought">(
  kind: K,
  problem: (ctx: ValidateCtx, command: CommandOfKind<K>) => CommandRejection | undefined,
  apply: (ctx: ApplyCtx, command: CommandOfKind<K>) => void,
): CommandHandler<K, null> {
  return {
    validate(ctx, command) {
      const found = problem(ctx, command);
      return found === undefined ? ok(null) : reject(found.code, `${kind}: ${found.reason}`);
    },
    apply(ctx, command) {
      apply(ctx, command);
      return NO_TEMP_REFS;
    },
  };
}

export const plantMemory = handlerOf(
  "plantMemory",
  (ctx, command) => {
    const { fromActorId, toActorId, key, lasting } = command.payload;
    if (!(NARRATOR_MEMORY_KEYS as readonly string[]).includes(key)) {
      return invalid(`"${String(key)}" is not a memory the narrator plants`);
    }
    if (typeof lasting !== "boolean") return invalid("lasting must be true or false");
    return pairProblem(ctx, fromActorId, toActorId, ["from", "to"]);
  },
  (ctx, command) => {
    const { fromActorId, toActorId, key, lasting } = command.payload;
    plant(stepCtxOfApply(ctx), fromActorId, toActorId, key, lasting);
    ctx.emit({
      ...causedBy(command),
      type: "memoryPlanted",
      subjectIds: [fromActorId, toActorId],
      payload: { fromActorId, toActorId, key, lasting },
    });
  },
);

export const fallOut = handlerOf(
  "fallOut",
  (ctx, command) => {
    const { aId, bId, over } = command.payload;
    if (typeof over !== "string" || over.trim() === "") return invalid("over says what it is over");
    if (over.length > FALL_OUT_OVER_MAX) {
      return invalid(`over is over ${FALL_OUT_OVER_MAX} characters`);
    }
    return pairProblem(ctx, aId, bId, ["a", "b"]);
  },
  (ctx, command) => {
    const { aId, bId, over } = command.payload;
    const a = ctx.state.actors[aId];
    const b = ctx.state.actors[bId];
    if (a === undefined || b === undefined) throw new Error("fallOut: a validated actor vanished");
    const step = stepCtxOfApply(ctx);
    plant(step, aId, bId, "wrongedOverSomeone", false);
    plant(step, bId, aId, "wrongedOverSomeone", false);
    argue(step, a, b);
    ctx.emit({
      ...causedBy(command),
      type: "argument",
      subjectIds: [aId, bId],
      payload: { aId, bId, over: over.trim() },
    });
  },
);

export const giveThought = handlerOf(
  "giveThought",
  (ctx, command) => {
    const { actorId, key, refId } = command.payload;
    const def = ctx.content.thoughts[key];
    if (def === undefined) return invalid(`no thought "${String(key)}"`);
    const who = aboardProblem(ctx, actorId, "actorId");
    if (who !== undefined) return who;
    if (refId === undefined) {
      return def.label.includes("{ref}")
        ? invalid(`"${key}" is about someone; name them`)
        : undefined;
    }
    return refId in ctx.state.actors
      ? undefined
      : { code: "unknownEntity", reason: `refId: no one "${refId}"` };
  },
  (ctx, command) => {
    const { actorId, key, refId } = command.payload;
    const actor = ctx.state.actors[actorId];
    if (actor === undefined) throw new Error(`giveThought: validated actor ${actorId} vanished`);
    addThought(stepCtxOfApply(ctx), actor, key, refId);
    ctx.emit({
      ...causedBy(command),
      type: "thoughtGiven",
      subjectIds: refId === undefined ? [actorId] : [actorId, refId],
      payload: { actorId, key, ...(refId === undefined ? {} : { refId }) },
    });
  },
);
