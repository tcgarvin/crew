/**
 * Passages (passengers-and-galaxy §3): a job with a person in it.
 *
 * Accepting a passage job spawns the issuer at the personnel ramp as a `crew.passenger` actor
 * (`spawnPassenger`). From then on `sweepPassages` runs once a tick after travel:
 *
 *  - leg `out`, docked at `toPortId`: the passenger walks to the personnel ramp. One-way: they
 *    step off and despawn, the passage ends `completed` and `payJobIfDue` pays the fare. Round
 *    trip: they go ashore (`availability: offShip`, held in the port's lounge store), the sim
 *    draws `returnsAtTick` on the `commerce` stream, the voyage home is planned at once and the
 *    travel system holds departure for them (`waitingForPassenger`, travel.ts).
 *  - leg `ashore`: at `returnsAtTick` they walk back aboard (leg `back`). Not back
 *    `config.commerce.passage.overdueSeconds` after going ashore, the first officer brings one
 *    policy card, "Wait for them" / "Leave without them" (D29, D37); leaving is `endPassage`.
 *  - leg `back`, docked at `fromPortId`: they walk off, despawn, `completed`, paid once.
 *
 * `endPassage` (§4.2) ends a passage early: `leftBehind` for a passenger already ashore,
 * `putOff` for one aboard, who then leaves at the next docking (now, if docked). Neither pays.
 *
 * Walking off: the passenger is handed a `wander` intent to a personnel transfer tile and the
 * planner leaves them alone while `disembarking` is set (`planner/select.ts`). Where the walk
 * cannot be planned (no nav cache, no route, a failed move) they step off at once, so the
 * lifecycle never stalls on the deck.
 *
 * D63, with the port's dock alongside: a booked passenger appears at the dock's gate and walks
 * across the dock and up the personnel ramp (`walkAboard`, a `comeAboard` walk to the passenger
 * spawn point); one walking off walks down and out through the gate, where they step off; one
 * coming back from ashore appears at the gate and walks aboard the same way.
 */
import { configTicks } from "../../core/clock";
import { newActor } from "../../core/command-handlers";
import type { ApplyCtx } from "../../core/commands";
import { queuePolicyDecision } from "../../core/decisions";
import { findCrewDef } from "../../core/defs";
import { localNamed } from "../../core/delivery";
import { gateTileAt, isDockPoint, isOnDock } from "../../core/docks";
import { allocateId } from "../../core/ids";
import type { Actor } from "../../core/types/actor";
import type { PhysicalLocation, TileCoord } from "../../core/types/common";
import type { DeckDef, PortDef } from "../../core/types/content";
import type { EventDraft } from "../../core/types/events";
import type { ActorId, CrewDefId, ItemId, JobId, PortDefId } from "../../core/types/ids";
import type { ReadonlyWorldState, StepCtx } from "../../core/types/pipeline";
import type { Job, JobPassage, PassageEndReason } from "../../core/types/travel";
import { stopMovement } from "../spatial/movement";
import { releaseReservations } from "../spatial/reservations";
import { shortestPath } from "../travel/graph";
import { commandActor } from "../travel/roster";
import { theDeckId } from "../travel/travel";
import { isBackingOff } from "../work/activity";
import { raiseUnloadProblems } from "./jobs";

/** The generic passenger template every passage spawns from (content `crew.passenger`). */
export const PASSENGER_CREW_DEF_ID = "crew.passenger" as CrewDefId;

/** Prompt key of the overdue card; `@crew/content` `templates.ts` renders it. */
export const PASSENGER_OVERDUE_PROMPT_KEY = "commerce.passengerOverdue";

/** Backoff ref the work system writes when a `wander` plan cannot be built (`plans.ts`). */
const WANDER_BACKOFF_REF = "wander";

const SIM_CAUSE: Pick<EventDraft, "causeIds" | "source"> = { causeIds: [], source: "sim" };

// ---------------------------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------------------------

/** Where an off-ship passenger waits at a port: its lounge, else its first store. */
export function loungeLocation(port: PortDef): PhysicalLocation {
  const store = port.externalStores.find((s) => s.kind === "lounge") ?? port.externalStores[0];
  if (store === undefined) throw new Error(`Port "${port.id}" has no external store`);
  return { kind: "inExternalStore", portId: port.id, storeKey: store.key };
}

