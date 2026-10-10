import { describe, expect, it } from "vitest";
import type { PlannerConfig } from "../../core/types/pipeline";
import { enumerateCandidates, sleepUrgency } from "../../planner/candidates";
import { selectIntent } from "../../planner/select";
import { currentStep } from "./activity";
import {
  JON,
  MARA,
  addCrateToLoad,
  addEngineFault,
  crewWorld,
  place,
  withoutRounds,
} from "./fixtures/crew-deck";
import { run } from "./fixtures/run";

function actorOf(tw: ReturnType<typeof crewWorld>, id: typeof MARA) {
  const actor = tw.world.state.actors[id];
  if (actor === undefined) throw new Error(`no actor ${id}`);
  return actor;
}

function plannerConfig(tw: ReturnType<typeof crewWorld>): PlannerConfig {
  const {
    work,
    urgency,
    needs,
    time,
    galley,
    recreation,
    social,
    mood,
    field,
    damage,
    intercom,
    expedition,
    bodies,
  } = tw.world.config.values;
  return {
    work,
    urgency,
    needs,
    time,
    galley,
    recreation,
    social,
    mood,
    field,
    damage,
    intercom,
    expedition,
    bodies,
  };
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
    withoutRounds(world);
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
    withoutRounds(world);
    const view = kernel.getAgentView(world, MARA);
    expect(selectIntent(view, plannerConfig(tw))).toEqual({ kind: "idle" });
    actorOf(tw, MARA).needs.fatigue = 0.75; // pressing: she is on watch (§duty-and-the-sleep-watch)
    run(tw, 25);
    expect(world.state.actors[MARA]?.activity.kind).toBe("personal");
    actorOf(tw, MARA).needs.hunger = 0.75; // same class as sleep: keep sleeping
    expect(selectIntent(kernel.getAgentView(world, MARA), plannerConfig(tw))).toEqual({
      kind: "continue",
    });
  });

  it("routine tiredness is slept off in the sleep watch, from bedtime on; pressing tiredness anywhere", () => {
    const tw = crewWorld();
    const { world, kernel } = tw;
    withoutRounds(world);
    const sleepClass = () =>
      enumerateCandidates(kernel.getAgentView(world, MARA), plannerConfig(tw)).candidates.find(
        (c) => c.choice.kind === "personal" && c.choice.activity === "sleep",
      )?.urgency;
    actorOf(tw, MARA).needs.fatigue = 0.6;
    expect(kernel.getAgentView(world, MARA).self.onDuty).toBe(true);
    expect(kernel.getAgentView(world, MARA).self.watch.sleepWatch).toBeUndefined();
    expect(sleepClass()).toBeUndefined();
    // Her section (`alpha`) stands [0, 300) s of the 600 s day; the watch after is her sleep
    // watch, where even bedtime tiredness (above `bedtimeAbove`, below the seek threshold) sends
    // her to bed.
    world.state.tick = 300 * world.config.values.time.tickRate;
    expect(kernel.getAgentView(world, MARA).self.onDuty).toBe(false);
    expect(kernel.getAgentView(world, MARA).self.watch.sleepWatch).toBe(true);
    expect(sleepClass()).toBe("routineObligation");
    actorOf(tw, MARA).needs.fatigue = 0.35;
    expect(sleepClass()).toBe("routineObligation");
    actorOf(tw, MARA).needs.fatigue = 0.2;
    expect(sleepClass()).toBeUndefined();
    world.state.tick = 0;
    actorOf(tw, MARA).needs.fatigue = 0.75;
    expect(sleepClass()).toBe("essentialOperation");
  });

  it("outside the sleep watch, routine tiredness waits even off duty", () => {
    const tw = crewWorld();
    const config = plannerConfig(tw);
    const view = (sleepWatch: boolean) =>
      ({
        self: { watch: sleepWatch ? { sleepWatch: true } : {} },
      }) as unknown as Parameters<typeof sleepUrgency>[0];
    expect(sleepUrgency(view(false), config, 0.6)).toBeUndefined();
    expect(sleepUrgency(view(false), config, 0.75)).toBe("essentialOperation");
    expect(sleepUrgency(view(true), config, 0.6)).toBe("routineObligation");
    expect(sleepUrgency(view(true), config, 0.2)).toBeUndefined();
  });

  it("a sleeper is woken for an emergency, not for essential work or a meal", () => {
    const tw = crewWorld();
    const { world, kernel } = tw;
    withoutRounds(world);
    world.state.tick = 300 * world.config.values.time.tickRate;
    actorOf(tw, MARA).needs.fatigue = 0.6;
    run(tw, 25);
    expect(world.state.actors[MARA]?.activity).toMatchObject({
      kind: "personal",
      activity: "sleep",
    });
    actorOf(tw, MARA).needs.hunger = 0.75;
    expect(selectIntent(kernel.getAgentView(world, MARA), plannerConfig(tw))).toEqual({
      kind: "continue",
    });
    actorOf(tw, MARA).needs.hunger = 0.95;
    expect(selectIntent(kernel.getAgentView(world, MARA), plannerConfig(tw))).toMatchObject({
      kind: "personal",
      activity: "eat",
    });
  });

  it("rest and chat take the need's urgency past the seek threshold, voluntary below", () => {
    const tw = crewWorld();
    const { world, kernel } = tw;
    withoutRounds(world);
    world.state.tick = 300 * world.config.values.time.tickRate; // Mara off duty
    const urgencyOf = (activity: "rest" | "socialize") =>
      enumerateCandidates(kernel.getAgentView(world, MARA), plannerConfig(tw)).candidates.find(
        (c) => c.choice.kind === "personal" && c.choice.activity === activity,
      )?.urgency;
    const mara = actorOf(tw, MARA);
    mara.needs.social = 0.3;
    mara.needs.comfort = 0.3;
    expect(urgencyOf("socialize")).toBe("voluntaryActivity");
    expect(urgencyOf("rest")).toBe("voluntaryActivity");
    mara.needs.social = 0.6;
    mara.needs.comfort = 0.75;
    // So a lonely person off watch is not always beaten to the lounge by a routine game.
    expect(urgencyOf("socialize")).toBe("routineObligation");
    expect(urgencyOf("rest")).toBe("essentialOperation");
  });

  it("a chat taken because the need pressed ends when it is met, off duty too", () => {
    const tw = crewWorld();
    const { world } = tw;
    withoutRounds(world);
    world.state.tick = 300 * world.config.values.time.tickRate;
    const mara = actorOf(tw, MARA);
    mara.needs.social = 0.6;
    const holding = (what: readonly string[], urgency: string) => (w: typeof world) => {
      const activity = w.state.actors[MARA]?.activity;
      return (
        activity?.kind === "personal" &&
        what.includes(activity.activity) &&
        activity.urgency === urgency &&
        currentStep(activity)?.kind === "hold"
      );
    };
    const chatting = holding(["socialize"], "routineObligation");
    run(tw, 400, chatting);
    expect(chatting(world)).toBe(true);
    // Met, the routine hold ends and she replans: off duty with nothing pressing, an idle rest
    // or chat (before the tuning the routine chat went on until something essential came up).
    const idling = holding(["rest", "socialize"], "voluntaryActivity");
    run(tw, 2000, (w) => (w.state.actors[MARA]?.needs.social ?? 1) <= 0);
    expect(mara.needs.social).toBe(0);
    run(tw, 40, idling);
    expect(idling(world)).toBe(true);
    // The idle chat lasts off duty (until the planner finds something more pressing).
    const held = () => {
      const activity = world.state.actors[MARA]?.activity;
      return activity?.kind === "personal"
        ? { activity: activity.activity, urgency: activity.urgency, sinceTick: activity.sinceTick }
        : undefined;
    };
    const before = held();
    run(tw, 200);
    expect(held()).toEqual(before);
  });
});
