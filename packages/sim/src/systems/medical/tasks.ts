/**
 * Task derivation for the wounded problem (§treatment-at-the-medbay-bed). Merged by
 * `systems/work/` with the other systems' rules.
 *
 * `crewWounded` → one `treatWounds` while the ship has a medbay bed and at least
 * `medical.kitsPerTreatment` units of a `medical` item aboard (the first such def by id, found by
 * tag as patch kits are, `taggedDefAboard`): medical ≥ 1, no tool, that many units used up,
 * one worker, standing beside the bed (`MedBed.medicTiles`), `treatSecondsPerWound` a wound
 * nobody has treated. Progress is the patient's wounds; the treatment resolves the problem. With no
 * kit aboard nothing is derived, and the task comes back once one is.
 *
 * §extraction: while the patient is down (incapacitated) and not lying at the bed, the problem
 * derives their carry there instead (`carry.ts` `carrySpecs`), and the treatment once they lie
 * there.
 */
import type { DeriveTasks, TaskDerivationTable } from "../../core/types/work";
import { taggedDefAboard } from "../damage/tasks";
import { unitsAboard } from "../equipment/supplies";
import { medBedOf, onTheBed } from "./bed";
import { carrySpecs } from "./carry";
import { untreatedWounds } from "./medical";

const MEDICAL = { skill: "medical", min: 1 } as const;

const deriveCrewWounded: DeriveTasks<"crewWounded"> = (problem, ctx) => {
  const { actorId } = problem.payload;
  const patient = ctx.state.actors[actorId];
  if (patient === undefined || patient.availability === "dead") return [];
  const untreated = untreatedWounds(patient).length;
  const bed = medBedOf(ctx.state, ctx.content);
  if (untreated === 0 || bed === undefined) return [];
  if (patient.availability === "incapacitated" && !onTheBed(ctx.state, bed, patient)) {
    return carrySpecs(ctx, problem, patient, bed);
  }
  const { kitsPerTreatment, treatSecondsPerWound } = ctx.config.medical;
  const kit = taggedDefAboard(ctx.state, ctx.content, "medical");
  if (kit === undefined || (unitsAboard(ctx.state).get(kit) ?? 0) < kitsPerTreatment) return [];
  return [
    {
      derivationKey: "treat",
      type: "treatWounds",
      target: { kind: "actor", actorId },
      baseUrgency: problem.baseUrgency,
      requiredSkills: [MEDICAL],
      requiredTools: [],
      consumables: [{ itemDefId: kit, count: kitsPerTreatment }],
      workerSlots: 1,
      interactionTiles: [...bed.medicTiles],
      dependencyIds: [],
      progressRef: { kind: "wounds", actorId },
      completion: { kind: "problemResolved" },
      estimatedWorkSeconds: treatSecondsPerWound * untreated,
    },
  ];
};

export const medicalTaskDerivations: Pick<TaskDerivationTable, "crewWounded"> = {
  crewWounded: deriveCrewWounded,
};
