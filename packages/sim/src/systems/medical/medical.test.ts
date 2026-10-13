/**
 * §medicine on the medical fixture (a medbay bed in the hold, three med kits in stowage): the
 * wounded problem raised, revised, resolved and cancelled; the treatment task derived only with a
 * kit aboard; the medic's plan waiting for the patient at the bed; and the whole round, the
 * patient to the bed and the medic with a kit, ending in a treated wound and one kit fewer.
 */
import { describe, expect, it } from "vitest";
import type { Task } from "../../core/types/work";
import { marketStoreLocation } from "../commerce/market";
import { PORTS } from "../travel/fixtures";
import { medBedOf } from "./bed";
import {
  BEDSIDE,
  BETTINA,
  JAX,
  PRIYA,
  actorOf,
  bodiesWorldViolations,
  kitsAboard,
  medicalWorld,
  ofType,
  runFor,
  runUntil,
  stepCtxOf,
  woundNow,
  woundedProblems,
} from "./fixtures/medical-deck";
import { sweepWounded } from "./medical";
import { treatPlan } from "./plans";
import { medicalTaskDerivations } from "./tasks";

function sweep(world: Parameters<typeof stepCtxOf>[0]) {
  const { ctx, drafts } = stepCtxOf(world);
  sweepWounded(ctx);
  return drafts;
}

function openWounded(world: Parameters<typeof stepCtxOf>[0]) {
  return woundedProblems(world).filter((p) => p.status === "open");
}

describe("the wounded problem (§the-wounded-problem)", () => {
  it("is raised at the bed for a wounded crew member: essential while bleeding, routine after", () => {
    const { world } = medicalWorld();
    woundNow(world, PRIYA, { part: "leftLeg", severity: "serious", type: "blaster" });
    sweep(world);
    const bed = medBedOf(world.state, world.content);
    const [problem] = openWounded(world);
    expect(problem).toMatchObject({
      owner: "medical",
      visibility: "public",
      dedupeKey: `wounded:${PRIYA}`,
      baseUrgency: "essentialOperation",
      payload: { actorId: PRIYA, untreated: 1 },
      location: { kind: "compartment", compartmentId: bed?.compartmentId },
      revision: 1,
    });

    const wound = actorOf(world, PRIYA).body.wounds[0];
    if (wound === undefined) throw new Error("no wound");
    wound.bleeding = false;
    sweep(world);
    expect(openWounded(world)).toMatchObject([{ baseUrgency: "routineObligation", revision: 2 }]);

    woundNow(world, PRIYA, { part: "rightArm", severity: "graze", type: "blunt" });
    sweep(world);
    expect(openWounded(world)).toMatchObject([{ payload: { untreated: 2 }, revision: 3 }]);
  });

  it("resolves once every wound is treated, and is cancelled when the patient dies", () => {
    const { world } = medicalWorld();
    woundNow(world, PRIYA, { part: "leftLeg", severity: "graze", type: "blunt" });
    woundNow(world, JAX, { part: "rightLeg", severity: "graze", type: "blunt" });
    sweep(world);
    expect(openWounded(world)).toHaveLength(2);
    for (const wound of actorOf(world, PRIYA).body.wounds) wound.treatedTick = world.state.tick;
    actorOf(world, JAX).availability = "dead";
    const drafts = sweep(world);
    const byActor = Object.fromEntries(
      woundedProblems(world).map((p) => [p.payload.actorId, p.status]),
    );
    expect(byActor).toEqual({ [PRIYA]: "resolved", [JAX]: "cancelled" });
    expect(drafts.filter((d) => d.type === "problemResolved")).toHaveLength(1);
  });

  it("ignores a stun hit, and raises nothing on a deck with no medbay bed", () => {
    const stunned = medicalWorld();
    woundNow(stunned.world, PRIYA, { part: "leftLeg", severity: "serious", type: "stun" });
    sweep(stunned.world);
    expect(woundedProblems(stunned.world)).toEqual([]);

    const bare = medicalWorld({ bed: false });
    woundNow(bare.world, PRIYA, { part: "leftLeg", severity: "serious", type: "blaster" });
    sweep(bare.world);
    expect(woundedProblems(bare.world)).toEqual([]);
  });
});

