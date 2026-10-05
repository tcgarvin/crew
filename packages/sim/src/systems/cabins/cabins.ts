/**
 * The cabins system (slice 4, call 14), phase `needs`, every tick:
 *
 * - advances a sleep hold's `disturbedTicks` while anyone not asleep shares the sleeper's
 *   compartment (`caches.index.actorsByCompartment`);
 * - every `cabins.checkEverySeconds`, gives `noBunkOfMyOwn` (refreshed, never stacked) to crew
 *   aboard with no `berths` entry, and takes it from anyone who has one again;
 * - times out a `privateTalk` not under way by `requestedTick + privateTalkWaitSeconds` (both
 *   parties in the cabin on their `confer` steps), or one whose party is gone or ashore:
 *   `privateTalkMissed`, the talk is cleared and both steps fail `dependencyPending`.
 *
 * `onWoke(ctx, actor)`, called from `systems/work/execute.ts` `leaveHold` when a sleep hold
 * completes (not when it is interrupted), with the hold still the current step: `ownCabin` when
 * they slept in their own berth and it stands in a `cabin`-tagged compartment; `noisyBunkroom`
 * when they woke in a `quarters` compartment with `disturbedTicks` at `cabins.noisySeconds` or
 * more.
 *
 * Owner: W3 of ship life slice 4.
 */
import { configTicks } from "../../core/clock";
import { addThought, moodOf } from "../../core/thoughts";
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly } from "../../core/types/common";
import type { DeckDef } from "../../core/types/content";
import type { ActorId } from "../../core/types/ids";
import type { StepCtx, System } from "../../core/types/pipeline";
import type { ActivityStep } from "../../core/types/work";
import { isAsleep } from "../work/activity";
import { emitSim } from "../work/events";
import { bothConferring } from "./private-talk";

type HoldStep = Extract<ActivityStep, { kind: "hold" }>;

/** The step the actor is on, mutable (`currentStep` hands out a read-only one). */
function sleepHold(actor: Actor): HoldStep | undefined {
  const activity = actor.activity;
  if (activity.kind === "idle" || activity.plan === undefined) return undefined;
  const step = activity.plan.steps[activity.plan.stepIndex];
  return step?.kind === "hold" && step.hold === "sleep" ? step : undefined;
}

/** Tags of the compartment the deck's tile at (x, y) belongs to; none off the authored deck. */
function compartmentTagsAt(
  deck: DeepReadonly<DeckDef> | undefined,
  x: number,
  y: number,
): readonly string[] {
  const symbol = deck?.tiles[Math.floor(y)]?.[Math.floor(x)];
  if (symbol === undefined) return [];
  return deck?.compartments.find((c) => c.symbol === symbol)?.tags ?? [];
}

// ---------------------------------------------------------------------------------------------
// A noisy bunkroom
// ---------------------------------------------------------------------------------------------

