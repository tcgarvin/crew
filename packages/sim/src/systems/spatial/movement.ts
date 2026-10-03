/**
 * Authoritative movement (SD §7.1, §7.3, §7.4). Phase 3, every tick.
 *
 * A moving actor walks `path` (tile centres) segment by segment; its `onDeck` x/y is rewritten
 * every tick from `segmentIndex` and `segmentDistanceTravelled`, so position is continuous and a
 * save resumes exactly. Gates (walkable tile, door open, destination position free) are checked
 * only at a segment's start, where the actor stands on a tile centre; progress never accumulates
 * while blocked.
 *
 * W3 decisions:
 * - Speed = `walkSpeed × capacities.movement × fatigue × load × trait walkSpeed × overlap`.
 *   fatigue = 1 − (1 − fatigueSpeedFloor) × needs.fatigue; load = max(loadSpeedFloor,
 *   1 − loadSpeedPerKg × kg held directly (not container contents)).
 * - Corridor passing (SD §7.4): while another on-deck actor is within 0.5 tile the speed is
 *   multiplied by `1 / (1 + walkSpeed × passDelaySeconds)`, i.e. crossing a one-tile overlap
 *   costs about `passDelaySeconds` extra. No `overlapSpeedFactor` config field was added.
 * - Waiting on a door that will open (power or manual) is unbounded; waiting on one that will
 *   not, or on an occupied destination position, gives up after `blockedRerouteSeconds`.
 * - Actors who are not `available` keep their route but do not advance.
 * - A route that ends early leaves the actor `stationary` with `routeFailure` set; W4 replans.
 */
import { configTicks } from "../../core/clock";
import type { Actor, KnownFact, RouteFailure } from "../../core/types/actor";
import type { OnDeckLocation, TileCoord } from "../../core/types/common";
import type { ConfigDef } from "../../core/types/content";
import type {
  ActorId,
  CompartmentId,
  DeckDefId,
  DoorId,
  LocalKey,
  MachineId,
} from "../../core/types/ids";
import type { DeckGeometry } from "../../core/types/nav";
import type { DerivedCaches, StepCtx, System } from "../../core/types/pipeline";
import type { Door } from "../../core/types/ship";
import type { WorldState } from "../../core/types/state";
import { doorWillOpen } from "./doors";
import {
  compartmentAt,
  doorBetween,
  inBounds,
  isDockTile,
  isStaticWalkable,
  isWalkable,
} from "./geometry";
import { cachedPath, pathLength, stepLength } from "./pathfind";
import { holdsReservation, releaseReservations, tileCapacity, tryReserve } from "./reservations";
import { actorPolicy } from "./routing";

const EPS = 1e-9;

type Moving = Extract<Actor["movement"], { kind: "moving" }>;

/** A machine's interaction position, by placement-independent key. */
export interface InteractionTarget {
  readonly machineId: MachineId;
  readonly positionKey: LocalKey;
}

export type MoveTarget = TileCoord | InteractionTarget;

export const centre = (tile: TileCoord): { x: number; y: number } => ({
  x: tile.x + 0.5,
  y: tile.y + 0.5,
});

export const tileOf = (location: { x: number; y: number }): TileCoord => ({
  x: Math.floor(location.x),
  y: Math.floor(location.y),
});

/** Resolve a move target to a tile on this deck, or undefined if it is not one. */
export function resolveTarget(geometry: DeckGeometry, target: MoveTarget): TileCoord | undefined {
  if ("machineId" in target) {
    const position = geometry.interactionPositions.find(
      (p) => p.machineId === target.machineId && p.key === target.positionKey,
    );
    return position?.tile;
  }
  if (!Number.isInteger(target.x) || !Number.isInteger(target.y)) return undefined;
  return inBounds(geometry, target.x, target.y) ? { x: target.x, y: target.y } : undefined;
}

/** Continuous position of a moving actor derived from its route. */
export function derivedPosition(movement: Moving): { x: number; y: number } | undefined {
  const a = movement.path[movement.segmentIndex];
  if (a === undefined) return undefined;
  const b = movement.path[movement.segmentIndex + 1];
  if (b === undefined || movement.segmentDistanceTravelled === 0) return centre(a);
  const t = movement.segmentDistanceTravelled / stepLength(a, b);
  return { x: a.x + 0.5 + (b.x - a.x) * t, y: a.y + 0.5 + (b.y - a.y) * t };
}

const copyPath = (path: readonly TileCoord[]): TileCoord[] => path.map((t) => ({ x: t.x, y: t.y }));

