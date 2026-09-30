import { describe, expect, it } from "vitest";
import type { PlannerConfig } from "../../core/types/pipeline";
import { enumerateCandidates } from "../../planner/candidates";
import { selectIntent } from "../../planner/select";
import { JON, MARA, addCrateToLoad, addEngineFault, crewWorld, place } from "./fixtures/crew-deck";
import { run } from "./fixtures/run";

function actorOf(tw: ReturnType<typeof crewWorld>, id: typeof MARA) {
  const actor = tw.world.state.actors[id];
  if (actor === undefined) throw new Error(`no actor ${id}`);
  return actor;
}

function plannerConfig(tw: ReturnType<typeof crewWorld>): PlannerConfig {
  const c = tw.world.config.values;
  return { work: c.work, urgency: c.urgency, needs: c.needs, time: c.time };
}

describe("selectIntent", () => {
  it("is pure: same view, same intent, no state change", () => {
    const tw = crewWorld();
    const { world, kernel } = tw;
    place(world, MARA, { x: 2, y: 6 });
    actorOf(tw, MARA).needs.hunger = 0.6;
    addCrateToLoad(world, { x: 3, y: 6 });
    run(tw, 12);
    const before = JSON.stringify(world.state);
    const view = kernel.getAgentView(world, MARA);
    const a = selectIntent(view, plannerConfig(tw));
    const b = selectIntent(view, plannerConfig(tw));
    expect(a).toEqual(b);
    expect(JSON.stringify(world.state)).toBe(before);
  });

  it("ranks the highest urgency class first, then time to intervention", () => {
    const tw = crewWorld();
    const { world, kernel } = tw;
    actorOf(tw, JON).availability = "incapacitated";
    place(world, MARA, { x: 2, y: 6 });
    addCrateToLoad(world, { x: 3, y: 6 });
    addEngineFault(world);
    actorOf(tw, MARA).needs.hunger = 0.6;
    run(tw, 10);
    actorOf(tw, MARA).activity = { kind: "idle" };
    const view = kernel.getAgentView(world, MARA);
    const { candidates } = enumerateCandidates(view, plannerConfig(tw));
    expect(candidates.map((c) => c.urgency).sort()).toEqual(
      ["containment", "routineObligation", "routineObligation"].sort(),
    );
    const intent = selectIntent(view, plannerConfig(tw));
    expect(intent.kind).toBe("task");
    if (intent.kind === "task") {
      expect(intent.urgency).toBe("containment");
      expect(intent.trace.candidates).toBe(3);
    }
  });

  it("returns idle when there is nothing to do, and continue while committed", () => {
    const tw = crewWorld();
    const { world, kernel } = tw;
    const view = kernel.getAgentView(world, MARA);
    expect(selectIntent(view, plannerConfig(tw))).toEqual({ kind: "idle" });
    actorOf(tw, MARA).needs.fatigue = 0.6;
    run(tw, 25);
    expect(world.state.actors[MARA]?.activity.kind).toBe("personal");
    actorOf(tw, MARA).needs.hunger = 0.6; // same class as sleep: keep sleeping
    expect(selectIntent(kernel.getAgentView(world, MARA), plannerConfig(tw))).toEqual({
      kind: "continue",
    });
  });
});
