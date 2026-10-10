/**
 * Rounds (§gangway-watch-and-rounds): the officer of the watch's walk (engineering, the hold, the
 * mess, the helm's standby position) and an idle on-duty engineer's machine round (every machine in
 * engineering with a `repair` position, at that position), `watches.roundsStopSeconds` of `rounds`
 * work at each stop.
 *
 * Rounds do their noticing through perception, not code of their own: someone standing in a
 * compartment sees its machines' outward status and hears their symptoms (`work/perception.ts`),
 * so walking the round is what brings a grinding pump to the officer's or engineer's knowledge.
 *
 * The cadence (`watches.roundsEveryDays`) is a `rounds` backoff written when a round is planned,
 * so it runs from the start of one round to the start of the next; an interrupted round counts.
 * The plan is the one place a round passes through this file on the way to execution.
 *
 * Owner: W2 of ship life slice 2.
 */
import { configTicks, dayTicks } from "../../core/clock";
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly, TileCoord } from "../../core/types/common";
import type { CompartmentDef, DeckDef } from "../../core/types/content";
import type { DeckGeometry } from "../../core/types/nav";
import type { StepCtx } from "../../core/types/pipeline";
import type { ActivityStep } from "../../core/types/work";
import { isStaticWalkable } from "../spatial/geometry";
import { interactionsAt, reservationHolders } from "../spatial/reservations";
import { backoffRef } from "../work/activity";
import type { PlanResult } from "../work/plans";
import { helmMachine, isOfficerOfTheWatch } from "./helm";

/** The officer's round, in order; the helm's standby position closes it. */
const OFFICER_ROUTE_TAGS: readonly string[] = ["engineering", "cargoHold", "mess"];

/** The backoff ref the cadence is kept under (the planner reads the same one). */
export const ROUNDS_REF = backoffRef.personal("rounds");

interface Where {
  readonly deck: DeepReadonly<DeckDef>;
  readonly geometry: DeckGeometry;
}

function whereIs(ctx: StepCtx, actor: Actor): Where | undefined {
  if (actor.location.kind !== "onDeck") return undefined;
  const deckId = actor.location.deckId;
  const deck = ctx.content.decks[deckId];
  const geometry = ctx.caches.nav.decks[deckId];
  return deck === undefined || geometry === undefined ? undefined : { deck, geometry };
}

const compartmentTagged = (deck: DeepReadonly<DeckDef>, tag: string) =>
  deck.compartments.find((c) => c.tags.includes(tag));

const symbolAt = (deck: DeepReadonly<DeckDef>, tile: TileCoord): string | undefined =>
  deck.tiles[tile.y]?.[tile.x];

/**
 * Where a round stops in a room: the open floor tile (no machine on it, no interaction position)
 * nearest the room's centre, ties to the north then the west. Deterministic, and in the middle
 * of the room, where a look round sees all of it.
 */
function roomStop(where: Where, compartment: DeepReadonly<CompartmentDef>): TileCoord | undefined {
  const tiles: TileCoord[] = [];
  where.deck.tiles.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === compartment.symbol) tiles.push({ x, y });
    }
  });
  if (tiles.length === 0) return undefined;
  const cx = tiles.reduce((sum, t) => sum + t.x, 0) / tiles.length;
  const cy = tiles.reduce((sum, t) => sum + t.y, 0) / tiles.length;
  let best: { tile: TileCoord; d: number } | undefined;
  for (const tile of tiles) {
    if (!isStaticWalkable(where.geometry, tile.x, tile.y)) continue;
    if (interactionsAt(where.geometry, tile).length > 0) continue;
    const d = (tile.x - cx) ** 2 + (tile.y - cy) ** 2;
    if (best === undefined || d < best.d) best = { tile, d };
  }
  return best?.tile;
}

/** The officer of the watch: engineering, the hold, the mess, then the helm's standby tile. */
function officerStops(ctx: StepCtx, where: Where): TileCoord[] {
  const stops: TileCoord[] = [];
  for (const tag of OFFICER_ROUTE_TAGS) {
    const compartment = compartmentTagged(where.deck, tag);
    const tile = compartment === undefined ? undefined : roomStop(where, compartment);
    if (tile !== undefined) stops.push(tile);
  }
  const helm = helmMachine(ctx.state, ctx.content);
  const standby = where.geometry.interactionPositions.find(
    (p) => p.machineId === helm?.id && p.purposes.includes("use"),
  );
  // A tile, not the position itself: a word with the helm, not a claim on the oncoming's spot.
  if (standby !== undefined) stops.push(standby.tile);
  return stops;
}

/**
 * An engineer's machine round: in placement order, each machine in engineering at its `repair`
 * position, skipping one someone else holds right now (a repair under way needs no visit).
 */
function engineerStops(ctx: StepCtx, actor: Actor, where: Where): TileCoord[] {
  const engineering = compartmentTagged(where.deck, "engineering");
  if (engineering === undefined) return [];
  const stops: TileCoord[] = [];
  for (const placement of where.deck.machines) {
    if (symbolAt(where.deck, placement.origin) !== engineering.symbol) continue;
    const machine = Object.values(ctx.state.machines).find(
      (m) => m.deckId === where.deck.id && m.placementKey === placement.key,
    );
    const position = where.geometry.interactionPositions.find(
      (p) => p.machineId === machine?.id && p.purposes.includes("repair"),
    );
    if (position === undefined) continue;
    const holders = reservationHolders(ctx.caches, where.deck.id, position.tile);
    if (holders.some((id) => id !== actor.id)) continue;
    stops.push(position.tile);
  }
  return stops;
}

function stopsFor(ctx: StepCtx, actor: Actor, where: Where): TileCoord[] {
  if (isOfficerOfTheWatch(ctx, actor.id)) {
    return officerStops(ctx, where);
  }
  if (actor.roleTags.includes("engineer")) return engineerStops(ctx, actor, where);
  return [];
}

/**
 * The plan for a `rounds` personal activity: walk to each stop and spend `roundsStopSeconds`
 * there. Blocked (`unreachableTarget`) for someone with no round to walk (neither officer of the
 * watch nor an engineer, or a ship with none of the rooms). Writes the `rounds` backoff for the
 * cadence (see the module comment).
 */
export function roundsPlan(ctx: StepCtx, actor: Actor): PlanResult {
  const where = whereIs(ctx, actor);
  const stops = where === undefined ? [] : stopsFor(ctx, actor, where);
  if (stops.length === 0) return { ok: false, reason: "unreachableTarget" };
  const stopTicks = configTicks(ctx.config, ctx.config.watches.roundsStopSeconds);
  const steps: ActivityStep[] = stops.flatMap((tile): ActivityStep[] => [
    { kind: "moveTo", target: { x: tile.x, y: tile.y }, requested: false },
    { kind: "work", stage: "rounds", ticksDone: 0, ticksNeeded: stopTicks },
  ]);
  const until = ctx.tick + dayTicks(ctx.config, ctx.config.watches.roundsEveryDays);
  actor.workBackoff = { ...(actor.workBackoff ?? {}), [ROUNDS_REF]: until };
  return { ok: true, plan: { steps, stepIndex: 0 } };
}