/**
 * Start (or redirect) a walk to a tile or an interaction position. Plans with the actor's
 * knowledge (see routing.ts). A mid-segment actor keeps its continuous position: the new route
 * either continues the current segment or reverses along it, whichever is shorter. Reserves the
 * destination if it is an interaction position with room (otherwise the actor will wait next to
 * it) and releases the actor's other reservations. Clears any `routeFailure`.
 *
 * Returns false, leaving the actor untouched, if the actor is not on deck and available or no
 * route is known. Standing on the target already counts as success (the actor is stationary).
 */
export function requestMove(
  state: WorldState,
  actorId: ActorId,
  target: MoveTarget,
  caches: DerivedCaches,
  config: ConfigDef,
): boolean {
  const actor = state.actors[actorId];
  if (actor === undefined || actor.availability !== "available") return false;
  const location = actor.location;
  if (location.kind !== "onDeck") return false;
  const geometry = caches.nav.decks[location.deckId];
  if (geometry === undefined) return false;
  const destination = resolveTarget(geometry, target);
  if (destination === undefined) return false;
  const policy = actorPolicy(state, geometry, actor, config);
  const route = (from: TileCoord) => cachedPath(caches, geometry, from, destination, policy);
  const current = actor.movement;

  let path: TileCoord[];
  let travelled = 0;
  if (current.kind === "moving" && current.segmentDistanceTravelled > 0) {
    const a = current.path[current.segmentIndex] as TileCoord;
    const b = current.path[current.segmentIndex + 1] as TileCoord;
    const length = stepLength(a, b);
    const done = current.segmentDistanceTravelled;
    const onward = route(b);
    const back = route(a);
    const onwardCost =
      onward === null ? Number.POSITIVE_INFINITY : length - done + pathLength(onward);
    const backCost = back === null ? Number.POSITIVE_INFINITY : done + pathLength(back);
    if (onward !== null && onwardCost <= backCost) {
      path = [{ x: a.x, y: a.y }, ...copyPath(onward)];
      travelled = done;
    } else if (back !== null) {
      path = [{ x: b.x, y: b.y }, ...copyPath(back)];
      travelled = length - done;
    } else {
      return false;
    }
  } else {
    const here =
      current.kind === "moving"
        ? (current.path[current.segmentIndex] as TileCoord)
        : tileOf(location);
    const found = route(here);
    if (found === null) return false;
    if (found.length === 1) {
      releaseReservations(caches, actorId, { deckId: geometry.deckId, tile: destination });
      tryReserve(caches, geometry, destination, actorId);
      actor.movement = { kind: "stationary" };
      actor.location = { kind: "onDeck", deckId: location.deckId, ...centre(destination) };
      return true;
    }
    path = copyPath(found);
  }

  releaseReservations(caches, actorId, { deckId: geometry.deckId, tile: destination });
  tryReserve(caches, geometry, destination, actorId);
  actor.movement = {
    kind: "moving",
    path,
    segmentIndex: 0,
    segmentDistanceTravelled: travelled,
    effectiveSpeed:
      current.kind === "moving"
        ? current.effectiveSpeed
        : config.movement.walkSpeed * actor.capacities.movement,
    navigationKnowledgeRevision: actor.navigationKnowledgeRevision,
  };
  return true;
}

/**
 * Stop as soon as possible without leaving a tile centre: immediately if standing on one, else at
 * the end of the current segment. For interruptions (W4).
 */
export function stopMovement(state: WorldState, caches: DerivedCaches, actorId: ActorId): void {
  const actor = state.actors[actorId];
  if (actor === undefined || actor.movement.kind !== "moving") return;
  const movement = actor.movement;
  const here = movement.path[movement.segmentIndex];
  if (movement.segmentDistanceTravelled === 0 || here === undefined) {
    releaseReservations(caches, actorId);
    actor.movement = { kind: "stationary" };
    return;
  }
  movement.path = movement.path.slice(0, movement.segmentIndex + 2);
  // biome-ignore lint/performance/noDelete: state must omit the key (CONTRACTS rule 2).
  delete movement.blockedSinceTick;
}

// ---------------------------------------------------------------------------------------------
// Speed
// ---------------------------------------------------------------------------------------------

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function overlapSpeedFactor(config: ConfigDef): number {
  return 1 / (1 + config.movement.walkSpeed * config.movement.passDelaySeconds);
}

function carriedMass(ctx: StepCtx, actorId: ActorId): number {
  let kg = 0;
  for (const itemId of ctx.caches.index.itemsByHolder[actorId] ?? []) {
    const item = ctx.state.items[itemId];
    if (item === undefined) continue;
    const mass = ctx.defs.item(item.defId).mass;
    kg += item.stacking === "stack" ? mass * item.count : mass;
  }
  return kg;
}

