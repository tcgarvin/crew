/**
 * `privateTalk` (slice 4, call 15): a card side effect the player chooses, run as the `player`.
 * The command actor (the captain, or the first officer standing in, D8) calls a crew member in
 * for a word in their cabin, warm or stern.
 *
 * - The command handler (complete at the gate): the called person is crew (not a passenger)
 *   aboard (on the deck, not the dock alongside) and available, and not the command actor; no
 *   talk is pending; the command actor has a cabin (`talkCabin`: `captainsCabin` for the
 *   captain, `officersCabin` for a first officer) → `preconditionFailed` otherwise. Apply writes
 *   `social.privateTalk` and emits `privateTalkCalled`. Both then see it as `SelfView.summons`.
 * - `privateTalkPlan`: the caller to their desk's `seat` in the cabin, the other to the free
 *   cabin floor tile nearest the desk, then a `confer` step of `cabins.privateTalkSeconds`.
 * - `runConfer`: counts only while both are in the cabin; the caller's step applies the outcome
 *   (`warm`: +2 crew → caller, +1 caller → crew, `heardOut`; `stern`: −2 and 0, `dressedDown`)
 *   through `moveAffinity`, emits `privateTalkHeld` and clears the talk, which ends the other's
 *   step.
 * - `leaveTalk` (called from `abortActivity`): the talk stays pending until the cabins system's
 *   timeout (`privateTalkMissed`); nothing else.
 *
 * Owner: W3 of ship life slice 4. Gate stubs: the plan is blocked, `runConfer` throws (no plan
 * has the step yet), `leaveTalk` is a no-op.
 */
import { commandActor } from "../../core/command-actor";
import {
  type AppliedCommand,
  type CommandHandler,
  NO_TEMP_REFS,
  type Validation,
  causedBy,
  ok,
  reject,
} from "../../core/commands";
import { isOnDock } from "../../core/docks";
import { NotImplementedError } from "../../core/registry";
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly } from "../../core/types/common";
import type { ContentBundle } from "../../core/types/content";
import type { ActorId, CompartmentId } from "../../core/types/ids";
import type { ReadonlyWorldState, StepCtx } from "../../core/types/pipeline";
import type { ActivityStep } from "../../core/types/work";
import { shipDeckId } from "../../core/world";
import { type PlanResult, blocked } from "../work/plans";
import type { StepResult } from "../work/steps";

/**
 * The cabin `callerId` holds a talk in: the ship deck's `captainsCabin` for a captain, its
 * `officersCabin` for a first officer; undefined for anyone else or a deck without one.
 */
export function talkCabin(
  state: ReadonlyWorldState,
  content: ContentBundle,
  callerId: ActorId,
): CompartmentId | undefined {
  const caller = state.actors[callerId];
  if (caller === undefined) return undefined;
  const tag = caller.roleTags.includes("captain")
    ? "captainsCabin"
    : caller.roleTags.includes("firstOfficer")
      ? "officersCabin"
      : undefined;
  if (tag === undefined) return undefined;
  const deckId = shipDeckId(state);
  const def = content.decks[deckId]?.compartments.find((c) => c.tags.includes(tag));
  if (def === undefined) return undefined;
  return Object.values(state.compartments).find((c) => c.deckId === deckId && c.key === def.key)
    ?.id;
}

/** Why `actor` cannot be called in, or undefined if they can. */
function unavailable(
  state: ReadonlyWorldState,
  content: ContentBundle,
  actor: DeepReadonly<Actor>,
): string | undefined {
  if (!actor.crew || actor.passenger === true) return `${actor.name} is not crew`;
  if (actor.availability !== "available" || actor.location.kind !== "onDeck") {
    return `${actor.name} is not aboard`;
  }
  if (isOnDock(content, state, actor.location)) return `${actor.name} is on the dock`;
  return undefined;
}

interface PrivateTalkPlan {
  readonly captainId: ActorId;
}

export const privateTalkHandler: CommandHandler<"privateTalk", PrivateTalkPlan> = {
  validate(ctx, command): Validation<PrivateTalkPlan> {
    const { actorId, tone } = command.payload;
    if (tone !== "warm" && tone !== "stern") {
      return reject("invalidPayload", `privateTalk: tone must be "warm" or "stern"`);
    }
    const actor = ctx.state.actors[actorId];
    if (actor === undefined)
      return reject("unknownEntity", `privateTalk: unknown actor ${actorId}`);
    const why = unavailable(ctx.state, ctx.content, actor);
    if (why !== undefined) return reject("preconditionFailed", `privateTalk: ${why}`);
    const captainId = commandActor(ctx.state);
    if (captainId === actorId) {
      return reject("invalidPayload", "privateTalk: the command actor cannot call themselves in");
    }
    if (ctx.state.social.privateTalk !== undefined) {
      return reject("preconditionFailed", "privateTalk: a talk is already pending");
    }
    if (talkCabin(ctx.state, ctx.content, captainId) === undefined) {
      return reject("preconditionFailed", "privateTalk: the command actor has no cabin");
    }
    return ok({ captainId });
  },
  apply(ctx, command, plan): AppliedCommand {
    const { actorId, tone } = command.payload;
    ctx.state.social.privateTalk = {
      captainId: plan.captainId,
      actorId,
      tone,
      requestedTick: ctx.tick,
    };
    ctx.emit({
      ...causedBy(command),
      type: "privateTalkCalled",
      subjectIds: [plan.captainId, actorId],
      payload: { captainId: plan.captainId, actorId },
    });
    return NO_TEMP_REFS;
  },
};

/** The walk to the cabin and the `confer` step. Gate stub: blocked. */
export function privateTalkPlan(_ctx: StepCtx, _actor: Actor): PlanResult {
  return blocked("dependencyPending");
}

/** The `confer` step. Gate stub: throws. */
export function runConfer(
  _ctx: StepCtx,
  _actor: Actor,
  _step: Extract<ActivityStep, { kind: "confer" }>,
): StepResult {
  throw new NotImplementedError("runConfer (slice 4 W3)");
}

/** A party to the talk was taken off it. Gate stub: no-op. */
export function leaveTalk(_ctx: StepCtx, _actor: Actor): void {}
