import { configTicks } from "../../core/clock";
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
 *   cabin floor tile nearest the desk, then a `confer` step of `cabins.privateTalkSeconds`. A
 *   cabin without a desk: both to the free floor tiles nearest its first floor tile.
 * - `runConfer`: counts only while both are in the cabin on their `confer` steps (a walk through
 *   the cabin to the desk is not the talk); the caller's step applies the outcome (`warm`: the
 *   crew member remembers `heardMeOut` and the caller `talkedItThrough`, thought `heardOut`;
 *   `stern`: `dressedMeDown` and nothing, thought `dressedDown`) through `addMemory`, emits `privateTalkHeld`, clears the talk and marks the other's step done.
 *   The other's step never finishes on its own count: it is done once the caller has held the
 *   talk, and fails `dependencyPending` when the talk went away unheld (the cabins system's
 *   timeout, `privateTalkMissed`).
 * - `leaveTalk` (called from `abortActivity`): the talk stays pending until the cabins system's
 *   timeout; nothing else. Whoever was taken off it plans the summons again when free.
 *
 * Owner: W3 of ship life slice 4.
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
import { addThought } from "../../core/thoughts";
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly, TileCoord } from "../../core/types/common";
import type { ContentBundle } from "../../core/types/content";
import type { ActorId, CompartmentId } from "../../core/types/ids";
import type { DeckGeometry, NavInteractionPosition } from "../../core/types/nav";
import type { ReadonlyWorldState, StepCtx } from "../../core/types/pipeline";
import type { PrivateTalk } from "../../core/types/state";
import type { ActivityStep, StepTarget } from "../../core/types/work";
import { shipDeckId } from "../../core/world";
import { addMemory } from "../social/relationships";
import { estimateTravelTicks } from "../spatial/estimates";
import { compartmentAt, isWalkable } from "../spatial/geometry";
import { currentStep } from "../work/activity";
import { emitSim } from "../work/events";
import { type PlanResult, blocked, planOf } from "../work/plans";
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

// ---------------------------------------------------------------------------------------------
// The walk to the cabin
// ---------------------------------------------------------------------------------------------

const manhattan = (a: TileCoord, b: TileCoord): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

const partyTo = (talk: Readonly<PrivateTalk>, actorId: ActorId): boolean =>
  talk.captainId === actorId || talk.actorId === actorId;

/** The `use` position (the `seat`) of a `desk` machine standing in `cabin`, if it has one. */
function deskSeat(
  ctx: StepCtx,
  geometry: DeckGeometry,
  cabin: CompartmentId,
): NavInteractionPosition | undefined {
  const machines = new Set(ctx.caches.index.machinesByCompartment[cabin] ?? []);
  return geometry.interactionPositions.find((position) => {
    if (!machines.has(position.machineId) || !position.purposes.includes("use")) return false;
    const machine = ctx.state.machines[position.machineId];
    return machine !== undefined && ctx.content.machines[machine.defId]?.tags.includes("desk");
  });
}

/** The tile a desk stands on (its placement origin). */
function deskTile(ctx: StepCtx, seat: NavInteractionPosition): TileCoord | undefined {
  const machine = ctx.state.machines[seat.machineId];
  if (machine === undefined) return undefined;
  const placement = ctx.content.decks[machine.deckId]?.machines.find(
    (m) => m.key === machine.placementKey,
  );
  return placement === undefined ? undefined : { ...placement.origin };
}

/**
 * The cabin's free floor tiles (walkable, no machine's interaction position on them, a route to
 * them from `start`), nearest `anchor` first, scan order between equals. Without an anchor,
 * nearest the first of them. A corner boxed in by the bunk and the desk is not free.
 */
function freeCabinTiles(
  ctx: StepCtx,
  geometry: DeckGeometry,
  cabin: CompartmentId,
  start: TileCoord,
  anchor: TileCoord | undefined,
): TileCoord[] {
  const deck = ctx.content.decks[geometry.deckId];
  if (deck === undefined) return [];
  const tiles: TileCoord[] = [];
  for (let y = 0; y < deck.height; y++) {
    for (let x = 0; x < deck.width; x++) {
      if (compartmentAt(geometry, x, y) !== cabin || !isWalkable(geometry, x, y)) continue;
      if (geometry.interactionPositions.some((p) => p.tile.x === x && p.tile.y === y)) continue;
      const tile = { x, y };
      if (estimateTravelTicks(geometry, start, tile, ctx.config, 1, ctx.caches) === null) continue;
      tiles.push(tile);
    }
  }
  const from = anchor ?? tiles[0];
  if (from === undefined) return [];
  // Array.prototype.sort is stable: equally near tiles keep scan order.
  return tiles.sort((a, b) => manhattan(a, from) - manhattan(b, from));
}

/**
 * The walk to the cabin and the `confer` step (module comment). Blocked `dependencyPending`
 * when no talk names the actor, `unreachableTarget` when the cabin has nowhere to stand.
 */
