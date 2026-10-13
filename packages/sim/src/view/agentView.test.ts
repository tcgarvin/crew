import { describe, expect, it } from "vitest";
import { STUNNED_ABOVE } from "../core/body";
import type { WoundId } from "../core/types/ids";
import {
  JON,
  MARA,
  addCrateToLoad,
  addPumpSymptom,
  crewWorld,
  place,
} from "../systems/work/fixtures/crew-deck";
import { run } from "../systems/work/fixtures/run";
import { toAgentViewSnapshot } from "./snapshot";

describe("AgentView", () => {
  it("shows public problems, hides undiscovered ones, and plans for the next tick", () => {
    const tw = crewWorld();
    const { world, kernel } = tw;
    place(world, MARA, { x: 1, y: 2 });
    const cargo = addCrateToLoad(world, { x: 3, y: 6 });
    const symptom = addPumpSymptom(world);
    const view = kernel.getAgentView(world, MARA);
    expect(view.tick).toBe(world.state.tick + 1);
    const ids = view.knownProblems().map((p) => p.id);
    expect(ids).toContain(cargo.problemId);
    expect(ids).not.toContain(symptom.problemId);
    expect(view.self.onDuty).toBe(true);
    expect(view.self.tile).toEqual({ x: 1, y: 2 });
    expect(view.schematic.amenities("bed")).toHaveLength(3);
    expect(view.roster().map((r) => r.actorId)).toEqual([MARA, JON]);
    expect(view.estimateTravelTicks({ x: 2, y: 2 })).toBe(10);
  });

  it("hides claim bookkeeping but names another claimant", () => {
    const tw = crewWorld();
    const { world, kernel } = tw;
    place(world, MARA, { x: 2, y: 6 });
    place(world, JON, { x: 11, y: 5 });
    addCrateToLoad(world, { x: 3, y: 6 });
    run(tw, 25, () => Object.keys(world.state.work.claims).length > 0);
    const jonView = kernel.getAgentView(world, JON);
    const [task] = jonView.knownTasks();
    expect(task).toBeDefined();
    expect("claimState" in (task ?? {})).toBe(false);
    expect(task?.knownClaimantId).toBe(MARA);
    const maraTask = kernel.getAgentView(world, MARA).knownTasks()[0];
    expect(maraTask?.knownClaimantId).toBeUndefined();
  });

  it("snapshots to plain, structured-clone-safe data", () => {
    const tw = crewWorld();
    run(tw, 12);
    const snapshot = toAgentViewSnapshot(tw.kernel.getAgentView(tw.world, MARA));
    expect(structuredClone(snapshot)).toEqual(snapshot);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(snapshot.self.id).toBe(MARA);
    expect(snapshot.facts.length).toBeGreaterThan(0);
  });

  it("gives their own wounds (not the stun hits), whether they are stunned, and the fight (§7.1)", () => {
    const tw = crewWorld();
    const { world, kernel } = tw;
    const mara = world.state.actors[MARA];
    if (mara === undefined) throw new Error("no Mara");
    const at = { tick: 0, bleeding: false, severity: "serious" } as const;
    mara.body.wounds.push(
      { ...at, id: "w1" as WoundId, part: "rightLeg", type: "blaster", bleeding: true },
      { ...at, id: "w2" as WoundId, part: "leftArm", type: "stun" },
    );
    mara.body.stun = STUNNED_ABOVE * 2;
    const body = kernel.getAgentView(world, MARA).self.body;
    expect(body.wounds).toEqual([
      { part: "rightLeg", severity: "serious", bleeding: true, treated: false },
    ]);
    expect(body.stunned).toBe(true);
    expect(body.availability).toBe("available");
    expect(kernel.getAgentView(world, MARA).self.combatant).toBeUndefined();
    mara.combatant = {
      side: "us",
      disposition: { part: "ally", resolveBase: 0.6, loyalty: 1, wants: "nothing" },
      state: "wavering",
      resolve: 0.4,
      lastDecidedTick: 0,
    };
    expect(kernel.getAgentView(world, MARA).self.combatant).toEqual({
      side: "us",
      state: "wavering",
    });
  });
});
