/**
 * Task derivation for `compartmentDirty` (D82): one `cleanCompartment` task, `requiredTools:
 * ["mop"]`, target `{ kind: "compartment" }`, `interactionTiles` the room's `mopTilesPerTrip`
 * dirtiest floor cells at or above half the `untidy` threshold (ties in row-major order), walked
 * nearest first from the cleaning locker (greedy; from the dirtiest tile on a deck with no
 * locker), progress `{ kind: "room" }`, `estimatedWorkSeconds: mopSecondsPerTile × tiles`,
 * `baseUrgency` the problem's. No tiles worth mopping, no task. Merged by `systems/work/` with
 * the other systems' rules.
 *
 * Walked nearest first, not dirtiest first: a dirty corridor is sixty tiles at much the same
 * level, and a trip that chases the dirtiest zigzagged the room's length between strokes, so
 * the deckhand spent more of the trip walking than mopping (the tuning commit's measurement).
 * The trip still takes the dirtiest tiles; only the order they are walked in changes.
 *
 * Owner: W2 of ship life slice 3.
 */
import { roomCells } from "../../core/dirt-grid";
import type { DeepReadonly, TileCoord } from "../../core/types/common";
import type { ConfigDef, ContentBundle } from "../../core/types/content";
import type { CompartmentId } from "../../core/types/ids";
import type { WorldState } from "../../core/types/state";
import type { DeriveTasks } from "../../core/types/work";
import { dirtFloor, mopWorthy } from "./grid";

interface MopCtx {
  readonly content: Pick<ContentBundle, "decks" | "machines">;
  readonly config: Pick<ConfigDef, "dirt">;
  readonly state: DeepReadonly<Pick<WorldState, "dirt" | "compartments">>;
}

/** The zone tag the mop lives in (`ZoneDef.tags`), where a trip starts from. */
const LOCKER_TAG = "cleaningLocker";

const chebyshev = (a: TileCoord, b: TileCoord): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** `tiles` in a greedy nearest-first walk from `start` (ties by the given order). */
function walkNearestFirst(tiles: readonly TileCoord[], start: TileCoord): TileCoord[] {
  const left = [...tiles];
  const out: TileCoord[] = [];
  let here = start;
  while (left.length > 0) {
    let best = 0;
    for (let i = 1; i < left.length; i++) {
      const a = left[i] as TileCoord;
      const b = left[best] as TileCoord;
      if (chebyshev(a, here) < chebyshev(b, here)) best = i;
    }
    const next = left.splice(best, 1)[0] as TileCoord;
    out.push(next);
    here = next;
  }
  return out;
}

/**
 * The room's tiles a mopping trip should work: the `mopTilesPerTrip` dirtiest, walked nearest
 * first from the cleaning locker (see the module comment).
 */
export function tilesToMop(ctx: MopCtx, compartmentId: CompartmentId): TileCoord[] {
  const compartment = ctx.state.compartments[compartmentId];
  const deck = compartment === undefined ? undefined : ctx.content.decks[compartment.deckId];
  const cells = compartment === undefined ? undefined : ctx.state.dirt.cells[compartment.deckId];
  if (compartment === undefined || deck === undefined || cells === undefined) return [];
  const floor = dirtFloor(ctx.content, deck);
  const worthy = mopWorthy(ctx.config);
  const dirtiest = roomCells(deck, compartment.key)
    .filter((i) => floor[i] === 1 && (cells[i] ?? 0) >= worthy)
    .sort((a, b) => (cells[b] ?? 0) - (cells[a] ?? 0) || a - b)
    .slice(0, Math.max(0, ctx.config.dirt.mopTilesPerTrip))
    .map((i) => ({ x: i % deck.width, y: Math.floor(i / deck.width) }));
  const locker = deck.zones.find((z) => z.tags.includes(LOCKER_TAG))?.tiles[0];
  const start = locker ?? dirtiest[0];
  return start === undefined ? [] : walkNearestFirst(dirtiest, start);
}

const deriveCompartmentDirty: DeriveTasks<"compartmentDirty"> = (problem, ctx) => {
  const { compartmentId } = problem.payload;
  const tiles = tilesToMop(ctx, compartmentId);
  if (tiles.length === 0) return [];
  return [
    {
      derivationKey: "mop",
      type: "cleanCompartment",
      target: { kind: "compartment", compartmentId },
      baseUrgency: problem.baseUrgency,
      requiredSkills: [],
      requiredTools: ["mop"],
      consumables: [],
      workerSlots: 1,
      interactionTiles: tiles,
      dependencyIds: [],
      progressRef: { kind: "room", compartmentId },
      completion: { kind: "problemResolved" },
      estimatedWorkSeconds: ctx.config.dirt.mopSecondsPerTile * tiles.length,
    },
  ];
};

export const dirtTaskDerivations = {
  compartmentDirty: deriveCompartmentDirty,
};
