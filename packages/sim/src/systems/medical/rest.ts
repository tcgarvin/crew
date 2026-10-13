/**
 * §the-body-aboard and §laid-to-rest: the ship's dead.
 *
 * - `restingPlaces` (content alone, cached per deck): where bodies are laid out aboard. The open
 *   floor of the compartment holding the cargo ramp's transfer tile (the cargo hold on both
 *   freighters), leaving out every zone tile, the tiles at its doors and openings, every machine's
 *   interaction positions, the ramps' transfer tiles and the spawn points; the most tucked away
 *   first (fewest open neighbours in the room: a corner before a wall before the middle), then
 *   nearest the cargo ramp, then by row and column.
 * - `sweepBodies` (the medical system, every tick): docked at a port (never a site), every dead
 *   member of the ship's company aboard or on the dock is carried ashore (`layToRest`); otherwise
 *   each one lying aboard away from a resting place has a `bodyAboard` problem (owner medical,
 *   dedupe `body:<actorId>`, public, routine), naming the first resting place no other body lies
 *   at or is bound for. It is resolved once the body lies there, cancelled once it is off the ship. A
 *   body the carry already laid out is left where it lies.
 * - `layToRest`: the dead leave the ship for the port's lounge store (`inExternalStore`, still
 *   `dead`); anything they held or wore is set down where they lay, so the ship's gear stays
 *   aboard. Emits `laidToRest`.
 */
import { isOnDock } from "../../core/docks";
import { allocateId } from "../../core/ids";
import { isSite } from "../../core/places";
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly, TileCoord } from "../../core/types/common";
import type { ContentBundle, DeckDef } from "../../core/types/content";
import type { ActorId, CompartmentId, PortDefId } from "../../core/types/ids";
import type { ReadonlyWorldState, StepCtx } from "../../core/types/pipeline";
import type { ProblemOfKind } from "../../core/types/work";
import { shipDeckId } from "../../core/world";
import { shipsCompany } from "../bodies/death";
import { loungeLocation } from "../commerce/passage";
import { compartmentFloor, doorTiles, symbolAt } from "../damage/deck";
import { rotateOffset } from "../spatial/geometry";
import { releaseReservations } from "../spatial/reservations";
import { emitSim } from "../work/events";
import { tileOf } from "../work/plans";
import { touchInventory } from "../work/steps";

type Deck = DeepReadonly<DeckDef>;
type RestContent = Pick<ContentBundle, "decks" | "machines">;

export const bodyKey = (actorId: ActorId): string => `body:${actorId}`;

const keyOf = (t: TileCoord): string => `${t.x},${t.y}`;
const sameTile = (a: TileCoord, b: TileCoord): boolean => a.x === b.x && a.y === b.y;

const placesCache = new WeakMap<Deck, readonly TileCoord[]>();

/** Tiles no body is laid on: zones, the room's doorways, machine positions, ramps, spawns. */
function keptClear(content: RestContent, deck: Deck, symbol: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const zone of deck.zones) for (const t of zone.tiles) out.add(keyOf(t));
  for (const t of doorTiles(content, deck, symbol)) out.add(keyOf(t));
  for (const placement of deck.machines) {
    const def = content.machines[placement.machineDefId];
    for (const position of def?.interactionPositions ?? []) {
      const r = rotateOffset(position.offset, placement.rotation);
      out.add(keyOf({ x: placement.origin.x + r.x, y: placement.origin.y + r.y }));
    }
  }
  for (const t of deck.docking.cargoTransferTiles) out.add(keyOf(t));
  for (const t of deck.docking.personnelTransferTiles) out.add(keyOf(t));
  for (const point of deck.spawnPoints) out.add(keyOf(point.tile));
  return out;
}

/** §the-body-aboard: the deck's resting places for the dead, best first. */
export function restingPlaces(content: RestContent, deck: Deck): readonly TileCoord[] {
  const cached = placesCache.get(deck);
  if (cached !== undefined) return cached;
  const ramp = deck.docking.cargoTransferTiles[0] ?? deck.docking.personnelTransferTiles[0];
  const symbol = ramp === undefined ? undefined : symbolAt(deck, ramp);
  if (ramp === undefined || symbol === undefined) {
    placesCache.set(deck, []);
    return [];
  }
  const floor = compartmentFloor(content, deck, symbol);
  const floorKeys = new Set(floor.map(keyOf));
  const clear = keptClear(content, deck, symbol);
  const openAround = (t: TileCoord): number => {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx !== 0 || dy !== 0) && floorKeys.has(keyOf({ x: t.x + dx, y: t.y + dy }))) n += 1;
      }
    }
    return n;
  };
  const dist2 = (t: TileCoord): number => (t.x - ramp.x) ** 2 + (t.y - ramp.y) ** 2;
  const places = floor
    .filter((t) => !clear.has(keyOf(t)))
    .map((t) => ({ t, open: openAround(t), d: dist2(t) }))
    .sort((a, b) => a.open - b.open || a.d - b.d || a.t.y - b.t.y || a.t.x - b.t.x)
    .map(({ t }) => t);
  placesCache.set(deck, places);
  return places;
}