/** Sleepers sharing a compartment with anyone awake are disturbed for this tick's span. */
function disturbSleepers(ctx: StepCtx): void {
  for (const ids of Object.values(ctx.caches.index.actorsByCompartment)) {
    const here = ids
      .map((id) => ctx.state.actors[id])
      .filter((actor): actor is Actor => actor !== undefined);
    if (!here.some((actor) => !isAsleep(actor.activity))) continue;
    for (const actor of here) {
      const hold = sleepHold(actor);
      if (hold !== undefined) hold.disturbedTicks = (hold.disturbedTicks ?? 0) + ctx.elapsedTicks;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// No bunk of one's own
// ---------------------------------------------------------------------------------------------

/** Crew serving aboard (not a passenger, not dead, not ashore for a while). */
const servingAboard = (actor: DeepReadonly<Actor>): boolean =>
  actor.crew &&
  actor.passenger !== true &&
  actor.availability !== "dead" &&
  actor.availability !== "offShip";

function checkBunks(ctx: StepCtx): void {
  for (const actor of Object.values(ctx.state.actors)) {
    const berthed = ctx.state.berths[actor.id] !== undefined;
    if (!berthed && servingAboard(actor)) {
      addThought(ctx, actor, "noBunkOfMyOwn");
    } else if (actor.thoughts.some((thought) => thought.key === "noBunkOfMyOwn")) {
      actor.thoughts = actor.thoughts.filter((thought) => thought.key !== "noBunkOfMyOwn");
      actor.mood = moodOf(actor, ctx.tick);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The private talk's timeout
// ---------------------------------------------------------------------------------------------

/** Is `id` gone from the ship for the talk's purposes (deleted, dead or ashore)? */
function goneFromShip(ctx: StepCtx, id: ActorId): boolean {
  const actor = ctx.state.actors[id];
  return (
    actor === undefined ||
    actor.availability === "dead" ||
    actor.availability === "offShip" ||
    actor.location.kind !== "onDeck"
  );
}

function timeOutTalk(ctx: StepCtx): void {
  const talk = ctx.state.social.privateTalk;
  if (talk === undefined) return;
  const { captainId, actorId } = talk;
  const gone = goneFromShip(ctx, captainId) || goneFromShip(ctx, actorId);
  const deadline =
    talk.requestedTick + configTicks(ctx.config, ctx.config.cabins.privateTalkWaitSeconds);
  if (!gone) {
    if (ctx.tick < deadline) return;
    const inCompartment = ctx.caches.index.actorsByCompartment;
    if (bothConferring(ctx.state, ctx.content, inCompartment, talk)) return;
  }
  // biome-ignore lint/performance/noDelete: state must omit the key (CONTRACTS rule 2).
  delete ctx.state.social.privateTalk;
  emitSim(ctx, "privateTalkMissed", [captainId, actorId], { captainId, actorId });
}

// ---------------------------------------------------------------------------------------------
// The system and waking
// ---------------------------------------------------------------------------------------------

export const cabinsSystem: System = {
  name: "cabins",
  phase: "needs",
  run(ctx) {
    disturbSleepers(ctx);
    const every = Math.max(1, configTicks(ctx.config, ctx.config.cabins.checkEverySeconds));
    if (ctx.tick % every === 0) checkBunks(ctx);
    timeOutTalk(ctx);
  },
};

/** Did `actor` sleep in their own berth? The sleep plan's walk names the bed it went to. */
function bedSleptIn(ctx: StepCtx, actor: Actor) {
  const activity = actor.activity;
  if (activity.kind === "idle" || activity.plan === undefined) return undefined;
  const walk = activity.plan.steps.find((step) => step.kind === "moveTo");
  if (walk?.kind !== "moveTo" || !("machineId" in walk.target)) return undefined;
  return ctx.state.machines[walk.target.machineId];
}

/** The waking thoughts (module comment). The sleep hold is still the current step. */
export function onWoke(ctx: StepCtx, actor: Actor): void {
  const hold = sleepHold(actor);
  if (hold === undefined || actor.location.kind !== "onDeck") return;
  const bed = bedSleptIn(ctx, actor);
  if (bed !== undefined && ctx.state.berths[actor.id] === bed.placementKey) {
    const deck = ctx.content.decks[bed.deckId];
    const origin = deck?.machines.find((m) => m.key === bed.placementKey)?.origin;
    if (origin !== undefined && compartmentTagsAt(deck, origin.x, origin.y).includes("cabin")) {
      addThought(ctx, actor, "ownCabin");
    }
  }
  const { deckId, x, y } = actor.location;
  const noisy = configTicks(ctx.config, ctx.config.cabins.noisySeconds);
  const inBunkroom = compartmentTagsAt(ctx.content.decks[deckId], x, y).includes("quarters");
  if (inBunkroom && (hold.disturbedTicks ?? 0) >= noisy) addThought(ctx, actor, "noisyBunkroom");
}
