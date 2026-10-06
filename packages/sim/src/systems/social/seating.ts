/**
 * Seats (slice 4, call 11): which free mess seat an eater takes (`systems/galley/eat.ts`
 * `eatPlan` passes them all), and the captain's table.
 *
 * `seatPreference(ctx, actor, seats)`: `seats` are the free mess seats, nearest the food first,
 * with the one the actor already holds (if any) first of all and marked `held`; seats spoken for
 * by someone else's plan are already left out. The choice:
 *
 * 1. a held seat stays;
 * 2. the captain, once a ship's day (`social.captainsTableDay` older than today), takes the free
 *    seat beside the crew member at the tables she has the highest affinity with (even days) or
 *    the lowest (odd days; the captain mends fences, so the avoid rule does not apply): both
 *    remember `sharedATable`,
 *    the crew member `satWithTheCaptain`, `captainsTable` (trace), the day recorded;
 * 3. else, among seats beside nobody at or below `social.avoidBelow`, the nearest beside someone
 *    the actor has affinity above `social.preferAbove` with;
 * 4. else the nearest of those;
 * 5. else none (every free seat is beside someone avoided): the caller eats at the floor spot.
 *
 * "Beside" is within arm's reach (a tile or a diagonal). Where someone is: the mess seat their
 * plan still walks to, else the tile they stand on, so a friend on the way to the table counts.
 *
 * Owner: W2 of ship life slice 4.
 */