/**
 * Where a body lies aboard: its tile on the ship's floor (off the dock, unless `dock` is
 * `"withDock"`), or its carrier's when someone there carries it. Undefined anywhere else.
 */
function bodyTile(
  content: RestContent,
  state: Pick<ReadonlyWorldState, "deck" | "actors">,
  body: DeepReadonly<Actor>,
  dock: "aboard" | "withDock" = "aboard",
): TileCoord | undefined {
  const location =
    body.location.kind === "carriedBy"
      ? state.actors[body.location.actorId]?.location
      : body.location;
  if (location?.kind !== "onDeck" || location.deckId !== shipDeckId(state)) return undefined;
  if (dock === "aboard" && isOnDock(content, state, location)) return undefined;
  return tileOf(location);
}

/** One of the ship's company, dead and out of any fight. */
const deadOfTheShip = (actor: DeepReadonly<Actor>): boolean =>
  actor.availability === "dead" && shipsCompany(actor) && actor.combatant === undefined;

/** Lying (not carried) on `tile` of the ship's floor. */
function lyingOn(
  state: Pick<ReadonlyWorldState, "deck">,
  actor: DeepReadonly<Actor>,
  tile: TileCoord,
): boolean {
  const location = actor.location;
  return (
    location.kind === "onDeck" &&
    location.deckId === shipDeckId(state) &&
    sameTile(tileOf(location), tile)
  );
}

/**
 * Someone other than `bodyId` takes `tile`: another body lying there, or a living person standing
 * still on it (someone walking across does not).
 */
export function restingPlaceTaken(
  state: Pick<ReadonlyWorldState, "deck" | "actors">,
  tile: TileCoord,
  bodyId: ActorId,
): boolean {
  return Object.values(state.actors).some(
    (other) =>
      other.id !== bodyId &&
      (other.availability === "dead" || other.movement.kind !== "moving") &&
      lyingOn(state, other, tile),
  );
}

function bodyProblems(state: Pick<ReadonlyWorldState, "work">): ProblemOfKind<"bodyAboard">[] {
  return Object.values(state.work.problems).filter(
    (p): p is ProblemOfKind<"bodyAboard"> => p.kind === "bodyAboard",
  );
}

/** The first resting place no other body lies at or is bound for. */
function restingPlaceFor(
  ctx: Pick<StepCtx, "content" | "state">,
  body: DeepReadonly<Actor>,
): TileCoord | undefined {
  const deck = ctx.content.decks[shipDeckId(ctx.state)];
  if (deck === undefined) return undefined;
  const bound = new Set(
    bodyProblems(ctx.state)
      .filter((p) => p.status === "open" && p.payload.actorId !== body.id)
      .map((p) => keyOf(p.payload.tile)),
  );
  const lying = Object.values(ctx.state.actors).filter(
    (other) => other.id !== body.id && other.availability === "dead",
  );
  return restingPlaces(ctx.content, deck).find(
    (t) => !bound.has(keyOf(t)) && !lying.some((other) => lyingOn(ctx.state, other, t)),
  );
}

/** The ship's compartment instance holding `tile`. */
function compartmentAt(
  ctx: Pick<StepCtx, "content" | "state">,
  tile: TileCoord,
): CompartmentId | undefined {
  const deckId = shipDeckId(ctx.state);
  const deck = ctx.content.decks[deckId];
  if (deck === undefined) return undefined;
  const symbol = symbolAt(deck, tile);
  const key = deck.compartments.find((c) => c.symbol === symbol)?.key;
  return Object.values(ctx.state.compartments).find((c) => c.deckId === deckId && c.key === key)
    ?.id;
}

/** Laid out by an earlier carry, and still lying where it was laid. */
function alreadyLaidOut(ctx: Pick<StepCtx, "state">, body: DeepReadonly<Actor>): boolean {
  return bodyProblems(ctx.state).some(
    (p) =>
      p.status === "resolved" &&
      p.payload.actorId === body.id &&
      lyingOn(ctx.state, body, p.payload.tile),
  );
}