export function privateTalkPlan(ctx: StepCtx, actor: Actor): PlanResult {
  const talk = ctx.state.social.privateTalk;
  if (talk === undefined || !partyTo(talk, actor.id)) return blocked("dependencyPending");
  const cabin = talkCabin(ctx.state, ctx.content, talk.captainId);
  if (cabin === undefined || actor.location.kind !== "onDeck") return blocked("unreachableTarget");
  const geometry = ctx.caches.nav.decks[actor.location.deckId];
  if (geometry === undefined) return blocked("unreachableTarget");
  const seat = deskSeat(ctx, geometry, cabin);
  const start = { x: Math.floor(actor.location.x), y: Math.floor(actor.location.y) };
  const free = freeCabinTiles(ctx, geometry, cabin, start, seat && deskTile(ctx, seat));
  const caller = talk.captainId === actor.id;
  let target: StepTarget | undefined;
  if (caller && seat !== undefined) {
    target = { machineId: seat.machineId, positionKey: seat.key };
  } else {
    // Without a desk the caller takes the nearest free tile and the other the next.
    const tile = free[caller || seat !== undefined ? 0 : 1];
    target = tile === undefined ? undefined : { x: tile.x, y: tile.y };
  }
  if (target === undefined) return blocked("unreachableTarget");
  const ticksNeeded = configTicks(ctx.config, ctx.config.cabins.privateTalkSeconds);
  return planOf([
    { kind: "moveTo", target, requested: false },
    { kind: "confer", ticksDone: 0, ticksNeeded },
  ]);
}

// ---------------------------------------------------------------------------------------------
// The talk
// ---------------------------------------------------------------------------------------------

/** Is `actor` on the `confer` step of a `privateTalk` activity? */
function conferring(actor: DeepReadonly<Actor>): boolean {
  const activity = actor.activity;
  return (
    activity.kind === "personal" &&
    activity.activity === "privateTalk" &&
    currentStep(activity)?.kind === "confer"
  );
}

/** Both parties stand in the talk's cabin, each on their `confer` step. */
export function bothConferring(
  state: ReadonlyWorldState,
  content: ContentBundle,
  inCompartment: Readonly<Record<CompartmentId, readonly ActorId[]>>,
  talk: Readonly<PrivateTalk>,
): boolean {
  const cabin = talkCabin(state, content, talk.captainId);
  if (cabin === undefined) return false;
  const present = inCompartment[cabin] ?? [];
  return [talk.captainId, talk.actorId].every((id) => {
    const actor = state.actors[id];
    return actor !== undefined && present.includes(id) && conferring(actor);
  });
}

/** The outcome of call 15 (D88): memories (the caller's only when warm), the crew member's thought. */
const OUTCOME = {
  warm: { toCaller: "heardMeOut", toCrew: "talkedItThrough", thought: "heardOut" },
  stern: { toCaller: "dressedMeDown", toCrew: undefined, thought: "dressedDown" },
} as const;

/** The caller's `confer` step has run its course: the talk is held (module comment). */
function holdTalk(ctx: StepCtx, talk: PrivateTalk): void {
  const { captainId, actorId, tone } = talk;
  const outcome = OUTCOME[tone];
  const crew = ctx.state.actors[actorId];
  if (crew === undefined) throw new Error(`privateTalk: ${actorId} vanished mid-talk`);
  addMemory(ctx, actorId, captainId, outcome.toCaller);
  if (outcome.toCrew !== undefined) addMemory(ctx, captainId, actorId, outcome.toCrew);
  addThought(ctx, crew, outcome.thought);
  // biome-ignore lint/performance/noDelete: state must omit the key (CONTRACTS rule 2).
  delete ctx.state.social.privateTalk;
  emitSim(ctx, "privateTalkHeld", [captainId, actorId], { captainId, actorId, tone });
  const step =
    crew.activity.kind === "idle"
      ? undefined
      : crew.activity.plan?.steps[crew.activity.plan.stepIndex];
  if (step?.kind === "confer" && conferring(crew)) step.ticksDone = step.ticksNeeded;
}

/** The `confer` step (module comment). */
export function runConfer(
  ctx: StepCtx,
  actor: Actor,
  step: Extract<ActivityStep, { kind: "confer" }>,
): StepResult {
  // The caller marks the other's step done as they hold the talk.
  if (step.ticksDone >= step.ticksNeeded) return "done";
  const talk = ctx.state.social.privateTalk;
  if (talk === undefined || !partyTo(talk, actor.id)) return { fail: "dependencyPending" };
  if (!bothConferring(ctx.state, ctx.content, ctx.caches.index.actorsByCompartment, talk)) {
    return "wait";
  }
  if (talk.captainId !== actor.id) {
    // The one called in keeps time with the caller but never ends the talk themselves.
    step.ticksDone = Math.min(step.ticksDone + 1, step.ticksNeeded - 1);
    return "wait";
  }
  step.ticksDone += 1;
  if (step.ticksDone < step.ticksNeeded) return "wait";
  holdTalk(ctx, talk);
  return "done";
}

/**
 * A party to the talk was taken off it: the talk stays pending until the cabins system's
 * timeout, so nothing happens here.
 */
export function leaveTalk(_ctx: StepCtx, _actor: Actor): void {}
