/**
 * Task derivation for the problem kinds commerce owns (`cargoToLoad`, `cargoToUnload`, and D47's
 * `partsNeeded`, which equipment raises and commerce answers from the port market; CONTRACTS
 * "How work is advertised"). Exported as a `Partial<TaskDerivationTable>` for `systems/work/`
 * (W4) to merge. Both derive one `haul` task; `interactionTiles` come from geometry: the
 * manifest's stowage zone, the deck's cargo transfer tiles, or (D63) the dock alongside, read
 * from `DerivationCtx.state` (which dock is grafted) and content (its areas and posts).
 */
import { dockAlongsideAt, dockAreaTiles, marketCounter } from "../../core/docks";
import { affordableUnits } from "../../core/markets";
import type { TileCoord } from "../../core/types/common";
import type { ContentBundle } from "../../core/types/content";
import type { ItemId } from "../../core/types/ids";
import type {
  CompletionPredicate,
  DerivationCtx,
  DeriveTasks,
  TaskSpec,
} from "../../core/types/work";

function firstDeck(content: ContentBundle) {
  const [deck] = Object.values(content.decks);
  return deck;
}

// W6 decision: haul tasks carry no skill/tool requirement in V1 (any crew member can carry a
// crate); `estimatedWorkSeconds` uses the W6-added `config.commerce.haulEstimateSeconds`
// (a short, uniform placeholder — actual haul time is walking + pick/drop, not
// modelled by the derivation table).
function haulSpec(
  problem: { readonly baseUrgency: TaskSpec["baseUrgency"] },
  ctx: Pick<DerivationCtx, "config">,
  derivationKey: "load" | "unload",
  itemId: ItemId,
  interactionTiles: TileCoord[],
  completion: CompletionPredicate,
): TaskSpec {
  return {
    derivationKey,
    type: "haul",
    target: { kind: "item", itemId },
    baseUrgency: problem.baseUrgency,
    requiredSkills: [],
    requiredTools: [],
    consumables: [],
    workerSlots: 1,
    interactionTiles,
    dependencyIds: [],
    progressRef: { kind: "itemCustody", itemId },
    completion,
    estimatedWorkSeconds: ctx.config.commerce.haulEstimateSeconds,
  };
}

const deriveCargoToLoad: DeriveTasks<"cargoToLoad"> = (problem, ctx) => {
  const { itemId, stowageZoneKey } = problem.payload;
  const zone = firstDeck(ctx.content)?.zones.find((z) => z.key === stowageZoneKey);
  const tiles = zone?.tiles ? [...zone.tiles] : [];
  return [
    haulSpec(problem, ctx, "load", itemId, tiles, {
      kind: "itemInZone",
      itemId,
      zoneKey: stowageZoneKey,
    }),
  ];
};

/** `tiles` rotated to start at `start` (mod length), so parallel hauls spread over an area. */
function rotated<T>(tiles: readonly T[], start: number): T[] {
  if (tiles.length === 0) return [];
  const k = ((start % tiles.length) + tiles.length) % tiles.length;
  return [...tiles.slice(k), ...tiles.slice(0, k)];
}

/**
 * D63: with the destination's dock alongside, a crate is unloaded by carrying it down to the
 * delivery bay (custody is checked there); each crate of the job aims at its own bay tile
 * first. Without a dock it goes across a cargo transfer tile into the port's store, as before.
 */
const deriveCargoToUnload: DeriveTasks<"cargoToUnload"> = (problem, ctx) => {
  const { itemId, jobId, portId, storeKey } = problem.payload;
  const dock = dockAlongsideAt(ctx.content, ctx.state, portId);
  const bay = dock === undefined ? [] : dockAreaTiles(dock, "deliveryBay");
  if (dock !== undefined && bay.length > 0) {
    const index = Math.max(0, ctx.state.jobs[jobId]?.cargoItemIds.indexOf(itemId) ?? 0);
    return [
      haulSpec(problem, ctx, "unload", itemId, rotated(bay, index), {
        kind: "itemInDockArea",
        itemId,
        dockId: dock.id,
        area: "deliveryBay",
      }),
    ];
  }
  const tiles = firstDeck(ctx.content)?.docking.cargoTransferTiles ?? [];
  return [
    haulSpec(problem, ctx, "unload", itemId, [...tiles], {
      kind: "itemInStore",
      itemId,
      portId,
      storeKey,
    }),
  ];
};

/**
 * D47: a `partsNeeded` problem derives one `buyParts` task only while the ship is docked at a
 * port whose market has the item and the ship can pay for at least one unit; otherwise it
 * derives nothing (the problem stays open and the digest says why). The task carries the units
 * to buy in its `progressRef`; any crew member may take it (no skill, no tool), the planner
 * ranks it at the problem's urgency, and the buyer walks to the market's counter
 * (`marketCounter`, D63): the dock's stall, its gate when it has no stall, or with no dock a cargo
 * transfer tile.
 */
const derivePartsNeeded: DeriveTasks<"partsNeeded"> = (problem, ctx) => {
  const travel = ctx.state.travel;
  if (travel.stage !== "docked") return [];
  const { itemDefId, count, machineId } = problem.payload;
  const units = affordableUnits(ctx.state, ctx.content, travel.portId, itemDefId, count);
  if (units <= 0) return [];
  const counter = marketCounter(ctx.content, ctx.state, travel.portId);
  const tiles =
    counter.kind === "transferTile"
      ? [...(firstDeck(ctx.content)?.docking.cargoTransferTiles ?? [])]
      : [counter.tile];
  const spec: TaskSpec = {
    derivationKey: "buy",
    type: "buyParts",
    target: { kind: "machine", machineId },
    baseUrgency: problem.baseUrgency,
    requiredSkills: [],
    requiredTools: [],
    consumables: [],
    workerSlots: 1,
    interactionTiles: tiles,
    dependencyIds: [],
    progressRef: { kind: "market", portId: travel.portId, itemDefId, count: units },
    completion: { kind: "stepsDone" },
    estimatedWorkSeconds: ctx.config.commerce.market.buySeconds,
  };
  return [spec];
};

export const commerceTaskDerivations = {
  cargoToLoad: deriveCargoToLoad,
  cargoToUnload: deriveCargoToUnload,
  partsNeeded: derivePartsNeeded,
};
