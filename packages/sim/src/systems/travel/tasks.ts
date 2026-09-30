/**
 * Task derivation for the problem kinds travel owns (`stationToStaff`; CONTRACTS "How work is
 * advertised", PLAN §6 W6). Exported as a `Partial<TaskDerivationTable>` for `systems/work/` (W4)
 * to merge.
 *
 * Integration 2: `interactionTiles` are the station's `operate` positions resolved from the
 * machine's placement (origin + rotated offset) now that `DerivationCtx` carries `state`.
 */
import type { TileCoord } from "../../core/types/common";
import type { MachineId } from "../../core/types/ids";
import type { DerivationCtx, DeriveTasks, TaskSpec } from "../../core/types/work";
import { rotateOffset } from "../spatial/geometry";

/** Absolute `operate` tiles of a placed machine, or `[]` if it cannot be resolved. */
export function operateTiles(ctx: DerivationCtx, machineId: MachineId): TileCoord[] {
  const machine = ctx.state.machines[machineId];
  if (machine === undefined) return [];
  const def = ctx.content.machines[machine.defId];
  const placement = ctx.content.decks[machine.deckId]?.machines.find(
    (p) => p.key === machine.placementKey,
  );
  if (def === undefined || placement === undefined) return [];
  return def.interactionPositions
    .filter((p) => p.purposes.includes("operate"))
    .map((p) => {
      const rotated = rotateOffset(p.offset, placement.rotation);
      return { x: placement.origin.x + rotated.x, y: placement.origin.y + rotated.y };
    });
}

// W6 decision: `stationToStaff` derives one `staffStation` task with no accumulated work
// (occupancy is binary); `estimatedWorkSeconds` uses `config.travel.staffEstimateSeconds`.
export const deriveStationToStaff: DeriveTasks<"stationToStaff"> = (problem, ctx) => {
  const spec: TaskSpec = {
    derivationKey: "staff",
    type: "staffStation",
    target: { kind: "machine", machineId: problem.payload.machineId },
    baseUrgency: problem.baseUrgency,
    requiredSkills: [],
    requiredTools: [],
    consumables: [],
    workerSlots: 1,
    interactionTiles: operateTiles(ctx, problem.payload.machineId),
    dependencyIds: [],
    progressRef: { kind: "occupancy", machineId: problem.payload.machineId },
    completion: { kind: "problemResolved" },
    estimatedWorkSeconds: ctx.config.travel.staffEstimateSeconds,
  };
  return [spec];
};

export const travelTaskDerivations = {
  stationToStaff: deriveStationToStaff,
};