/** The tile a passenger appears on: the deck's `passenger` spawn point, else inside the ramp. */
export function passengerSpawnTile(deck: DeckDef): TileCoord | undefined {
  const point = deck.spawnPoints.find((p) => p.tags.includes("passenger"));
  return point?.tile ?? deck.docking.personnelTransferTiles[0];
}

function rampTiles(deck: DeckDef): readonly TileCoord[] {
  const tiles = [...deck.docking.personnelTransferTiles];
  const spawn = passengerSpawnTile(deck);
  if (spawn !== undefined && !tiles.some((t) => t.x === spawn.x && t.y === spawn.y)) {
    tiles.push(spawn);
  }
  return tiles;
}

function theDeck(ctx: Pick<StepCtx, "content">): DeckDef {
  const deck = ctx.content.decks[theDeckId(ctx)];
  if (deck === undefined) throw new Error("passage: content bundle has no deck");
  return deck;
}

/**
 * D63: a ramp travel has asked down is not down yet (still lowering on the first docked ticks).
 * A walk across it waits rather than fail: the planner would find no route and back off.
 */
function rampsStillLowering(ctx: Pick<StepCtx, "state">): boolean {
  return Object.values(ctx.state.doors).some(
    (d) =>
      d.kind === "ramp" &&
      d.requestedState === "open" &&
      (d.physicalState === "opening" || d.physicalState === "closed"),
  );
}

/** D63: the gate of the dock alongside the port the ship is docked at, if it has one. */
function gateHere(ctx: Pick<StepCtx, "state" | "content">): TileCoord | undefined {
  const travel = ctx.state.travel;
  if (travel.stage !== "docked") return undefined;
  return gateTileAt(ctx.content, ctx.state, travel.portId);
}

/**
 * Where a passenger comes onto the map: at the gate of the dock alongside (D63), from where they
 * walk across the dock and up the personnel ramp; with no dock, inside the ramp as before.
 */
function arrivalTile(ctx: Pick<StepCtx, "state" | "content">): TileCoord {
  const gate = gateHere(ctx);
  if (gate !== undefined) return gate;
  const deck = theDeck(ctx);
  const tile = passengerSpawnTile(deck);
  if (tile === undefined) throw new Error(`Deck "${deck.id}" has no passenger spawn point`);
  return tile;
}

function dockedAt(state: ReadonlyWorldState, portId: PortDefId): boolean {
  return state.travel.stage === "docked" && state.travel.portId === portId;
}

// ---------------------------------------------------------------------------------------------
// Boarding
// ---------------------------------------------------------------------------------------------

function passengerEvent(job: Job, actor: Pick<Actor, "id" | "name">) {
  return { jobId: job.id, actorId: actor.id, name: actor.name };
}

/**
 * Spawn the passenger of `job` at the personnel ramp: the `crew.passenger` template with the
 * issuer's name, `crew: true` (needs, movement, chat and perception treat them as a person
 * aboard) and `passenger: true` (no work, no post, no helm). Emits `entitySpawned` and
 * `passengerBoarded`. The caller has validated that the template exists.
 */
export function spawnPassenger(
  ctx: ApplyCtx,
  job: Job,
  cause: Pick<EventDraft, "causeIds" | "source">,
): ActorId {
  const def = findCrewDef(ctx.content, ctx.state, PASSENGER_CREW_DEF_ID);
  if (def === undefined) throw new Error(`passage: no "${PASSENGER_CREW_DEF_ID}" crew template`);
  const deck = theDeck(ctx);
  // D70: a passenger who came over with their offer (or was on the dock already) is a local until
  // the captain takes them on; they board from where they stand, and the local goes, so the dock
  // never has the same person twice.
  const local = localNamed(ctx.state, job.issuerPerson.name);
  const tile =
    local === undefined
      ? arrivalTile(ctx)
      : { x: Math.floor(local.location.x), y: Math.floor(local.location.y) };
  if (local !== undefined) delete ctx.state.dockside.locals[local.id];
  const id: ActorId = allocateId(ctx.state, "actor");
  const actor = newActor(id, def, {
    kind: "onDeck",
    deckId: deck.id,
    x: tile.x + 0.5,
    y: tile.y + 0.5,
  });
  actor.name = job.issuerPerson.name;
  actor.crew = true;
  actor.passenger = true;
  ctx.state.actors[id] = actor;
  ctx.emit({
    ...cause,
    type: "entitySpawned",
    subjectIds: [id],
    payload: { entityId: id, defId: def.id },
  });
  ctx.emit({
    ...cause,
    type: "passengerBoarded",
    subjectIds: [id, job.id],
    payload: passengerEvent(job, actor),
  });
  return id;
}

