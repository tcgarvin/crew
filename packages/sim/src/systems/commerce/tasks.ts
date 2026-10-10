/**
 * Task derivation for the problem kinds commerce owns (`cargoToLoad`, `cargoToUnload`,
 * `reserveLow` (§reserve-low-problem), and `partsNeeded` (§buying-parts), which equipment raises
 * and commerce answers from the port market; CONTRACTS "How work is advertised"). Exported as a
 * `Partial<TaskDerivationTable>` for `systems/work/` (W4) to merge. The cargo kinds derive one
 * `haul` task, the market kinds one `buyParts` task (`buySpec`); `interactionTiles` come from
 * geometry: the manifest's stowage zone, the deck's cargo transfer tiles, or the dock alongside
 * (§delivery-and-pay), read from `DerivationCtx.state` (which dock is grafted) and content (its
 * areas and posts).
 */
import { dockAlongsideAt, dockAreaTiles, marketCounter } from "../../core/docks";
import { affordableUnits } from "../../core/markets";
import type { TileCoord } from "../../core/types/common";
import type { ItemDefId, ItemId, PortDefId } from "../../core/types/ids";
import type {
  CompletionPredicate,
  DerivationCtx,
  DeriveTasks,
  TaskSpec,
  TaskTarget,
} from "../../core/types/work";
import { shipDeckId } from "../../core/world";

/** The ship's deck (`shipDeckId`), not whichever deck the bundle lists first. */
function shipDeck(ctx: Pick<DerivationCtx, "content" | "state">) {
  return ctx.content.decks[shipDeckId(ctx.state)];
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
  const zone = shipDeck(ctx)?.zones.find((z) => z.key === stowageZoneKey);
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
 * §delivery-and-pay: with the destination's dock alongside, a crate is unloaded by carrying it down
 * to the delivery bay (custody is checked there); each crate of the job aims at its own bay tile
 * first. Without a dock it goes across a cargo transfer tile into the port's store, as before.
 */
const deriveCargoToUnload: DeriveTasks<"cargoToUnload"> = (problem, ctx) => {
  const { itemId, jobId, portId, storeKey } = problem.payload;
  const berth = dockAlongsideAt(ctx.content, ctx.state, portId);
  const bay = berth === undefined ? [] : dockAreaTiles(berth, "deliveryBay");
  if (berth !== undefined && bay.length > 0) {
    const index = Math.max(0, ctx.state.jobs[jobId]?.cargoItemIds.indexOf(itemId) ?? 0);
    return [
      haulSpec(problem, ctx, "unload", itemId, rotated(bay, index), {
        kind: "itemInDockArea",
        itemId,
        dockId: berth.dock.id,
        area: "deliveryBay",
      }),
    ];
  }
  const tiles = shipDeck(ctx)?.docking.cargoTransferTiles ?? [];
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
 * §buying-parts: one `buyParts` task for `count` of `itemDefId`, only while the ship is docked at a
 * port whose market has the item and the ship can pay for at least one unit; otherwise nothing (the
 * problem stays open and the digest says why). The task carries the units to buy in its
 * `progressRef`; any crew member may take it (no skill, no tool), the planner ranks it at the
 * problem's urgency, and the buyer walks to the market's counter (`marketCounter`,
 * §dock-market-and-passengers): the dock's stall, its gate when it has no stall, or with no dock a
 * cargo transfer tile. Shared by `partsNeeded` and `reserveLow`, which differ only in what the task
 * names as its target; exported for `hullDamaged` (§plating-and-kits-at-port; hull plating,
 * `systems/damage/tasks.ts`).
 */
export function buySpec(
  problem: { readonly baseUrgency: TaskSpec["baseUrgency"] },
  ctx: DerivationCtx,
  itemDefId: ItemDefId,
  count: number,
  target: (portId: PortDefId) => TaskTarget,
): TaskSpec[] {
  const travel = ctx.state.travel;
  if (travel.stage !== "docked") return [];
  const units = affordableUnits(ctx.state, ctx.content, travel.portId, itemDefId, count);
  if (units <= 0) return [];
  const counter = marketCounter(ctx.content, ctx.state, travel.portId);
  const tiles =
    counter.kind === "transferTile"
      ? [...(shipDeck(ctx)?.docking.cargoTransferTiles ?? [])]
      : [counter.tile];
  const spec: TaskSpec = {
    derivationKey: "buy",
    type: "buyParts",
    target: target(travel.portId),
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
}

/** §buying-parts: the part a stalled repair needs; the task names the machine it unblocks. */
const derivePartsNeeded: DeriveTasks<"partsNeeded"> = (problem, ctx) => {
  const { itemDefId, count, machineId } = problem.payload;
  return buySpec(problem, ctx, itemDefId, count, () => ({ kind: "machine", machineId }));
};

/** §reserve-low-problem: restocking the ship's stores; the task names the market it buys from. */
const deriveReserveLow: DeriveTasks<"reserveLow"> = (problem, ctx) => {
  const { itemDefId, count } = problem.payload;
  return buySpec(problem, ctx, itemDefId, count, (portId) => ({ kind: "market", portId }));
};

export const commerceTaskDerivations = {
  cargoToLoad: deriveCargoToLoad,
  cargoToUnload: deriveCargoToUnload,
  partsNeeded: derivePartsNeeded,
  reserveLow: deriveReserveLow,
};
