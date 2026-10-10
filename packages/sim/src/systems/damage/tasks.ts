/**
 * Task derivation for the problems damage response owns (§machine-damage, §scouts). Merged by
 * `systems/work/` with the other systems' rules.
 *
 * - `machineDamaged` → one `repairDamage`: engineering ≥ 1 and a `welder`, at the machine's
 *   `repair` positions (any position on a machine with none, else the floor beside it),
 *   `repairSecondsPerIntegrity` × the integrity missing; progress is the machine's integrity.
 * - `hullScar` → `patchHull` while the scar is unpatched and a `patchKit` item is aboard, and
 *   `plateHull` while docked with a `plating` item aboard (one each, dependency-free): engineering
 *   ≥ 1, a `welder`, one kit or plate, standing beside the scar (`besideTiles`), `patchSeconds` /
 *   `plateSeconds`. A patch is done when its weld is (`stepsDone`: the scar stays open for its
 *   plate); a plate resolves the problem.
 * - `hullDamaged` → commerce's `buyParts` (`buySpec`), naming the market it buys from.
 * - `compartmentToCheck` → one `checkCompartment`: no skill or tool, at the room's door tiles
 *   (`doorTiles`: the floor nearest its doors; the scout's plan takes the nearest of them),
 *   `checkSeconds` looking round.
 *
 * Kits and plates are found by tag, never by def id (call 22): the consumable a patch or plate
 * names is the def of a tagged item aboard (the first by id), so the work system knows what to set
 * down if the job is given up.
 *
 * Owner: W2 of ship life slice 5.
 */
import type { DeepReadonly } from "../../core/types/common";
import type { ContentBundle, DeckDef, ItemTag } from "../../core/types/content";
import type { ItemDefId, ScarId } from "../../core/types/ids";
import type {
  DerivationCtx,
  DeriveTasks,
  TaskDerivationTable,
  TaskSpec,
} from "../../core/types/work";
import { shipDeckId } from "../../core/world";
import { buySpec } from "../commerce/tasks";
import { unitsAboard } from "../equipment/supplies";
import { besideTiles, doorTiles, machineWorkTiles, symbolOf } from "./deck";

const ENGINEERING = { skill: "engineering", min: 1 } as const;

function shipDeck(ctx: DerivationCtx): DeepReadonly<DeckDef> | undefined {
  return ctx.content.decks[shipDeckId(ctx.state)];
}

/** The def of the first item aboard (by def id) carrying `tag`, if any is aboard. */
export function taggedDefAboard(
  state: DerivationCtx["state"],
  content: Pick<ContentBundle, "items">,
  tag: ItemTag,
): ItemDefId | undefined {
  const defs = [...unitsAboard(state)]
    .filter(([defId, units]) => units > 0 && content.items[defId]?.tags.includes(tag) === true)
    .map(([defId]) => defId)
    .sort();
  return defs[0];
}

const deriveMachineDamaged: DeriveTasks<"machineDamaged"> = (problem, ctx) => {
  const { machineId } = problem.payload;
  const machine = ctx.state.machines[machineId];
  if (machine === undefined || machine.integrity >= 1) return [];
  const deck = ctx.content.decks[machine.deckId];
  const placement = deck?.machines.find((p) => p.key === machine.placementKey);
  if (deck === undefined || placement === undefined) return [];
  return [
    {
      derivationKey: "mend",
      type: "repairDamage",
      target: { kind: "machine", machineId },
      baseUrgency: problem.baseUrgency,
      requiredSkills: [ENGINEERING],
      requiredTools: ["welder"],
      consumables: [],
      workerSlots: 1,
      interactionTiles: machineWorkTiles(ctx.content, deck, placement),
      dependencyIds: [],
      progressRef: { kind: "integrity", machineId },
      completion: { kind: "problemResolved" },
      estimatedWorkSeconds: ctx.config.damage.repairSecondsPerIntegrity * (1 - machine.integrity),
    },
  ];
};

function scarSpec(
  problem: { readonly baseUrgency: TaskSpec["baseUrgency"] },
  ctx: DerivationCtx,
  scarId: ScarId,
  work: "patch" | "plate",
  defId: ItemDefId,
  tiles: TaskSpec["interactionTiles"],
): TaskSpec {
  return {
    derivationKey: work,
    type: work === "patch" ? "patchHull" : "plateHull",
    target: { kind: "scar", scarId },
    baseUrgency: problem.baseUrgency,
    requiredSkills: [ENGINEERING],
    requiredTools: ["welder"],
    consumables: [{ itemDefId: defId, count: 1 }],
    workerSlots: 1,
    interactionTiles: tiles,
    dependencyIds: [],
    progressRef: { kind: "scar", scarId },
    completion: work === "patch" ? { kind: "stepsDone" } : { kind: "problemResolved" },
    estimatedWorkSeconds:
      work === "patch" ? ctx.config.damage.patchSeconds : ctx.config.damage.plateSeconds,
  };
}

const deriveHullScar: DeriveTasks<"hullScar"> = (problem, ctx) => {
  const scar = ctx.state.hull.scars.find((s) => s.id === problem.payload.scarId);
  const deck = shipDeck(ctx);
  if (scar === undefined || deck === undefined) return [];
  const tiles = besideTiles(ctx.content, deck, scar.tile);
  const specs: TaskSpec[] = [];
  const kit = scar.patched ? undefined : taggedDefAboard(ctx.state, ctx.content, "patchKit");
  if (kit !== undefined) specs.push(scarSpec(problem, ctx, scar.id, "patch", kit, tiles));
  const docked = ctx.state.travel.stage === "docked";
  const plate = docked ? taggedDefAboard(ctx.state, ctx.content, "plating") : undefined;
  if (plate !== undefined) specs.push(scarSpec(problem, ctx, scar.id, "plate", plate, tiles));
  return specs;
};

const deriveHullDamaged: DeriveTasks<"hullDamaged"> = (problem, ctx) => {
  const { itemDefId, count } = problem.payload;
  return buySpec(problem, ctx, itemDefId, count, (portId) => ({ kind: "market", portId }));
};

const deriveCompartmentToCheck: DeriveTasks<"compartmentToCheck"> = (problem, ctx) => {
  const { compartmentId } = problem.payload;
  const compartment = ctx.state.compartments[compartmentId];
  const deck = compartment === undefined ? undefined : ctx.content.decks[compartment.deckId];
  const symbol =
    deck === undefined || compartment === undefined ? undefined : symbolOf(deck, compartment.key);
  if (deck === undefined || symbol === undefined) return [];
  return [
    {
      derivationKey: "check",
      type: "checkCompartment",
      target: { kind: "compartment", compartmentId },
      baseUrgency: problem.baseUrgency,
      requiredSkills: [],
      requiredTools: [],
      consumables: [],
      workerSlots: 1,
      interactionTiles: doorTiles(ctx.content, deck, symbol),
      dependencyIds: [],
      progressRef: { kind: "check", compartmentId },
      completion: { kind: "problemResolved" },
      estimatedWorkSeconds: ctx.config.damage.checkSeconds,
    },
  ];
};

export const damageTaskDerivations: Pick<
  TaskDerivationTable,
  "machineDamaged" | "hullScar" | "hullDamaged" | "compartmentToCheck"
> = {
  machineDamaged: deriveMachineDamaged,
  hullScar: deriveHullScar,
  hullDamaged: deriveHullDamaged,
  compartmentToCheck: deriveCompartmentToCheck,
};
