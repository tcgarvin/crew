/**
 * Task urgency for critical machines (slice-5 integration, D93) over a hand-built `AgentView`:
 * impact damage to the engine is containment, like a fault there; the generator's fault or
 * damage is containment while the ship is on alert and keeps its owner's class off it; on alert
 * a symptom on a critical machine is looked at as containment; a damaged galley stove keeps its
 * owner's class either way.
 */
import { describe, expect, it } from "vitest";
import type { MachineTag } from "../core/types/content";
import type { MachineDefId, MachineId, ProblemId } from "../core/types/ids";
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView, AlertView, MachinePlacementView, ProblemView } from "../core/types/view";
import { taskUrgency } from "./candidates";

const ALERT: AlertView = { sinceTick: 900, cause: "field" };

const placement = (id: string, tag: MachineTag): MachinePlacementView => ({
  machineId: id as MachineId,
  defId: `machine.${tag}` as MachineDefId,
  tags: [tag],
  footprint: [{ x: 0, y: 0 }],
  interactionTiles: [],
});

const MACHINES = [
  placement("m1", "engine"),
  placement("m2", "generator"),
  placement("m3", "stove"),
] as const;

function view(alert: AlertView | undefined): AgentView {
  return {
    tick: 1000,
    schematic: { machines: () => MACHINES },
    fact: () => undefined,
    alert: () => alert,
  } as unknown as AgentView;
}

function problem(
  kind: "machineDamaged" | "machineFault" | "machineSymptom",
  machineId: string,
): ProblemView {
  return {
    id: "p1" as ProblemId,
    kind,
    payload: kind === "machineFault" ? { machineId, faultKey: "short" } : { machineId },
    baseUrgency: "essentialOperation",
  } as unknown as ProblemView;
}

const config = {
  urgency: { heatSurvivalAbove: 0.95, heatContainmentAbove: 0.8 },
} as PlannerConfig;

describe("critical machines (D93)", () => {
  it("rates impact damage to the engine as containment, on alert or off", () => {
    expect(taskUrgency(view(ALERT), problem("machineDamaged", "m1"), config)).toBe("containment");
    expect(taskUrgency(view(undefined), problem("machineDamaged", "m1"), config)).toBe(
      "containment",
    );
  });

  it("rates the generator's fault or damage as containment only on alert", () => {
    for (const kind of ["machineDamaged", "machineFault"] as const) {
      expect(taskUrgency(view(ALERT), problem(kind, "m2"), config)).toBe("containment");
      expect(taskUrgency(view(undefined), problem(kind, "m2"), config)).toBe("essentialOperation");
    }
  });

  it("rates a symptom on a critical machine as containment on alert, routine off it", () => {
    expect(taskUrgency(view(ALERT), problem("machineSymptom", "m1"), config)).toBe("containment");
    expect(taskUrgency(view(undefined), problem("machineSymptom", "m1"), config)).toBe(
      "routineObligation",
    );
    expect(taskUrgency(view(ALERT), problem("machineSymptom", "m3"), config)).toBe(
      "routineObligation",
    );
  });

  it("leaves a damaged stove at its owner's class", () => {
    expect(taskUrgency(view(ALERT), problem("machineDamaged", "m3"), config)).toBe(
      "essentialOperation",
    );
  });
});