function isOverlapping(actor: Actor, location: OnDeckLocation, actors: readonly Actor[]): boolean {
  for (const other of actors) {
    if (other.id === actor.id || other.location.kind !== "onDeck") continue;
    if (other.location.deckId !== location.deckId) continue;
    const dx = other.location.x - location.x;
    const dy = other.location.y - location.y;
    if (dx * dx + dy * dy < 0.25) return true;
  }
  return false;
}

export function effectiveSpeed(
  ctx: StepCtx,
  actor: Actor,
  location: OnDeckLocation,
  actors: readonly Actor[],
): number {
  const movement = ctx.config.movement;
  const fatigue = 1 - (1 - movement.fatigueSpeedFloor) * clamp01(actor.needs.fatigue);
  const load = Math.max(
    movement.loadSpeedFloor,
    1 - movement.loadSpeedPerKg * carriedMass(ctx, actor.id),
  );
  let trait = 1;
  for (const traitId of actor.traits) trait *= ctx.defs.trait(traitId).modifiers.walkSpeed ?? 1;
  const overlap = isOverlapping(actor, location, actors) ? overlapSpeedFactor(ctx.config) : 1;
  return movement.walkSpeed * clamp01(actor.capacities.movement) * fatigue * load * trait * overlap;
}

// ---------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------

function setPosition(actor: Actor, deckId: DeckDefId, point: { x: number; y: number }): void {
  actor.location = { kind: "onDeck", deckId, x: point.x, y: point.y };
}

function moveInIndex(
  caches: DerivedCaches,
  actorId: ActorId,
  from: CompartmentId | undefined,
  to: CompartmentId | undefined,
): void {
  const table = caches.index.actorsByCompartment;
  if (from !== undefined) {
    const rest = (table[from] ?? []).filter((id) => id !== actorId);
    if (rest.length === 0) delete table[from];
    else table[from] = rest;
  }
  if (to !== undefined) table[to] = [...(table[to] ?? []), actorId];
}

function learnDoorWontOpen(ctx: StepCtx, actor: Actor, door: Door): void {
  const fact: KnownFact = {
    subjectId: door.id,
    factType: "doorState",
    value: { physicalState: "jammed" },
    observedTick: ctx.tick,
    learnedTick: ctx.tick,
    sourceId: actor.id,
    evidence: "direct",
    certainty: door.physicalState === "jammed" ? "confirmed" : "suspected",
  };
  actor.knowledge[`${door.id}/doorState`] = fact;
  actor.navigationKnowledgeRevision += 1;
}

function endRoute(
  ctx: StepCtx,
  actor: Actor,
  geometry: DeckGeometry,
  at: TileCoord,
  failure: RouteFailure,
): void {
  releaseReservations(ctx.caches, actor.id);
  actor.movement = { kind: "stationary", routeFailure: failure };
  setPosition(actor, geometry.deckId, centre(at));
}

function blocked(
  ctx: StepCtx,
  actor: Actor,
  geometry: DeckGeometry,
  at: TileCoord,
  tile: TileCoord,
  doorId?: DoorId,
): void {
  ctx.emit({
    type: "routeBlocked",
    subjectIds: doorId === undefined ? [actor.id] : [actor.id, doorId],
    locationRef: { kind: "tile", deckId: geometry.deckId, x: tile.x, y: tile.y },
    causeIds: [],
    source: "sim",
    payload: doorId === undefined ? { tile } : { tile, doorId },
  });
  endRoute(ctx, actor, geometry, at, { tick: ctx.tick, reason: "blocked", tile });
}

type Gate = "go" | "wait" | "ended";

