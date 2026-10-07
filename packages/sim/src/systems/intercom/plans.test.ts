/**
 * The report's plan and step (D94) on the intercom fixture: the plan walks to the chosen panel's
 * `operate` position and spends `intercom.reportSeconds` there; a target that is no panel is
 * refused; at a dead panel the step fails and the reporter learns it is dead; the broadcast
 * waits for the step's last tick.
 */
import { describe, expect, it } from "vitest";
import type { Actor } from "../../core/types/actor";
import type { ActivityStep } from "../../core/types/work";
import { BETTINA, galleyStepCtx, placeOnGalleyDeck } from "../galley/fixtures/galley-deck";
import {
  PANELS,
  damageMachineByHand,
  intercomWorld,
  knockOut,
  machineByKey,
  panelIn,
  soundAlert,
} from "./fixtures";
import { reportPlan } from "./plans";
import { runReport } from "./report";

const SLOW = { timeout: 15_000 };

function setUp() {
  const fixture = intercomWorld();
  const { world } = fixture;
  placeOnGalleyDeck(world, BETTINA, { x: 4, y: 2 });
  const actor = world.state.actors[BETTINA] as Actor;
  return { world, actor };
}

/** Put the actor on a report at `panel`, at the panel, on its `report` step. */
function atPanel(world: ReturnType<typeof setUp>["world"], actor: Actor, room: "galley") {
  const { ctx } = galleyStepCtx(world);
  const panelId = panelIn(world, room);
  const plan = reportPlan(ctx, actor, {
    kind: "personal",
    activity: "report",
    targetId: panelId,
    urgency: "containment",
    trace: { candidates: 1, chosenReason: "test", rejected: [] },
  });
  if (!plan.ok) throw new Error(`plan refused: ${plan.reason}`);
  placeOnGalleyDeck(world, actor.id, PANELS[room].operate);
  actor.activity = {
    kind: "personal",
    activity: "report",
    urgency: "containment",
    action: {
      kind: "report",
      stage: "talking",
      targetId: panelId,
      progress: 0,
      startedTick: world.state.tick,
      interruptible: true,
    },
    sinceTick: world.state.tick,
    plan: { ...plan.plan, stepIndex: 1 },
  };
  return { panelId, step: plan.plan.steps[1] as Extract<ActivityStep, { kind: "work" }> };
}

describe("reportPlan (D94)", () => {
  it("walks to the panel's operate position and reports for reportSeconds", SLOW, () => {
    const { world, actor } = setUp();
    const { ctx } = galleyStepCtx(world);
    const panelId = panelIn(world, "galley");
    const plan = reportPlan(ctx, actor, {
      kind: "personal",
      activity: "report",
      targetId: panelId,
      urgency: "containment",
      trace: { candidates: 1, chosenReason: "test", rejected: [] },
    });
    expect(plan).toEqual({
      ok: true,
      plan: {
        stepIndex: 0,
        steps: [
          {
            kind: "moveTo",
            target: { machineId: panelId, positionKey: "panel" },
            requested: false,
          },
          {
            kind: "work",
            stage: "report",
            ticksDone: 0,
            ticksNeeded:
              world.config.values.intercom.reportSeconds * world.config.values.time.tickRate,
          },
        ],
      },
    });
  });

  it("refuses a target that is not a panel", SLOW, () => {
    const { world, actor } = setUp();
    const { ctx } = galleyStepCtx(world);
    const plan = reportPlan(ctx, actor, {
      kind: "personal",
      activity: "report",
      targetId: machineByKey(world, "stove"),
      urgency: "containment",
      trace: { candidates: 1, chosenReason: "test", rejected: [] },
    });
    expect(plan).toEqual({ ok: false, reason: "unreachableTarget" });
  });
});

describe("runReport (D94)", () => {
  it("fails at a dead panel, and the reporter sees that it is dead", SLOW, () => {
    const { world, actor } = setUp();
    soundAlert(world);
    const { panelId, step } = atPanel(world, actor, "galley");
    knockOut(world, panelId);
    const { ctx, drafts } = galleyStepCtx(world);
    expect(runReport(ctx, actor, step)).toEqual({ fail: "unavailablePower" });
    expect(actor.knowledge[`${panelId}/machineStatus`]).toMatchObject({
      evidence: "direct",
      value: { status: "failed" },
    });
    expect(drafts).toEqual([]);
  });

  it("speaks only on the step's last tick", SLOW, () => {
    const { world, actor } = setUp();
    soundAlert(world);
    const problem = damageMachineByHand(world, machineByKey(world, "stove"));
    actor.knowledge[`${problem.id}/problem`] = {
      subjectId: problem.id,
      factType: "problem",
      value: { problemId: problem.id, revision: 0 },
      observedTick: world.state.tick,
      learnedTick: world.state.tick,
      sourceId: actor.id,
      evidence: "direct",
      certainty: "confirmed",
    };
    const { step } = atPanel(world, actor, "galley");
    const { ctx, drafts } = galleyStepCtx(world);
    const results = Array.from({ length: step.ticksNeeded }, () => runReport(ctx, actor, step));
    expect(results.slice(0, -1).every((r) => r === "wait")).toBe(true);
    expect(results.at(-1)).toBe("done");
    expect(drafts.map((d) => d.type)).toEqual(["intercomReport"]);
  });

  it("says nothing when what was seen is already public", SLOW, () => {
    const { world, actor } = setUp();
    soundAlert(world);
    const problem = damageMachineByHand(world, machineByKey(world, "stove"));
    problem.visibility = "public";
    actor.knowledge[`${problem.id}/problem`] = {
      subjectId: problem.id,
      factType: "problem",
      value: { problemId: problem.id, revision: 0 },
      observedTick: world.state.tick,
      learnedTick: world.state.tick,
      sourceId: actor.id,
      evidence: "direct",
      certainty: "confirmed",
    };
    const { step } = atPanel(world, actor, "galley");
    step.ticksDone = step.ticksNeeded - 1;
    const { ctx, drafts } = galleyStepCtx(world);
    expect(runReport(ctx, actor, step)).toBe("done");
    expect(drafts).toEqual([]);
    expect(world.state.alert?.reports).toEqual({});
  });
});
