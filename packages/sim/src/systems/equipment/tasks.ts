/**
 * `TaskDerivationTable` rules equipment owns (docs/CONTRACTS.md "how work is advertised" step 2):
 * `machineSymptom` -> `inspect` (diagnose), `machineFault` -> `repair`, `maintenanceDue` ->
 * `inspect` (there is no `"maintain"` `TaskType` — periodic maintenance reuses `"inspect"`, kept
 * distinct from diagnosis by `derivationKey: "maintain"` vs `"inspect"`; `systems/equipment/
 * recipes.ts` dispatches on that key).
 *
 * Each rule derives exactly one task per problem (SD §14.2's identity is `(problemId,
 * derivationKey)`, not one-task-per-recipe-step): the whole repair recipe or maintenance
 * inspection is one task, whose stages `recipes.ts` steps through.
 */
import type { DeepReadonly, Rotation, TileCoord } from "../../core/types/common";
import type { DeckDef, ItemCount, MachineDef, RecipeStep } from "../../core/types/content";
import type { LocalKey, MachineId } from "../../core/types/ids";
import type { Machine } from "../../core/types/ship";
import type {
  DerivationCtx,
  ProblemOfKind,
  TaskDerivationTable,
  TaskSpec,
} from "../../core/types/work";
import { DIAGNOSE_SECONDS, DIAGNOSE_SKILL } from "./equipment";

/** `DerivationCtx.state` is `DeepReadonly`; these rules only ever read the machine instance. */
type ROMachine = DeepReadonly<Machine>;

function rotateOffset(offset: TileCoord, rotation: Rotation): TileCoord {
  switch (rotation) {
    case 0:
      return offset;
    case 90:
      return { x: -offset.y, y: offset.x };
    case 180:
      return { x: -offset.x, y: -offset.y };
    case 270:
      return { x: offset.y, y: -offset.x };
  }
}

function interactionTilesFor(
  def: MachineDef,
  machine: ROMachine,
  deck: DeckDef,
  purpose: "operate" | "repair" | "use",
): TileCoord[] {
  const placement = deck.machines.find((p) => p.key === machine.placementKey);
  if (placement === undefined) return [];
  return def.interactionPositions
    .filter((p) => p.purposes.includes(purpose))
    .map((p) => {
      const rotated = rotateOffset(p.offset, placement.rotation);
      return { x: placement.origin.x + rotated.x, y: placement.origin.y + rotated.y };
    });
}

function uniqueTiles(tiles: TileCoord[]): TileCoord[] {
  const seen = new Set<string>();
  const out: TileCoord[] = [];
  for (const t of tiles) {
    const key = `${t.x},${t.y}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

function findFaultBySymptom(def: MachineDef, machine: ROMachine, symptomKey: LocalKey) {
  return machine.faults.find((f) => {
    if (f.diagnosed) return false;
    return def.faults.find((fd) => fd.key === f.faultKey)?.symptom.key === symptomKey;
  });
}

function resolveMachine(ctx: DerivationCtx, machineId: MachineId) {
  const machine = ctx.state.machines[machineId];
  if (machine === undefined) return undefined;
  const def = ctx.content.machines[machine.defId];
  const deck = ctx.content.decks[machine.deckId];
  if (def === undefined || deck === undefined) return undefined;
  return { machine, def, deck };
}

function deriveInspectTask(
  problem: ProblemOfKind<"machineSymptom">,
  ctx: DerivationCtx,
): TaskSpec[] {
  const { machineId, symptomKey } = problem.payload;
  const resolved = resolveMachine(ctx, machineId);
  if (resolved === undefined) return [];
  const { machine, def, deck } = resolved;
  const fault = findFaultBySymptom(def, machine, symptomKey);
  if (fault === undefined) return [];
  return [
    {
      derivationKey: "inspect",
      type: "inspect",
      target: { kind: "machine", machineId },
      baseUrgency: problem.baseUrgency,
      requiredSkills: [DIAGNOSE_SKILL],
      requiredTools: [],
      consumables: [],
      workerSlots: 1,
      interactionTiles: interactionTilesFor(def, machine, deck, "repair"),
      dependencyIds: [],
      progressRef: { kind: "fault", machineId, faultKey: fault.faultKey },
      completion: { kind: "problemResolved" },
      estimatedWorkSeconds: DIAGNOSE_SECONDS,
    },
  ];
}

function mergeItemCounts(counts: readonly ItemCount[]): ItemCount[] {
  const totals = new Map<ItemCount["itemDefId"], number>();
  for (const c of counts) totals.set(c.itemDefId, (totals.get(c.itemDefId) ?? 0) + c.count);
  return [...totals.entries()].map(([itemDefId, count]) => ({ itemDefId, count }));
}

function deriveRepairTask(problem: ProblemOfKind<"machineFault">, ctx: DerivationCtx): TaskSpec[] {
  const { machineId, faultKey } = problem.payload;
  const resolved = resolveMachine(ctx, machineId);
  if (resolved === undefined) return [];
  const { machine, def, deck } = resolved;
  const faultDef = def.faults.find((f) => f.key === faultKey);
  const steps: readonly RecipeStep[] | undefined = faultDef?.repair.steps;
  if (faultDef === undefined || steps === undefined || steps.length === 0) return [];
  const tiles = uniqueTiles(steps.flatMap((s) => interactionTilesFor(def, machine, deck, s.at)));
  const skill = steps.find((s) => s.skill !== undefined)?.skill;
  const tools = [...new Set(steps.flatMap((s) => s.tools))];
  return [
    {
      derivationKey: "repair",
      type: "repair",
      target: { kind: "machine", machineId },
      baseUrgency: problem.baseUrgency,
      requiredSkills: skill === undefined ? [] : [skill],
      requiredTools: tools,
      consumables: mergeItemCounts(steps.flatMap((s) => s.consumes)),
      workerSlots: 1,
      interactionTiles: tiles,
      dependencyIds: [],
      progressRef: { kind: "fault", machineId, faultKey },
      completion: { kind: "problemResolved" },
      estimatedWorkSeconds: steps.reduce((sum, s) => sum + s.workSeconds, 0),
    },
  ];
}

function deriveMaintainTask(
  problem: ProblemOfKind<"maintenanceDue">,
  ctx: DerivationCtx,
): TaskSpec[] {
  const { machineId } = problem.payload;
  const resolved = resolveMachine(ctx, machineId);
  if (resolved === undefined) return [];
  const { machine, def, deck } = resolved;
  const step = def.maintenance?.inspect;
  if (step === undefined) return [];
  return [
    {
      derivationKey: "maintain",
      type: "inspect",
      target: { kind: "machine", machineId },
      baseUrgency: problem.baseUrgency,
      requiredSkills: step.skill === undefined ? [] : [step.skill],
      requiredTools: [...step.tools],
      consumables: [...step.consumes],
      workerSlots: 1,
      interactionTiles: interactionTilesFor(def, machine, deck, step.at),
      dependencyIds: [],
      progressRef: { kind: "maintenance", machineId },
      completion: { kind: "problemResolved" },
      estimatedWorkSeconds: step.workSeconds,
    },
  ];
}

/** Equipment's slice of the `TaskDerivationTable`; `systems/work/derivation.ts` (W4) merges it in. */
export const equipmentTaskDerivation: Partial<TaskDerivationTable> = {
  machineSymptom: deriveInspectTask,
  machineFault: deriveRepairTask,
  maintenanceDue: deriveMaintainTask,
};
