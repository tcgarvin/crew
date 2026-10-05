/**
 * Venues (slice 4, call 12) on the lounge fixture: a games table seat not reserved and not spoken
 * for, the lounge floor once the table is full, one's own desk only in one's own cabin, a zone
 * tile, a session's fixed venue, and the venue someone is standing at.
 */
import { describe, expect, it } from "vitest";
import type { TestWorld } from "../../core/fixtures/test-world";
import type { TileCoord } from "../../core/types/common";
import type { ActorId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import type { StepTarget } from "../../core/types/work";
import { tryReserve } from "../spatial/reservations";
import {
  ACTIVITY,
  BETTINA,
  DANE,
  DESK_SEAT,
  JAX,
  LOUNGE,
  MARA,
  NOOR,
  TABLE_SEATS,
  TOMAS,
  VIEWPORT,
  loungeStepCtx,
  loungeWorld,
  placeInLounge,
  runFor,
} from "./fixtures/lounge-deck";
import { openSession } from "./sessions";
import { type ResolvedVenue, resolveVenue, venueAt } from "./venues";

function fresh(): TestWorld {
  const fixture = loungeWorld();
  runFor(fixture, 1);
  return fixture;
}

const actor = (world: World, id: ActorId) => {
  const found = world.state.actors[id];
  if (found === undefined) throw new Error(`no ${id}`);
  return found;
};

const def = (world: World, id: keyof typeof ACTIVITY) => {
  const found = world.content.activities[ACTIVITY[id]];
  if (found === undefined) throw new Error(`no ${id}`);
  return found;
};

/** The tile a resolved venue's target stands on. */
function targetTile(world: World, resolved: ResolvedVenue | undefined): TileCoord | undefined {
  const target = resolved?.target;
  if (target === undefined) return undefined;
  if (!("machineId" in target)) return target;
  return world.caches.nav.decks[LOUNGE.deck]?.interactionPositions.find(
    (p) => p.machineId === target.machineId && p.key === target.positionKey,
  )?.tile;
}

const isSeat = (tile: TileCoord | undefined): boolean =>
  TABLE_SEATS.some((s) => tile !== undefined && s.x === tile.x && s.y === tile.y);

function reserve(world: World, tile: TileCoord, id: ActorId): void {
  const geometry = world.caches.nav.decks[LOUNGE.deck];
  if (geometry === undefined) throw new Error("no geometry");
  tryReserve(world.caches, geometry, tile, id);
}

/** Give `id` a recreate plan whose next step is a walk to `target` (spoken for, not reserved). */
function walkingTo(world: World, id: ActorId, target: StepTarget): void {
  actor(world, id).activity = {
    kind: "personal",
    activity: "recreate",
    urgency: "routineObligation",
    action: {
      kind: "walk",
      stage: "moving",
      progress: 0,
      startedTick: world.state.tick,
      interruptible: true,
    },
    sinceTick: world.state.tick,
    plan: { steps: [{ kind: "moveTo", target, requested: false }], stepIndex: 0 },
  };
}

describe("resolveVenue", () => {
  it("takes the nearest games-table seat nobody holds or has a walk planned to", () => {
    const { world } = fresh();
    placeInLounge(world, JAX, { x: 3, y: 1 });
    const { ctx } = loungeStepCtx(world);
    const first = resolveVenue(ctx, actor(world, JAX), def(world, "cards"));
    expect(targetTile(world, first)).toEqual({ x: 4, y: 1 });
    expect(first !== undefined && "machineId" in first.venue).toBe(true);
    // Held by someone standing there, and spoken for by a walk in someone else's plan.
    reserve(world, { x: 4, y: 1 }, TOMAS);
    walkingTo(world, TOMAS, first?.target ?? { x: 0, y: 0 });
    const seat = world.caches.nav.decks[LOUNGE.deck]?.interactionPositions.find(
      (p) => p.tile.x === 4 && p.tile.y === 3,
    );
    if (seat === undefined) throw new Error("no seat_3");
    walkingTo(world, NOOR, { machineId: seat.machineId, positionKey: seat.key });
    const next = resolveVenue(ctx, actor(world, JAX), def(world, "cards"));
    expect(targetTile(world, next)).toEqual({ x: 5, y: 1 });
  });

  it("falls to the lounge floor once every seat at the table is taken", () => {
    const { world } = fresh();
    TABLE_SEATS.forEach((seat, i) => reserve(world, seat, [TOMAS, NOOR, BETTINA, DANE][i] ?? DANE));
    const { ctx } = loungeStepCtx(world);
    const resolved = resolveVenue(ctx, actor(world, JAX), def(world, "cards"));
    expect(resolved?.venue).toEqual({ compartmentId: expect.any(String) });
    const tile = targetTile(world, resolved);
    expect(world.content.decks[LOUNGE.deck]?.tiles[tile?.y ?? -1]?.[tile?.x ?? -1]).toBe("L");
    expect(isSeat(tile)).toBe(false);
  });

  it("reads at one's own desk only in one's own cabin", () => {
    const { world } = fresh();
    const { ctx } = loungeStepCtx(world);
    const mara = resolveVenue(ctx, actor(world, MARA), def(world, "reading"));
    expect(targetTile(world, mara)).toEqual(DESK_SEAT);
    const jax = resolveVenue(ctx, actor(world, JAX), def(world, "reading"));
    expect(jax !== undefined && "machineId" in jax.target).toBe(false);
  });

  it("stands at a free tile of a zone venue", () => {
    const { world } = fresh();
    const { ctx } = loungeStepCtx(world);
    const resolved = resolveVenue(ctx, actor(world, MARA), def(world, "stargazing"));
    expect(resolved?.venue).toMatchObject({ zoneKey: "viewport" });
    expect(VIEWPORT).toContainEqual(targetTile(world, resolved));
  });

  it("takes a free spot of a session's fixed venue", () => {
    const { world } = fresh();
    placeInLounge(world, JAX, TABLE_SEATS[0] ?? { x: 4, y: 1 });
    const { ctx } = loungeStepCtx(world);
    const here = venueAt(ctx, actor(world, JAX), def(world, "cards"));
    if (here === undefined) throw new Error("Jax is not at the table");
    expect(here).toMatchObject({ machineId: expect.any(String) });
    reserve(world, TABLE_SEATS[0] ?? { x: 4, y: 1 }, JAX);
    const id = openSession(ctx, actor(world, JAX), def(world, "cards"), here);
    const session = world.state.social.sessions[id];
    const joined = resolveVenue(ctx, actor(world, TOMAS), def(world, "cards"), session);
    expect(joined?.venue).toEqual(here);
    expect(isSeat(targetTile(world, joined))).toBe(true);
    expect(targetTile(world, joined)).not.toEqual(TABLE_SEATS[0]);
  });
});