// ---------------------------------------------------------------------------------------------
// Leaving the deck
// ---------------------------------------------------------------------------------------------

function standingOnAny(tiles: readonly TileCoord[], actor: Actor): boolean {
  const location = actor.location;
  if (location.kind !== "onDeck") return true;
  const x = Math.floor(location.x);
  const y = Math.floor(location.y);
  return tiles.some((t) => t.x === x && t.y === y);
}

/**
 * Where a passenger walks to leave the ship: down across the dock and out through its gate
 * (D63), or with no dock to the personnel ramp, where they step off.
 */
function exitTiles(ctx: Pick<StepCtx, "state" | "content">): readonly TileCoord[] {
  const gate = gateHere(ctx);
  return gate === undefined ? rampTiles(theDeck(ctx)) : [gate];
}

/** The walk cannot happen (or has failed): step off at once rather than stall. */
function cannotWalk(ctx: StepCtx, actor: Actor): boolean {
  if (actor.location.kind !== "onDeck") return true;
  if (ctx.caches.nav.decks[actor.location.deckId] === undefined) return true;
  if (isBackingOff(actor.workBackoff, WANDER_BACKOFF_REF, ctx.tick)) return true;
  return actor.movement.kind === "stationary" && actor.movement.routeFailure !== undefined;
}

/**
 * Drive one tick of the walk off the ship: to the dock's gate (D63), or the personnel ramp with
 * no dock. Returns true once the passenger is there (or cannot get there), i.e. the moment they
 * can step off.
 */
function walkOff(ctx: StepCtx, actor: Actor): boolean {
  if (actor.disembarking !== true) actor.disembarking = true;
  const exits = exitTiles(ctx);
  if (standingOnAny(exits, actor)) return true;
  // D63: the walk to the gate crosses a ramp; on the first docked ticks it is still coming down.
  if (gateHere(ctx) !== undefined && rampsStillLowering(ctx)) return false;
  if (cannotWalk(ctx, actor)) return true;
  const walking = actor.activity.kind === "personal" && actor.activity.activity === "wander";
  if (!walking) {
    const tile = exits[0];
    if (tile === undefined) return true;
    actor.pendingIntent = {
      kind: "personal",
      activity: "wander",
      tile: { x: tile.x, y: tile.y },
      urgency: "essentialOperation",
      trace: { candidates: 0, chosenReason: "disembarking", rejected: [] },
    };
  }
  return false;
}

/** Anything the passenger holds is set down where they stand (an item cannot leave with them). */
function dropCarried(ctx: StepCtx, actor: Actor): void {
  const location = actor.location;
  for (const item of Object.values(ctx.state.items)) {
    const held = item.location;
    if ((held.kind !== "carriedBy" && held.kind !== "equippedBy") || held.actorId !== actor.id) {
      continue;
    }
    item.location =
      location.kind === "onDeck"
        ? { kind: "onDeck", deckId: location.deckId, x: location.x, y: location.y }
        : location;
    ctx.dirty.inventory = true;
  }
}

function clearDeckPresence(ctx: StepCtx, actor: Actor): void {
  if (actor.movement.kind === "moving") stopMovement(ctx.state, ctx.caches, actor.id);
  dropCarried(ctx, actor);
  // A walk cut short mid-route still holds its destination tile (`spatial/reservations.ts`);
  // an actor who is leaving the deck keeps nothing.
  releaseReservations(ctx.caches, actor.id);
  actor.movement = { kind: "stationary" };
  actor.activity = { kind: "idle" };
  // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
  delete actor.pendingIntent;
  // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
  delete actor.disembarking;
}

/** The passenger steps off into the port's lounge and is off ship. */
function stepAshore(ctx: StepCtx, actor: Actor, port: PortDef): void {
  clearDeckPresence(ctx, actor);
  actor.location = loungeLocation(port);
  actor.availability = "offShip";
}

/** The passenger walks down the ramp and is gone (one-way arrival, or home again). */
function despawn(ctx: StepCtx, actor: Actor): void {
  clearDeckPresence(ctx, actor);
  delete ctx.state.actors[actor.id];
}