describe("treatment at the medbay bed (§treatment-at-the-medbay-bed)", () => {
  function derived(kits: number) {
    const { world, kernel } = medicalWorld({ kits });
    // A planner cycle for the crew's first look round: the brief tells them where the kits are.
    kernel.advance(world, 2 * world.config.values.work.reconsiderEveryTicks);
    woundNow(world, PRIYA, { part: "leftLeg", severity: "serious", type: "blaster" });
    woundNow(world, PRIYA, { part: "torso", severity: "graze", type: "blunt" });
    sweep(world);
    const [problem] = openWounded(world);
    if (problem === undefined) throw new Error("no problem");
    const ctx = {
      content: world.content,
      config: world.config.values,
      tick: world.state.tick,
      state: world.state,
    };
    return { world, specs: medicalTaskDerivations.crewWounded(problem, ctx) };
  }

  it("derives one treatment with a kit aboard, beside the bed, and none without", () => {
    const { world, specs } = derived(3);
    const bed = medBedOf(world.state, world.content);
    expect(specs).toMatchObject([
      {
        type: "treatWounds",
        target: { kind: "actor", actorId: PRIYA },
        requiredSkills: [{ skill: "medical", min: 1 }],
        consumables: [{ count: 1 }],
        workerSlots: 1,
        progressRef: { kind: "wounds", actorId: PRIYA },
        completion: { kind: "problemResolved" },
        estimatedWorkSeconds: 30,
      },
    ]);
    expect(specs[0]?.interactionTiles).toEqual(bed?.medicTiles);
    expect(specs[0]?.interactionTiles).not.toContainEqual(BEDSIDE);
    expect(derived(0).specs).toEqual([]);
  });

  it("the medic's plan waits for the patient at the bed (dependencyPending)", () => {
    const { world, specs } = derived(3);
    const [spec] = specs;
    if (spec === undefined) throw new Error("no spec");
    const task = { ...spec, id: "t1", problemId: "p1" } as unknown as Task;
    const { ctx } = stepCtxOf(world);
    const medic = actorOf(world, BETTINA);
    expect(treatPlan(ctx, medic, task)).toEqual({ ok: false, reason: "dependencyPending" });
    const priya = actorOf(world, PRIYA);
    priya.location = { ...priya.location, x: BEDSIDE.x + 0.5, y: BEDSIDE.y + 0.5 } as never;
    const plan = treatPlan(ctx, medic, task);
    expect(plan).toMatchObject({ ok: true });
    if (!plan.ok) return;
    expect(plan.plan.steps.map((s) => s.kind)).toEqual(["moveTo", "pickUp", "moveTo", "work"]);
    expect(plan.plan.steps.at(-1)).toMatchObject({ kind: "work", stage: "treat" });
  });

  it("the patient walks to the bed, the medic brings a kit, and the wound is treated", () => {
    const test = medicalWorld();
    const { world } = test;
    woundNow(world, PRIYA, { part: "leftLeg", severity: "serious", type: "blaster" });
    const painBefore = actorOf(world, PRIYA).body.pain;
    const labels = (w: typeof world) =>
      Object.values(w.state.actors).map((a) =>
        a.activity.kind === "idle" ? "" : a.activity.label,
      );
    const early = runUntil(test, 180, (w) => labels(w).includes("treating Priya Kessler"));
    const priyaActivity = actorOf(world, PRIYA).activity;
    expect(priyaActivity.kind === "personal" ? priyaActivity.label : undefined).toBe(
      "in the medbay",
    );
    expect(ofType(early, "woundTreated")).toEqual([]);
    const events = runUntil(test, 180, (w) =>
      actorOf(w, PRIYA).body.wounds.every((x) => x.treatedTick !== undefined),
    );
    // The tick the wound was treated, the problem is resolved by the treatment itself.
    events.push(...runFor(test, 1));
    const [treated] = ofType(events, "woundTreated");
    expect(treated?.payload).toMatchObject({ actorId: PRIYA, woundIds: [expect.any(String)] });
    expect(treated?.payload.byActorId).toBeDefined();
    expect(treated?.payload.byActorId).not.toBe(PRIYA);
    const wound = actorOf(world, PRIYA).body.wounds[0];
    expect(wound?.bleeding).toBe(false);
    expect(wound?.treatedTick).toBeDefined();
    expect(actorOf(world, PRIYA).body.pain).toBeLessThan(painBefore);
    expect(kitsAboard(world)).toBe(2);
    expect(woundedProblems(world).map((p) => p.status)).toEqual(["resolved"]);
    expect(bodiesWorldViolations(world)).toEqual([]);
  });

  it("a patient waiting at the bed with no kit aboard gives up, and backs off as long (§convalescing)", () => {
    const test = medicalWorld({ kits: 1, medical: { giveUpAfterSeconds: 10 } });
    const { world, kernel } = test;
    // The kit is on the bridge, out of the hold's sight, when the crew are briefed on the stores.
    const [kit] = Object.values(world.state.items);
    if (kit === undefined || kit.location.kind !== "onDeck") throw new Error("no kit on deck");
    kit.location = { ...kit.location, x: 13.5, y: 4.5 };
    kernel.advance(world, 2 * world.config.values.work.reconsiderEveryTicks);
    // Then it is ashore (sold, say), but Priya still believes it is on the bridge.
    const alpha = world.content.ports[PORTS.a];
    if (alpha === undefined) throw new Error("no port Alpha");
    kit.location = marketStoreLocation(alpha);
    woundNow(world, PRIYA, { part: "leftLeg", severity: "graze", type: "blunt" });
    runUntil(test, 60, (w) => {
      const activity = actorOf(w, PRIYA).activity;
      return activity.kind === "personal" && activity.activity === "convalesce";
    });
    runUntil(test, 60, (w) => {
      const activity = actorOf(w, PRIYA).activity;
      return activity.kind !== "personal" || activity.activity !== "convalesce";
    });
    const backoff = actorOf(world, PRIYA).workBackoff?.convalesce ?? 0;
    expect(backoff - world.state.tick).toBeGreaterThan(9 * world.config.values.time.tickRate);
    expect(actorOf(world, PRIYA).body.wounds[0]?.treatedTick).toBeUndefined();
    expect(Object.values(world.state.work.tasks).filter((t) => t.type === "treatWounds")).toEqual(
      [],
    );
  });
});
