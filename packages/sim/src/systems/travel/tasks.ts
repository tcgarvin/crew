/**
 * Task derivation for `stationToStaff` (the watch's, §problem-ownership, derived here beside the
 * helm's other travel wiring) and `courseToPlot` (travel's, §course-plotting; its rule is in
 * `course.ts`). CONTRACTS "How work is advertised", PLAN §6 W6. Exported as a
 * `Partial<TaskDerivationTable>` for `systems/work/` (W4) to merge.
 *
 * Integration 2: `interactionTiles` are the station's `operate` positions resolved from the
 * machine's placement (origin + rotated offset) now that `DerivationCtx` carries `state`.
 */
import type { TileCoord } from "../../core/types/common";
import type { MachineId } from "../../core/types/ids";
import type { DerivationCtx, DeriveTasks, TaskSpec } from "../../core/types/work";
import { rotateOffset } from "../spatial/geometry";
import { deriveCourseToPlot } from "./course";

/** Absolute `operate` tiles of a placed machine, or `[]` if it cannot be resolved. */
export function operateTiles(
  ctx: Pick<DerivationCtx, "state" | "content">,
  machineId: MachineId,
): TileCoord[] {
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

/**
 * The skill a station's stander needs on the task: the def's `operatorSkill` at a floor of 1
 * (§who-has-the-helm: anyone with the skill at all may stand it as the unqualified fallback; who
 * stands it is the sim's, `helmRoleOf`, not this requirement's).
 */
function stationSkills(ctx: Pick<DerivationCtx, "state" | "content">, machineId: MachineId) {
  const machine = ctx.state.machines[machineId];
  const skill =
    machine === undefined
      ? undefined
      : ctx.content.machines[machine.defId]?.operation.operatorSkill;
  return skill === undefined ? [] : [{ skill: skill.skill, min: Math.min(skill.min, 1) }];
}

// W6 decision: `stationToStaff` derives one `staffStation` task with no accumulated work
// (occupancy is binary); `estimatedWorkSeconds` uses `config.travel.staffEstimateSeconds`.
// §problem-ownership: one task per post (`staff:watch`, `staff:relief`). The watch post has two
// slots, so the oncoming stander can claim it beside the one they relieve; only the stander and the
// oncoming may (`planner/helm.ts`, from the sim's `helmRoleOf`), so the second slot never sends an
// idle hand to the helm.
const deriveStationToStaff: DeriveTasks<"stationToStaff"> = (problem, ctx) => {
  const { machineId, post } = problem.payload;
  const spec: TaskSpec = {
    derivationKey: `staff:${post}`,
    type: "staffStation",
    target: { kind: "machine", machineId },
    baseUrgency: problem.baseUrgency,
    requiredSkills: stationSkills(ctx, machineId),
    requiredTools: [],
    consumables: [],
    workerSlots: post === "watch" ? 2 : 1,
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
  courseToPlot: deriveCourseToPlot,
};