function endPassageWith(
  ctx: ApplyCtx,
  job: Job,
  passage: JobPassage,
  actor: Pick<Actor, "id" | "name">,
  reason: PassageEndReason,
  portId: PortDefId,
  cause: Pick<EventDraft, "causeIds" | "source"> = SIM_CAUSE,
): void {
  passage.endReason = reason;
  // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
  delete passage.returnsAtTick;
  // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
  delete passage.ashoreSinceTick;
  ctx.emit({
    ...cause,
    type: "passageEnded",
    subjectIds: [actor.id, job.id],
    locationRef: { kind: "port", portId },
    payload: { ...passengerEvent(job, actor), reason, portId },
  });
}

// ---------------------------------------------------------------------------------------------
// Ashore and back
// ---------------------------------------------------------------------------------------------

/**
 * Plan the voyage home from the far port the moment the ship docks there (before the passenger
 * has even reached the ramp), so the course is held and the headline reads "bound for home"
 * from the first docked tick and `captainAshore` never sees an idle captain here; travel waits for
 * the passenger before leaving (`waitingForPassenger`). Idempotent: a course already planned
 * (a detour card, a save from mid-stay) is left alone.
 */
function planVoyageHome(ctx: StepCtx, job: Job): void {
  const travel = ctx.state.travel;
  if (travel.stage !== "docked" || travel.plannedDestinationId !== undefined) return;
  const route = shortestPath(ctx.content.ports, travel.portId, job.fromPortId);
  const hop = route?.path[1];
  if (route === undefined || hop === undefined) return;
  travel.plannedDestinationId = hop;
  if (route.path.length > 2) travel.voyageDestinationId = job.fromPortId;
}

function goAshore(ctx: StepCtx, job: Job, passage: JobPassage, actor: Actor, port: PortDef): void {
  stepAshore(ctx, actor, port);
  const { ashoreSecondsMin, ashoreSecondsMax } = ctx.config.commerce.passage;
  const seconds =
    ashoreSecondsMax > ashoreSecondsMin
      ? ashoreSecondsMin + (ashoreSecondsMax - ashoreSecondsMin) * ctx.rng.float("commerce")
      : ashoreSecondsMin;
  passage.leg = "ashore";
  passage.ashoreSinceTick = ctx.tick;
  passage.returnsAtTick = ctx.tick + configTicks(ctx.config, seconds);
  ctx.emit({
    ...SIM_CAUSE,
    type: "passengerAshore",
    subjectIds: [actor.id, job.id],
    locationRef: { kind: "port", portId: port.id },
    payload: { ...passengerEvent(job, actor), portId: port.id },
  });
}

function returnAboard(ctx: StepCtx, job: Job, passage: JobPassage, actor: Actor): void {
  const deck = theDeck(ctx);
  // D63: they come back through the gate and walk aboard (`walkAboard`).
  const tile = arrivalTile(ctx);
  actor.location = { kind: "onDeck", deckId: deck.id, x: tile.x + 0.5, y: tile.y + 0.5 };
  actor.availability = "available";
  passage.leg = "back";
  // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
  delete passage.returnsAtTick;
  // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
  delete passage.ashoreSinceTick;
  ctx.emit({
    ...SIM_CAUSE,
    type: "passengerReturned",
    subjectIds: [actor.id, job.id],
    payload: passengerEvent(job, actor),
  });
}

function overdueCardsOf(state: ReadonlyWorldState, jobId: JobId) {
  return Object.values(state.decisions.records).filter(
    (d) => d.prompt.key === PASSENGER_OVERDUE_PROMPT_KEY && d.prompt.params.jobId === jobId,
  );
}

/** The overdue card was already raised for this job (pending or answered). */
export function overdueCardRaised(state: ReadonlyWorldState, jobId: JobId): boolean {
  return overdueCardsOf(state, jobId).length > 0;
}

/** The overdue card is in front of the captain (or queued) and not yet answered. */
export function overdueCardPending(state: ReadonlyWorldState, jobId: JobId): boolean {
  return overdueCardsOf(state, jobId).some((d) => d.status === "pending");
}

/** D29: the first officer brings the overdue card, when the ship has one. */
function firstOfficerName(state: ReadonlyWorldState): string | undefined {
  return Object.values(state.actors).find(
    (a) => a.crew && a.passenger !== true && a.roleTags.includes("firstOfficer"),
  )?.name;
}