/** Checks at the start of segment a→b, with the actor standing on a's centre. */
function enterSegment(
  ctx: StepCtx,
  actor: Actor,
  movement: Moving,
  geometry: DeckGeometry,
  a: TileCoord,
  b: TileCoord,
): Gate {
  const rerouteTicks = configTicks(ctx.config, ctx.config.movement.blockedRerouteSeconds);
  const waitedOut = () => {
    movement.blockedSinceTick ??= ctx.tick;
    return ctx.tick - movement.blockedSinceTick >= rerouteTicks;
  };

  for (const tile of a.x !== b.x && a.y !== b.y
    ? [{ x: b.x, y: a.y }, { x: a.x, y: b.y }, b]
    : [b]) {
    if (!isWalkable(geometry, tile.x, tile.y)) {
      blocked(ctx, actor, geometry, a, tile);
      return "ended";
    }
  }

  const doorId = doorBetween(geometry, a, b);
  if (doorId !== undefined) {
    const door = ctx.state.doors[doorId];
    const nav = geometry.doors.get(doorId);
    if (door === undefined || nav === undefined) throw new Error(`Unknown door ${doorId}`);
    movement.doorId = doorId;
    if (door.physicalState === "jammed") {
      learnDoorWontOpen(ctx, actor, door);
      blocked(ctx, actor, geometry, a, b, doorId);
      return "ended";
    }
    if (door.physicalState !== "open" && door.kind === "ramp") {
      // Dockside spike: travel owns ramps. Wait while one is lowering; otherwise the dock is cut
      // off and the route ends here (planning already treats a closed ramp as impassable, so no
      // door fact is needed).
      if (doorWillOpen(ctx.state, door, nav)) return "wait";
      blocked(ctx, actor, geometry, a, b, doorId);
      return "ended";
    }
    if (door.physicalState !== "open") {
      door.requestedState = "open";
      if (waitedOut() && !doorWillOpen(ctx.state, door, nav)) {
        learnDoorWontOpen(ctx, actor, door);
        blocked(ctx, actor, geometry, a, b, doorId);
        return "ended";
      }
      return "wait";
    }
  } else {
    // biome-ignore lint/performance/noDelete: state must omit the key (CONTRACTS rule 2).
    delete movement.doorId;
  }

  const final = movement.segmentIndex + 2 === movement.path.length;
  if (
    final &&
    tileCapacity(geometry, b) !== Number.POSITIVE_INFINITY &&
    !holdsReservation(ctx.caches, geometry.deckId, b, actor.id) &&
    !tryReserve(ctx.caches, geometry, b, actor.id)
  ) {
    // biome-ignore lint/performance/noDelete: state must omit the key (CONTRACTS rule 2).
    delete movement.doorId;
    if (waitedOut()) {
      endRoute(ctx, actor, geometry, a, { tick: ctx.tick, reason: "positionTaken", tile: b });
      return "ended";
    }
    return "wait";
  }

  // biome-ignore lint/performance/noDelete: state must omit the key (CONTRACTS rule 2).
  delete movement.blockedSinceTick;
  return "go";
}

function arrive(ctx: StepCtx, actor: Actor, geometry: DeckGeometry, tile: TileCoord): void {
  releaseReservations(ctx.caches, actor.id, { deckId: geometry.deckId, tile });
  actor.movement = { kind: "stationary" };
  setPosition(actor, geometry.deckId, centre(tile));
  ctx.emit({
    type: "reachedTile",
    subjectIds: [actor.id],
    locationRef: { kind: "tile", deckId: geometry.deckId, x: tile.x, y: tile.y },
    causeIds: [],
    source: "sim",
    payload: { tile: { x: tile.x, y: tile.y } },
  });
}

/**
 * D61: a finished step between ship floor and dock floor went down or up a ramp (the hull walls
 * every other edge between them). Movement is the only place that sees the crossing, so it says
 * so: `wentAshore` / `cameAboard`, for the narrator digest and the captain-ashore hook to come.
 */
function crossedRamp(
  ctx: StepCtx,
  actor: Actor,
  geometry: DeckGeometry,
  a: TileCoord,
  b: TileCoord,
): void {
  const fromDock = isDockTile(geometry, a.x, a.y);
  if (fromDock === isDockTile(geometry, b.x, b.y)) return;
  const rampId = doorBetween(geometry, a, b);
  if (rampId === undefined) throw new Error(`Step ${a.x},${a.y}→${b.x},${b.y} crossed the hull`);
  ctx.emit({
    type: fromDock ? "cameAboard" : "wentAshore",
    subjectIds: [actor.id, rampId],
    locationRef: { kind: "tile", deckId: geometry.deckId, x: b.x, y: b.y },
    causeIds: [],
    source: "sim",
    payload: { rampId },
  });
}

