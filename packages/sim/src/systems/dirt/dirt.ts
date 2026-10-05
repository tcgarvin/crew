/**
 * The dirt system (D82), phase `equipment`, registered after the equipment systems. It runs its
 * pass every `config.dirt.updateEverySeconds` (checked against the tick inside `run`, since a
 * system's `every` is fixed at registration and the config is not known then).
 *
 * Each pass:
 *
 * 1. Airborne dust. While a dock is alongside with `airborneDust > 0` and a ramp onto it is open,
 *    the deck's floor within `airborneDustRadiusTiles` of the top of an open ramp settles dust:
 *    `dustThisVisit` (the dust settled at a ramp's top this visit, of 1.0) grows by
 *    `airborneDust × airborneDustPerDay` a day up to `airborneDustVisitCap`, and each tile holds
 *    that times `1 − d / (radius + 1)` (d its distance to the nearest open ramp top). Tiles gain
 *    the change in their rounded share, so the quantised cells add up exactly to the cap. The
 *    count resets once the dock is gone.
 * 2. Tiers. Each room's `roomDirt` against its stored tier (`tierOf`); a change is written to
 *    `dirt.tiers` and announced once: `roomDirty` rising into `dirty`, `roomFilthy` rising into
 *    `filthy`, `roomTidied` falling below `dirty`.
 * 3. `compartmentDirty` (`rooms.ts`): raised at `dirty` or worse, revised on each tier change,
 *    resolved once the room is clean and nobody holds its task; while nobody holds it, a task
 *    whose tiles were mopped on a cut-short trip is re-derived (a revision bump).
 *
 * Owner: W2 of ship life slice 3.
 */
import { configTicks, perDayToPerSecond } from "../../core/clock";
import { cellIndex } from "../../core/dirt-grid";
import type { TileCoord } from "../../core/types/common";
import type { DirtTier } from "../../core/types/content";
import type { StepCtx, System } from "../../core/types/pipeline";
import { dockRamps, rampTop } from "../spatial/dock";
import { emitSim } from "../work/events";
import { CELL_MAX, addUnits, dirtFloor, tierRank } from "./grid";
import {
  type Room,
  currentTier,
  heldByAnyone,
  openDirtProblem,
  opensProblem,
  raiseDirtProblem,
  resolveDirtProblem,
  reviseDirtProblem,
  roomsOf,
  staleTiles,
} from "./rooms";

/** Ticks between dirt passes (`dirt.updateEverySeconds`, at least one). */
function passTicks(ctx: Pick<StepCtx, "config">): number {
  return Math.max(1, configTicks(ctx.config, ctx.config.dirt.updateEverySeconds));
}

/** Is this a tick the dirt pass runs on (`dirt.updateEverySeconds`, at least every tick)? */
export function dirtPassDue(ctx: Pick<StepCtx, "config" | "tick">): boolean {
  return ctx.tick % passTicks(ctx) === 0;
}

/** The ship tiles at the top of the open ramps onto the dock alongside. */
function openRampTops(ctx: StepCtx, deckId: string): TileCoord[] {
  const geometry = ctx.caches.nav.decks[deckId as keyof typeof ctx.caches.nav.decks];
  if (geometry === undefined) return [];
  return dockRamps(geometry)
    .filter((id) => ctx.state.doors[id]?.physicalState === "open")
    .map((id) => rampTop(geometry, id));
}

function settleDust(ctx: StepCtx): void {
  const dirt = ctx.state.dirt;
  const dock = ctx.state.deck.dock;
  if (dock === undefined) {
    dirt.dustThisVisit = 0;
    return;
  }
  const config = ctx.config.dirt;
  const airborne = ctx.content.docks?.[dock.dockId]?.airborneDust ?? 0;
  const before = dirt.dustThisVisit;
  if (airborne <= 0 || before >= config.airborneDustVisitCap) return;
  const tops = openRampTops(ctx, dock.deckId);
  const deck = ctx.content.decks[dock.deckId];
  const cells = dirt.cells[dock.deckId];
  if (tops.length === 0 || deck === undefined || cells === undefined) return;
  const seconds = passTicks(ctx) / ctx.config.time.tickRate;
  const perSecond = perDayToPerSecond(ctx.config, airborne * config.airborneDustPerDay);
  const after = Math.min(config.airborneDustVisitCap, before + perSecond * seconds);
  dirt.dustThisVisit = after;
  const radius = config.airborneDustRadiusTiles;
  const floor = dirtFloor(ctx.content, deck);
  for (let y = 0; y < deck.height; y++) {
    for (let x = 0; x < deck.width; x++) {
      const i = cellIndex(deck, { x, y });
      if (floor[i] !== 1) continue;
      const d = Math.min(...tops.map((t) => Math.hypot(t.x - x, t.y - y)));
      if (d > radius) continue;
      const share = 1 - d / (radius + 1);
      const units = Math.round(after * share * CELL_MAX) - Math.round(before * share * CELL_MAX);
      if (units > 0) cells[i] = addUnits(cells[i] ?? 0, units);
    }
  }
}

function announce(ctx: StepCtx, room: Room, from: DirtTier, to: DirtTier): void {
  const subject = { compartmentId: room.compartmentId, key: room.def.key };
  const ids = [room.compartmentId];
  if (tierRank(to) > tierRank(from)) {
    if (to === "filthy") emitSim(ctx, "roomFilthy", ids, subject);
    else if (to === "dirty") emitSim(ctx, "roomDirty", ids, subject);
  } else if (tierRank(from) >= tierRank("dirty") && tierRank(to) < tierRank("dirty")) {
    emitSim(ctx, "roomTidied", ids, subject);
  }
}

function updateRoom(ctx: StepCtx, room: Room): void {
  const stored: DirtTier = ctx.state.dirt.tiers[room.def.key] ?? "clean";
  const tier = currentTier(ctx, room);
  const changed = tier !== stored;
  if (changed) {
    ctx.state.dirt.tiers[room.def.key] = tier;
    announce(ctx, room, stored, tier);
  }
  const problem = openDirtProblem(ctx, room.def.key);
  if (problem === undefined) {
    if (opensProblem(tier)) raiseDirtProblem(ctx, room, tier);
    return;
  }
  if (changed) reviseDirtProblem(problem, room, tier);
  if (heldByAnyone(ctx, problem)) return;
  if (tier === "clean") resolveDirtProblem(ctx, problem);
  else if (!changed && staleTiles(ctx, problem, room)) problem.revision += 1;
}

export const dirtSystem: System = {
  name: "dirt",
  phase: "equipment",
  run(ctx) {
    if (!dirtPassDue(ctx)) return;
    settleDust(ctx);
    for (const room of roomsOf(ctx)) updateRoom(ctx, room);
  },
};