function raiseOverdueCard(ctx: StepCtx, job: Job, actor: Actor, portId: PortDefId): void {
  const speaker = firstOfficerName(ctx.state);
  queuePolicyDecision(ctx, {
    perspectiveActorId: commandActor(ctx.state),
    prompt: {
      key: PASSENGER_OVERDUE_PROMPT_KEY,
      params: {
        jobId: job.id,
        actorId: actor.id,
        name: actor.name,
        port: portId,
        ...(speaker === undefined ? {} : { speaker }),
      },
    },
    left: {
      label: { key: `${PASSENGER_OVERDUE_PROMPT_KEY}.wait`, params: {} },
      commands: [],
      aftermath: { key: `${PASSENGER_OVERDUE_PROMPT_KEY}.wait.aftermath`, params: {} },
    },
    right: {
      label: { key: `${PASSENGER_OVERDUE_PROMPT_KEY}.leave`, params: {} },
      commands: [{ kind: "endPassage", payload: { jobId: job.id } }],
      aftermath: { key: `${PASSENGER_OVERDUE_PROMPT_KEY}.leave.aftermath`, params: {} },
    },
  });
}

// ---------------------------------------------------------------------------------------------
// The per-tick sweep
// ---------------------------------------------------------------------------------------------

function sweepOut(ctx: StepCtx, job: Job, passage: JobPassage, actor: Actor): void {
  if (!dockedAt(ctx.state, job.toPortId)) return;
  // Round trip: the course home is set on the arrival tick, while the passenger is still
  // walking to the ramp; the walk itself holds departure (`waitingForPassenger`).
  if (passage.roundTrip) planVoyageHome(ctx, job);
  if (!walkOff(ctx, actor)) return;
  const port = ctx.defs.port(job.toPortId);
  if (passage.roundTrip) {
    goAshore(ctx, job, passage, actor, port);
    return;
  }
  despawn(ctx, actor);
  endPassageWith(ctx, job, passage, actor, "completed", port.id);
}

function sweepAshore(ctx: StepCtx, job: Job, passage: JobPassage, actor: Actor): void {
  if (!dockedAt(ctx.state, job.toPortId)) return;
  if (passage.returnsAtTick !== undefined && ctx.tick >= passage.returnsAtTick) {
    // The overdue card is on the table: the kernel has no way to withdraw a queued decision, so
    // the return waits for the answer. "Wait for them" brings them aboard next tick; "Leave
    // without them" ends the passage `leftBehind` before a stale card can put them off aboard.
    if (overdueCardPending(ctx.state, job.id)) return;
    returnAboard(ctx, job, passage, actor);
    return;
  }
  const since = passage.ashoreSinceTick;
  if (since === undefined) return;
  const overdueTicks = configTicks(ctx.config, ctx.config.commerce.passage.overdueSeconds);
  if (ctx.tick - since < overdueTicks) return;
  if (overdueCardRaised(ctx.state, job.id)) return;
  raiseOverdueCard(ctx, job, actor, job.toPortId);
}

function sweepBack(ctx: StepCtx, job: Job, passage: JobPassage, actor: Actor): void {
  if (!dockedAt(ctx.state, job.fromPortId)) return;
  if (!walkOff(ctx, actor)) return;
  despawn(ctx, actor);
  endPassageWith(ctx, job, passage, actor, "completed", job.fromPortId);
}

/**
 * The job's luggage that is physically aboard (stowed, or in a crew member's hands). D61: luggage
 * lying on the dock is already ashore and needs no unloading.
 */
function luggageAboard(ctx: StepCtx, job: Job): ItemId[] {
  return job.cargoItemIds.filter((itemId) => {
    const location = ctx.state.items[itemId]?.location;
    if (location === undefined) return false;
    if (location.kind === "onDeck") return !isOnDock(ctx.content, ctx.state, location);
    return location.kind === "carriedBy" || location.kind === "equippedBy";
  });
}

/**
 * A passenger put off while aboard leaves at the next docking, wherever that is. Their luggage
 * goes with them: any of it already aboard gets a `cargoToUnload` here (the failed job keeps the
 * crate's `jobId`, so without this it would ride in the hold for good), and the open unload
 * work holds the ship until it is on the dock.
 */
function sweepPutOff(ctx: StepCtx, job: Job, actor: Actor): void {
  const travel = ctx.state.travel;
  if (travel.stage !== "docked" || actor.location.kind !== "onDeck") return;
  if (!walkOff(ctx, actor)) return;
  stepAshore(ctx, actor, ctx.defs.port(travel.portId));
  raiseUnloadProblems(ctx, job, travel.portId, luggageAboard(ctx, job));
}

