/**
 * Task derivation for `compartmentDirty` (D82): one `cleanCompartment` task, `requiredTools:
 * ["mop"]`, target `{ kind: "compartment" }`, `interactionTiles` the room's `mopTilesPerTrip`
 * dirtiest floor cells at or above half the `untidy` threshold (dirtiest first, ties in row-major
 * order), progress `{ kind: "room" }`, `estimatedWorkSeconds: mopSecondsPerTile × tiles`,
 * `baseUrgency` the problem's. No tiles worth mopping, no task. Merged by `systems/work/` with
 * the other systems' rules.
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

/** The room's tiles a mopping trip should work, dirtiest first (see the module comment). */
export function tilesToMop(ctx: MopCtx, compartmentId: CompartmentId): TileCoord[] {
  const compartment = ctx.state.compartments[compartmentId];
  const deck = compartment === undefined ? undefined : ctx.content.decks[compartment.deckId];
  const cells = compartment === undefined ? undefined : ctx.state.dirt.cells[compartment.deckId];
  if (compartment === undefined || deck === undefined || cells === undefined) return [];
  const floor = dirtFloor(ctx.content, deck);
  const worthy = mopWorthy(ctx.config);
  return roomCells(deck, compartment.key)
    .filter((i) => floor[i] === 1 && (cells[i] ?? 0) >= worthy)
    .sort((a, b) => (cells[b] ?? 0) - (cells[a] ?? 0) || a - b)
    .slice(0, Math.max(0, ctx.config.dirt.mopTilesPerTrip))
    .map((i) => ({ x: i % deck.width, y: Math.floor(i / deck.width) }));
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