function raise(ctx: StepCtx, body: Actor, tile: TileCoord, compartmentId: CompartmentId): void {
  const id = allocateId(ctx.state, "problem");
  ctx.state.work.problems[id] = {
    id,
    kind: "bodyAboard",
    payload: { actorId: body.id, tile: { x: tile.x, y: tile.y } },
    owner: "medical",
    visibility: "public",
    dedupeKey: bodyKey(body.id),
    status: "open",
    createdTick: ctx.tick,
    revision: 1,
    baseUrgency: "routineObligation",
    location: { kind: "compartment", compartmentId },
  };
  emitSim(ctx, "problemRaised", [id], { problemId: id, kind: "bodyAboard" });
}

/** Settle the open body problems: resolved once laid at their place, cancelled once ashore. */
function settleBodies(ctx: StepCtx): Set<ActorId> {
  const open = new Set<ActorId>();
  for (const problem of bodyProblems(ctx.state)) {
    if (problem.status !== "open") continue;
    const body = ctx.state.actors[problem.payload.actorId];
    if (body === undefined || bodyTile(ctx.content, ctx.state, body) === undefined) {
      problem.status = "cancelled";
    } else if (lyingOn(ctx.state, body, problem.payload.tile)) {
      problem.status = "resolved";
      emitSim(ctx, "problemResolved", [problem.id], {
        problemId: problem.id,
        kind: problem.kind,
      });
    } else {
      open.add(body.id);
    }
  }
  return open;
}

/** The port the ship is docked at, if it is a port (never a landing site). */
function dockedPort(ctx: Pick<StepCtx, "state" | "content">): PortDefId | undefined {
  const travel = ctx.state.travel;
  if (travel.stage !== "docked" || isSite(ctx.content, travel.portId)) return undefined;
  return travel.portId;
}

/** Everything `body` holds or wears goes down where they lay: the ship keeps its gear. */
function leaveGear(ctx: StepCtx, body: Actor, at: TileCoord): void {
  let moved = false;
  for (const item of Object.values(ctx.state.items)) {
    const held = item.location;
    if ((held.kind !== "carriedBy" && held.kind !== "equippedBy") || held.actorId !== body.id) {
      continue;
    }
    item.location = { kind: "onDeck", deckId: shipDeckId(ctx.state), x: at.x + 0.5, y: at.y + 0.5 };
    moved = true;
  }
  if (moved) touchInventory(ctx);
}

/** §laid-to-rest: `body` is carried ashore at `portId` and leaves the ship. */
export function layToRest(ctx: StepCtx, body: Actor, portId: PortDefId): void {
  const port = ctx.content.ports[portId];
  if (port === undefined) throw new Error(`layToRest: no port "${portId}"`);
  const at = bodyTile(ctx.content, ctx.state, body, "withDock");
  if (at === undefined) throw new Error(`layToRest: ${body.id} is not aboard or on the dock`);
  leaveGear(ctx, body, at);
  releaseReservations(ctx.caches, body.id);
  body.movement = { kind: "stationary" };
  body.activity = { kind: "idle" };
  // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
  delete body.pendingIntent;
  body.location = loungeLocation(port);
  emitSim(ctx, "laidToRest", [body.id], { actorId: body.id, portId });
}

/** §the-body-aboard, §laid-to-rest: one tick of the ship's dead. */
export function sweepBodies(ctx: StepCtx): void {
  const port = dockedPort(ctx);
  const dead = Object.values(ctx.state.actors)
    .filter(deadOfTheShip)
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  if (port !== undefined) {
    for (const body of dead) {
      if (bodyTile(ctx.content, ctx.state, body, "withDock") !== undefined) {
        layToRest(ctx, body, port);
      }
    }
  }
  const open = settleBodies(ctx);
  if (port !== undefined) return;
  for (const body of dead) {
    if (bodyTile(ctx.content, ctx.state, body) === undefined) continue;
    if (open.has(body.id) || alreadyLaidOut(ctx, body)) continue;
    const tile = restingPlaceFor(ctx, body);
    if (tile === undefined) continue;
    if (body.location.kind === "onDeck" && lyingOn(ctx.state, body, tile)) continue;
    const compartmentId = compartmentAt(ctx, tile);
    if (compartmentId === undefined) {
      throw new Error(`medical: resting place ${keyOf(tile)} is in no compartment`);
    }
    raise(ctx, body, tile, compartmentId);
  }
}