/** Walk one actor up to `budget` tiles this tick. */
function advanceActor(
  ctx: StepCtx,
  actor: Actor,
  movement: Moving,
  geometry: DeckGeometry,
  budget: number,
): void {
  const deckId = geometry.deckId;
  const start = actor.location as OnDeckLocation;
  let compartment = compartmentAt(geometry, start.x, start.y);
  let remaining = budget;

  for (;;) {
    const a = movement.path[movement.segmentIndex];
    const b = movement.path[movement.segmentIndex + 1];
    if (a === undefined) {
      actor.movement = { kind: "stationary" };
      return;
    }
    if (b === undefined) {
      arrive(ctx, actor, geometry, a);
      return;
    }

    if (movement.segmentDistanceTravelled === 0) {
      if (actor.navigationKnowledgeRevision !== movement.navigationKnowledgeRevision) {
        const destination = movement.path[movement.path.length - 1] as TileCoord;
        const policy = actorPolicy(ctx.state, geometry, actor, ctx.config);
        const route = cachedPath(ctx.caches, geometry, a, destination, policy);
        if (route === null) {
          endRoute(ctx, actor, geometry, a, {
            tick: ctx.tick,
            reason: "unreachable",
            tile: destination,
          });
          return;
        }
        movement.path = copyPath(route);
        movement.segmentIndex = 0;
        movement.navigationKnowledgeRevision = actor.navigationKnowledgeRevision;
        continue;
      }
      if (enterSegment(ctx, actor, movement, geometry, a, b) !== "go") return;
    }
    if (remaining <= EPS) return;

    const length = stepLength(a, b);
    const step = Math.min(remaining, length - movement.segmentDistanceTravelled);
    movement.segmentDistanceTravelled += step;
    remaining -= step;
    actor.facing = Math.atan2(b.y - a.y, b.x - a.x);
    const completed = movement.segmentDistanceTravelled >= length - EPS;
    if (completed) {
      if (geometry.dock !== undefined) crossedRamp(ctx, actor, geometry, a, b);
      movement.segmentIndex += 1;
      movement.segmentDistanceTravelled = 0;
      // biome-ignore lint/performance/noDelete: state must omit the key (CONTRACTS rule 2).
      delete movement.doorId;
    }
    const point = derivedPosition(movement) ?? centre(b);
    setPosition(actor, deckId, point);

    const now = compartmentAt(geometry, point.x, point.y);
    if (now !== compartment) {
      moveInIndex(ctx.caches, actor.id, compartment, now);
      if (now !== undefined) {
        ctx.emit({
          type: "enteredCompartment",
          subjectIds: [actor.id],
          locationRef: { kind: "compartment", compartmentId: now },
          causeIds: [],
          source: "sim",
          payload:
            compartment === undefined
              ? { compartmentId: now }
              : { compartmentId: now, fromCompartmentId: compartment },
        });
      }
      compartment = now;
    }
    if (!completed) return;
  }
}

/** Recompute each door's aperture occupants: actors whose current segment crosses it. */
function updateDoorOccupants(ctx: StepCtx): void {
  const occupants = new Map<DoorId, ActorId[]>();
  for (const actor of Object.values(ctx.state.actors)) {
    const movement = actor.movement;
    if (movement.kind !== "moving" || actor.location.kind !== "onDeck") continue;
    const a = movement.path[movement.segmentIndex];
    const b = movement.path[movement.segmentIndex + 1];
    const geometry = ctx.caches.nav.decks[actor.location.deckId];
    if (a === undefined || b === undefined || geometry === undefined) continue;
    const doorId = doorBetween(geometry, a, b);
    if (doorId === undefined) continue;
    occupants.set(doorId, [...(occupants.get(doorId) ?? []), actor.id]);
  }
  for (const door of Object.values(ctx.state.doors)) {
    const next = occupants.get(door.id) ?? [];
    const same =
      next.length === door.occupants.length && next.every((id, i) => door.occupants[i] === id);
    if (!same) door.occupants = next;
  }
}

export const movementSystem: System = {
  name: "spatial.movement",
  phase: "actions",
  run(ctx) {
    const dt = ctx.elapsedTicks / ctx.config.time.tickRate;
    const actors = Object.values(ctx.state.actors);
    for (const actor of actors) {
      const movement = actor.movement;
      if (movement.kind !== "moving") continue;
      const location = actor.location;
      if (location.kind !== "onDeck") {
        // Carried or off ship: a route is meaningless.
        releaseReservations(ctx.caches, actor.id);
        actor.movement = { kind: "stationary" };
        continue;
      }
      if (actor.availability !== "available") continue;
      const geometry = ctx.caches.nav.decks[location.deckId];
      if (geometry === undefined) throw new Error(`No nav geometry for ${location.deckId}`);
      const speed = effectiveSpeed(ctx, actor, location, actors);
      movement.effectiveSpeed = speed;
      advanceActor(ctx, actor, movement, geometry, speed * dt);
    }
    updateDoorOccupants(ctx);
  },
};

/** For invariant checks: is this on-deck point on floor a person may stand on? */
export function isStandable(geometry: DeckGeometry, point: { x: number; y: number }): boolean {
  const tile = tileOf(point);
  return isStaticWalkable(geometry, tile.x, tile.y);
}
