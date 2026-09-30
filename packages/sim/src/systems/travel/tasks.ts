/**
 * Task derivation for the problem kinds travel owns (`stationToStaff`; CONTRACTS "How work is
 * advertised", PLAN §6 W6). Exported as a `Partial<TaskDerivationTable>` for `systems/work/` (W4)
 * to merge.
 *
 * `DerivationCtx` is `{content, config, tick}` only (no live state), so a task derived here cannot
 * resolve the machine instance's actual placement/rotation to an absolute interaction tile — that
 * needs `state.machines[machineId].placementKey` plus the deck it's on, neither of which the
 * derivation signature carries. `interactionTiles` is left empty; W4's task executor (which does
 * have state) is expected to resolve the real tile from the machine placement when it claims a
 * `staffStation` task. Documented as a `// W6 decision:` below rather than silently wrong data.
 */
import type { DeriveTasks, TaskSpec } from "../../core/types/work";

// W6 decision: `stationToStaff` derives one `staffStation` task with no accumulated work
// (occupancy is binary); `estimatedWorkSeconds` uses `config.travel.staffEstimateSeconds` (a W6
// addition), defaulting to 0 since presence, not duration, satisfies it.
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
    // See module doc: not resolvable from `DerivationCtx` alone.
    interactionTiles: [],
    dependencyIds: [],
    progressRef: { kind: "occupancy", machineId: problem.payload.machineId },
    completion: { kind: "problemResolved" },
    estimatedWorkSeconds: ctx.config.travel.staffEstimateSeconds ?? 0,
  };
  return [spec];
};

export const travelTaskDerivations = {
  stationToStaff: deriveStationToStaff,
};