/** Is this actor walking a route that ends aboard (off the dock)? */
function headedAboard(ctx: StepCtx, actor: Actor): boolean {
  const movement = actor.movement;
  if (movement.kind !== "moving") return false;
  const end = movement.path[movement.path.length - 1];
  return end !== undefined && !isDockPoint(ctx.content, ctx.state, end.x, end.y);
}

/**
 * D63: a passenger on the dock who is not leaving (just booked at the gate, or back from ashore)
 * walks across it and up the personnel ramp to the passenger spawn point. Handed out every tick
 * until they are on their way, as departure prep's call aboard is: the planner may overwrite a
 * pending intent on the tick it runs, and leaves a `comeAboard` under way alone.
 */
function walkAboard(ctx: StepCtx, actor: Actor): void {
  if (actor.disembarking === true || actor.availability !== "available") return;
  if (!isOnDock(ctx.content, ctx.state, actor.location) || rampsStillLowering(ctx)) return;
  const boarding = actor.activity.kind === "personal" && actor.activity.activity === "comeAboard";
  if (boarding || headedAboard(ctx, actor)) return;
  const tile = passengerSpawnTile(theDeck(ctx));
  if (tile === undefined) return;
  actor.pendingIntent = {
    kind: "personal",
    activity: "comeAboard",
    tile: { x: tile.x, y: tile.y },
    urgency: "essentialOperation",
    trace: { candidates: 0, chosenReason: "boarding", rejected: [] },
  };
}

/** Advance every live passage one tick (see the module comment). */
export function sweepPassages(ctx: StepCtx): void {
  for (const job of Object.values(ctx.state.jobs)) {
    const passage = job.passage;
    if (passage === undefined) continue;
    const actor = ctx.state.actors[passage.actorId];
    if (actor === undefined) continue;
    if (passage.endReason !== undefined) {
      if (passage.endReason === "putOff") sweepPutOff(ctx, job, actor);
      continue;
    }
    switch (passage.leg) {
      case "out":
        sweepOut(ctx, job, passage, actor);
        break;
      case "ashore":
        sweepAshore(ctx, job, passage, actor);
        break;
      case "back":
        sweepBack(ctx, job, passage, actor);
        break;
    }
    walkAboard(ctx, actor);
  }
}

// ---------------------------------------------------------------------------------------------
// endPassage (§4.2)
// ---------------------------------------------------------------------------------------------

/**
 * End `job`'s passage early, no fare. Ashore (or otherwise off the deck): `leftBehind`, and the
 * ship may leave. Aboard: `putOff`; the sweep walks them off at the next docking (now, if
 * docked). The job fails and its open luggage work is dropped where it stands.
 */
export function endPassageEarly(
  ctx: ApplyCtx,
  job: Job,
  cause: Pick<EventDraft, "causeIds" | "source">,
): void {
  const passage = job.passage;
  if (passage === undefined || passage.endReason !== undefined) return;
  const actor = ctx.state.actors[passage.actorId];
  const travel = ctx.state.travel;
  const portId = travel.stage === "docked" ? travel.portId : travel.toPortId;
  // "Aboard" here means on the map, the dock included (D61): a passenger standing on the dock is
  // still the ship's to walk off, so they are put off and leave through the sweep like anyone else.
  const aboard = actor !== undefined && actor.location.kind === "onDeck";
  const reason: PassageEndReason = passage.leg === "ashore" || !aboard ? "leftBehind" : "putOff";
  // Docked: they walk off here, and travel (which runs before the sweep) must not leave first.
  if (aboard && travel.stage === "docked") actor.disembarking = true;
  if (reason === "putOff") {
    // The passage was the voyage: putting them off cancels it. Docked, the course goes too (the
    // captain gets a `captainAshore` once they are off and nothing else holds); in transit the ship
    // finishes the leg it is on, and stops there instead of routing on to the far end.
    // `leftBehind` keeps the voyage home that was planned when they went ashore.
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete travel.voyageDestinationId;
    if (travel.stage === "docked") {
      // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
      delete travel.plannedDestinationId;
    }
  }
  job.status = "failed";
  job.closedTick = ctx.tick;
  for (const problem of Object.values(ctx.state.work.problems)) {
    if (problem.kind !== "cargoToLoad" && problem.kind !== "cargoToUnload") continue;
    if (problem.payload.jobId !== job.id || problem.status !== "open") continue;
    problem.status = "resolved";
  }
  endPassageWith(
    ctx,
    job,
    passage,
    actor ?? { id: passage.actorId, name: job.issuerPerson.name },
    reason,
    portId,
    cause,
  );
}
