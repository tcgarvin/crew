/**
 * Task derivation for the problem kinds commerce owns (`cargoToLoad`, `cargoToUnload`, and D47's
 * `partsNeeded`, which equipment raises and commerce answers from the port market; CONTRACTS
 * "How work is advertised"). Exported as a `Partial<TaskDerivationTable>` for `systems/work/`
 * (W4) to merge. Both derive one `haul` task; `interactionTiles` come from static content
 * (`DerivationCtx` has no live state), which is enough here since the manifest's stowage zone
 * and the deck's cargo transfer tiles are geometry, not instance state.
 */
import type { ContentBundle } from "../../core/types/content";
import type { DeriveTasks, TaskSpec } from "../../core/types/work";
import { affordableUnits } from "./market";

function firstDeck(content: ContentBundle) {
  const [deck] = Object.values(content.decks);
  return deck;
}

// W6 decision: haul tasks carry no skill/tool requirement in V1 (any crew member can carry a
// crate); `estimatedWorkSeconds` uses the W6-added `config.commerce.haulEstimateSeconds`
// (a short, uniform placeholder — actual haul time is walking + pick/drop, not
// modelled by the derivation table).
export const deriveCargoToLoad: DeriveTasks<"cargoToLoad"> = (problem, ctx) => {
  const deck = firstDeck(ctx.content);
  const zone = deck?.zones.find((z) => z.key === problem.payload.stowageZoneKey);
  const spec: TaskSpec = {
    derivationKey: "load",
    type: "haul",
    target: { kind: "item", itemId: problem.payload.itemId },
    baseUrgency: problem.baseUrgency,
    requiredSkills: [],
    requiredTools: [],
    consumables: [],
    workerSlots: 1,
    interactionTiles: zone?.tiles ? [...zone.tiles] : [],
    dependencyIds: [],
    progressRef: { kind: "itemCustody", itemId: problem.payload.itemId },
    completion: {
      kind: "itemInZone",
      itemId: problem.payload.itemId,
      zoneKey: problem.payload.stowageZoneKey,
    },
    estimatedWorkSeconds: ctx.config.commerce.haulEstimateSeconds,
  };
  return [spec];
};

export const deriveCargoToUnload: DeriveTasks<"cargoToUnload"> = (problem, ctx) => {
  const deck = firstDeck(ctx.content);
  const tiles = deck?.docking.cargoTransferTiles ?? [];
  const spec: TaskSpec = {
    derivationKey: "unload",
    type: "haul",
    target: { kind: "item", itemId: problem.payload.itemId },
    baseUrgency: problem.baseUrgency,
    requiredSkills: [],
    requiredTools: [],
    consumables: [],
    workerSlots: 1,
    interactionTiles: [...tiles],
    dependencyIds: [],
    progressRef: { kind: "itemCustody", itemId: problem.payload.itemId },
    completion: {
      kind: "itemInStore",
      itemId: problem.payload.itemId,
      portId: problem.payload.portId,
      storeKey: problem.payload.storeKey,
    },
    estimatedWorkSeconds: ctx.config.commerce.haulEstimateSeconds,
  };
  return [spec];
};

/**
 * D47: a `partsNeeded` problem derives one `buyParts` task only while the ship is docked at a
 * port whose market has the item and the ship can pay for at least one unit; otherwise it
 * derives nothing (the problem stays open and the digest says why). The task carries the units
 * to buy in its `progressRef`; any crew member may take it (no skill, no tool), the planner
 * ranks it at the problem's urgency, and the buyer walks to a cargo transfer tile.
 */
export const derivePartsNeeded: DeriveTasks<"partsNeeded"> = (problem, ctx) => {
  const travel = ctx.state.travel;
  if (travel.stage !== "docked") return [];
  const { itemDefId, count, machineId } = problem.payload;
  const units = affordableUnits(ctx.state, ctx.content, travel.portId, itemDefId, count);
  if (units <= 0) return [];
  const deck = firstDeck(ctx.content);
  const tiles = deck?.docking.cargoTransferTiles ?? [];
  const spec: TaskSpec = {
    derivationKey: "buy",
    type: "buyParts",
    target: { kind: "machine", machineId },
    baseUrgency: problem.baseUrgency,
    requiredSkills: [],
    requiredTools: [],
    consumables: [],
    workerSlots: 1,
    interactionTiles: [...tiles],
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