import { dayTicks } from "../../core/clock";
import { affinityOf } from "../../core/social";
import { addThought } from "../../core/thoughts";
import type { Actor } from "../../core/types/actor";
import type { TileCoord } from "../../core/types/common";
import type { ActorId, DeckDefId, LocalKey, MachineId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import { tileAt, withinArm } from "../galley/kitchen";
import { emitSim } from "../work/events";
import { addMemory } from "./relationships";

/** A free mess seat: the `use` position to walk to, and its tile. */
export interface SeatOption {
  readonly target: { readonly machineId: MachineId; readonly positionKey: LocalKey };
  readonly tile: TileCoord;
  /** The actor already holds it (standing on it, or walking to it). */
  readonly held: boolean;
}

/** Someone else on the deck and where they are, or will be, at the tables. */
interface Placed {
  readonly actor: Actor;
  readonly tile: TileCoord;
  /** Their tile is a mess seat (sitting there, or walking to it). */
  readonly atTable: boolean;
}

export function seatPreference(
  ctx: StepCtx,
  actor: Actor,
  seats: readonly SeatOption[],
): SeatOption | undefined {
  const held = seats.find((seat) => seat.held);
  if (held !== undefined) return held;
  if (seats.length === 0 || actor.location.kind !== "onDeck") return seats[0];
  const others = placedOthers(ctx, actor, actor.location.deckId);
  const captains = captainsSeat(ctx, actor, seats, others);
  if (captains !== undefined) return captains;
  const { avoidBelow, preferAbove } = ctx.config.social;
  const feel = (other: Placed) =>
    affinityOf(ctx.state, ctx.config.social, actor.id, other.actor.id);
  const beside = (seat: SeatOption) => others.filter((other) => isBeside(seat.tile, other.tile));
  const allowed = seats.filter((seat) => beside(seat).every((other) => feel(other) > avoidBelow));
  return (
    allowed.find((seat) => beside(seat).some((other) => feel(other) > preferAbove)) ?? allowed[0]
  );
}

const isBeside = (a: TileCoord, b: TileCoord): boolean =>
  withinArm(a, b) && (a.x !== b.x || a.y !== b.y);

/** `${machineId}:${positionKey}` → tile, for every `messTable` `use` position on the deck. */
function messSeatTiles(ctx: StepCtx, deckId: DeckDefId): Map<string, TileCoord> {
  const out = new Map<string, TileCoord>();
  const geometry = ctx.caches.nav.decks[deckId];
  if (geometry === undefined) return out;
  for (const position of geometry.interactionPositions) {
    if (!position.purposes.includes("use")) continue;
    const machine = ctx.state.machines[position.machineId];
    if (machine === undefined || !ctx.content.machines[machine.defId]?.tags.includes("messTable")) {
      continue;
    }
    out.set(`${position.machineId}:${position.key}`, { ...position.tile });
  }
  return out;
}

/** Everyone else on `deckId`, at the mess seat their plan walks to, else where they stand. */
function placedOthers(ctx: StepCtx, actor: Actor, deckId: DeckDefId): Placed[] {
  const seatTiles = messSeatTiles(ctx, deckId);
  const isSeatTile = (tile: TileCoord) =>
    [...seatTiles.values()].some((seat) => seat.x === tile.x && seat.y === tile.y);
  const out: Placed[] = [];
  for (const other of Object.values(ctx.state.actors)) {
    const location = other.location;
    if (other.id === actor.id || location.kind !== "onDeck" || location.deckId !== deckId) continue;
    const headedFor = plannedSeat(other, seatTiles);
    const tile = headedFor ?? tileAt(location);
    out.push({ actor: other, tile, atTable: headedFor !== undefined || isSeatTile(tile) });
  }
  return out;
}

/** The mess seat a remaining `moveTo` of the actor's plan walks to, if any. */
function plannedSeat(
  actor: Actor,
  seatTiles: ReadonlyMap<string, TileCoord>,
): TileCoord | undefined {
  const activity = actor.activity;
  if (activity.kind === "idle" || activity.plan === undefined) return undefined;
  for (const step of activity.plan.steps.slice(activity.plan.stepIndex)) {
    if (step.kind !== "moveTo" || !("machineId" in step.target)) continue;
    const tile = seatTiles.get(`${step.target.machineId}:${step.target.positionKey}`);
    if (tile !== undefined) return tile;
  }
  return undefined;
}

/** The ship's day `tick` falls in (0 from tick 0). */
function dayIndexAt(ctx: StepCtx): number {
  return Math.floor(ctx.tick / Math.max(1, dayTicks(ctx.config, 1)));
}

/**
 * The captain's table (rule 2 of the module comment): the seat beside the chosen crew member and
 * its effects, or undefined when it is not the captain, already held today, or nobody at the
 * tables has a free seat beside them.
 */
function captainsSeat(
  ctx: StepCtx,
  captain: Actor,
  seats: readonly SeatOption[],
  others: readonly Placed[],
): SeatOption | undefined {
  if (!captain.roleTags.includes("captain")) return undefined;
  const today = dayIndexAt(ctx);
  if (ctx.state.social.captainsTableDay >= today) return undefined;
  const highest = today % 2 === 0;
  const feel = (id: ActorId) => affinityOf(ctx.state, ctx.config.social, captain.id, id);
  const candidates = others
    .filter((other) => other.atTable && other.actor.crew && other.actor.passenger !== true)
    .sort((a, b) => {
      const order = highest
        ? feel(b.actor.id) - feel(a.actor.id)
        : feel(a.actor.id) - feel(b.actor.id);
      return order !== 0 ? order : a.actor.id < b.actor.id ? -1 : a.actor.id > b.actor.id ? 1 : 0;
    });
  for (const other of candidates) {
    const seat = seats.find((option) => isBeside(option.tile, other.tile));
    if (seat === undefined) continue;
    ctx.state.social.captainsTableDay = today;
    addMemory(ctx, captain.id, other.actor.id, "sharedATable");
    addMemory(ctx, other.actor.id, captain.id, "sharedATable");
    addThought(ctx, other.actor, "satWithTheCaptain");
    emitSim(ctx, "captainsTable", [captain.id, other.actor.id], {
      captainId: captain.id,
      withActorId: other.actor.id,
    });
    return seat;
  }
  return undefined;
}
