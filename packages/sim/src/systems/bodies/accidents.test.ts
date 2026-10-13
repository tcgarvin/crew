/**
 * §accidents-aboard on the bodies fixture (four crew standing in the hold, the engine in
 * engineering): each hazard fires only under its own condition at a chance of 1 and never at 0,
 * lands blunt and never on the head, emits `accident` with the configured line, gives the crew in
 * the room `sawCrewHurt`, and doubles for the exhausted.
 */
import { describe, expect, it } from "vitest";
import { rebuildItemIndexes } from "../../core/caches";
import { allocateId } from "../../core/ids";
import type { ConfigDef } from "../../core/types/content";
import type { EventDraft } from "../../core/types/events";
import type { ActorId, MachineId, TaskId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import type { StepCtx } from "../../core/types/pipeline";
import { shipDeckId } from "../../core/world";
import { compartment } from "../field/fixtures/field-deck";
import { FIX } from "../travel/fixtures";
import { accidentsSystem, thrownByImpact } from "./accidents";
import { BODIES_EVERY_TICKS } from "./bodies";
import { BETTINA, JAX, MARA, PRIYA, actorOf, bodiesWorld, stepCtxOf } from "./fixtures/bodies-deck";

type Accidents = ConfigDef["accidents"];

const CERTAIN: Partial<Accidents> = { hotWorkPerSecond: 1, slipPerSecond: 1, impactThrowChance: 1 };
const NEVER: Partial<Accidents> = { hotWorkPerSecond: 0, slipPerSecond: 0, impactThrowChance: 0 };

/** A half-second step context with `accidents` over the default bundle's. */
function ctxWith(
  world: World,
  accidents: Partial<Accidents>,
): { ctx: StepCtx; drafts: EventDraft[] } {
  const { ctx, drafts } = stepCtxOf(world);
  const config = { ...ctx.config, accidents: { ...ctx.config.accidents, ...accidents } };
  return { ctx: { ...ctx, config, elapsedTicks: BODIES_EVERY_TICKS }, drafts };
}

function accidents(drafts: readonly EventDraft[]) {
  return drafts.filter((d) => d.type === "accident");
}

function engineOf(world: World): MachineId {
  const engine = Object.values(world.state.machines).find((m) => m.defId === FIX.engine);
  if (engine === undefined) throw new Error("no engine");
  return engine.id;
}

/** Put `actorId` on a repair's `recipe` work step at the engine, at `temperature`. */
function atHotWork(world: World, actorId: ActorId, temperature: number): void {
  const machineId = engineOf(world);
  const machine = world.state.machines[machineId];
  if (machine === undefined) throw new Error("no engine");
  machine.temperature = temperature;
  const taskId = "task.test.repair" as TaskId;
  world.state.work.tasks[taskId] = {
    id: taskId,
    problemId: "problem.test" as never,
    derivationKey: "repair",
    type: "repairDamage",
    target: { kind: "machine", machineId },
    createdTick: 0,
    revision: 1,
    status: "active",
    baseUrgency: "essentialOperation",
    requiredSkills: [],
    requiredTools: [],
    consumables: [],
    workerSlots: 1,
    interactionTiles: [],
    dependencyIds: [],
    progressRef: { kind: "integrity", machineId },
    claimState: { kind: "unclaimed" },
    completion: { kind: "problemResolved" },
    estimatedWorkSeconds: 10,
  };
  actorOf(world, actorId).activity = {
    kind: "task",
    taskId,
    claimId: "claim.test" as never,
    urgency: "essentialOperation",
    action: {
      kind: "repair",
      stage: "working",
      targetId: machineId,
      progress: 0,
      startedTick: 0,
      interruptible: true,
    },
    sinceTick: 0,
    plan: {
      steps: [{ kind: "work", stage: "recipe", ticksDone: 0, ticksNeeded: 0 }],
      stepIndex: 0,
    },
  };
}

/** Put a cargo crate in `actorId`'s hands. */
function carryCrate(world: World, actorId: ActorId): void {
  const id = allocateId(world.state, "item");
  world.state.items[id] = {
    id,
    defId: FIX.crate,
    stacking: "unique",
    condition: 1,
    location: { kind: "carriedBy", actorId },
  };
  rebuildItemIndexes(world.state, world.caches.index);
}

function settled() {
  const fixture = bodiesWorld();
  fixture.kernel.advance(fixture.world, 2);
  return fixture.world;
}

const derateOf = (world: World) =>
  world.content.machines[FIX.engine]?.heat.derateAbove ?? Number.NaN;

describe("hot work (§accidents-aboard)", () => {
  it("burns an arm, a blunt graze, working on a machine past its derate heat", () => {
    const world = settled();
    atHotWork(world, JAX, derateOf(world) + 0.1);
    const { ctx, drafts } = ctxWith(world, CERTAIN);
    accidentsSystem.run(ctx);
    const [accident, ...rest] = accidents(drafts);
    expect(rest).toHaveLength(0);
    expect(accident?.payload).toEqual({
      actorId: JAX,
      hazard: "hotWork",
      how: "Jax Okonkwo is burned working on the main engine",
      machineId: engineOf(world),
    });
    const [wound] = actorOf(world, JAX).body.wounds;
    expect(wound).toMatchObject({ severity: "graze", type: "blunt", bleeding: false });
    expect(["leftArm", "rightArm"]).toContain(wound?.part);
    const wounded = drafts.find((d) => d.type === "wounded");
    expect(wounded?.payload).toMatchObject({ actorId: JAX, narrated: true });
  });

  it("never fires below the derate heat, off the work step, or at a chance of 0", () => {
    const cool = settled();
    atHotWork(cool, JAX, derateOf(cool) - 0.1);
    const coolRun = ctxWith(cool, CERTAIN);
    accidentsSystem.run(coolRun.ctx);
    expect(accidents(coolRun.drafts)).toHaveLength(0);

    const walking = settled();
    atHotWork(walking, JAX, derateOf(walking) + 0.1);
    const activity = actorOf(walking, JAX).activity;
    if (activity.kind !== "task" || activity.plan === undefined) throw new Error("no plan");
    activity.plan.steps = [{ kind: "moveTo", target: { x: 10, y: 3 }, requested: false }];
    const walkingRun = ctxWith(walking, CERTAIN);
    accidentsSystem.run(walkingRun.ctx);
    expect(accidents(walkingRun.drafts)).toHaveLength(0);

    const never = settled();
    atHotWork(never, JAX, derateOf(never) + 0.1);
    const neverRun = ctxWith(never, NEVER);
    accidentsSystem.run(neverRun.ctx);
    expect(accidents(neverRun.drafts)).toHaveLength(0);
    expect(actorOf(never, JAX).body.wounds).toHaveLength(0);
  });

  it("rolls nothing with accidents off", () => {
    const world = settled();
    atHotWork(world, JAX, derateOf(world) + 0.1);
    const { ctx, drafts } = ctxWith(world, { ...CERTAIN, enabled: false });
    accidentsSystem.run(ctx);
    expect(accidents(drafts)).toHaveLength(0);
  });
});

describe("a slip under a load (§accidents-aboard)", () => {
  it("hurts a leg carrying cargo in a filthy room: a graze, serious on a field alert", () => {
    const world = settled();
    world.state.dirt.tiers.hold = "filthy";
    carryCrate(world, PRIYA);
    const { ctx, drafts } = ctxWith(world, CERTAIN);
    accidentsSystem.run(ctx);
    expect(accidents(drafts).map((d) => d.payload)).toEqual([
      {
        actorId: PRIYA,
        hazard: "slip",
        how: "Priya Kessler slips on the filthy deck under a load",
      },
    ]);
    const [wound] = actorOf(world, PRIYA).body.wounds;
    expect(wound).toMatchObject({ severity: "graze", type: "blunt" });
    expect(["leftLeg", "rightLeg"]).toContain(wound?.part);

    const alert = settled();
    alert.state.dirt.tiers.hold = "filthy";
    alert.state.alert = { sinceTick: 0, cause: "field", reports: {} };
    carryCrate(alert, PRIYA);
    accidentsSystem.run(ctxWith(alert, CERTAIN).ctx);
    expect(actorOf(alert, PRIYA).body.wounds[0]).toMatchObject({
      severity: "serious",
      type: "blunt",
      bleeding: false,
    });
  });

  it("never fires in a room short of filthy, empty-handed, or at a chance of 0", () => {
    const dirty = settled();
    dirty.state.dirt.tiers.hold = "dirty";
    carryCrate(dirty, PRIYA);
    const dirtyRun = ctxWith(dirty, CERTAIN);
    accidentsSystem.run(dirtyRun.ctx);
    expect(accidents(dirtyRun.drafts)).toHaveLength(0);

    const empty = settled();
    empty.state.dirt.tiers.hold = "filthy";
    const emptyRun = ctxWith(empty, CERTAIN);
    accidentsSystem.run(emptyRun.ctx);
    expect(accidents(emptyRun.drafts)).toHaveLength(0);

    const never = settled();
    never.state.dirt.tiers.hold = "filthy";
    carryCrate(never, PRIYA);
    const neverRun = ctxWith(never, NEVER);
    accidentsSystem.run(neverRun.ctx);
    expect(accidents(neverRun.drafts)).toHaveLength(0);
  });

  it("gives the crew in the room sawCrewHurt about the hurt", () => {
    const world = settled();
    world.state.dirt.tiers.hold = "filthy";
    carryCrate(world, PRIYA);
    accidentsSystem.run(ctxWith(world, CERTAIN).ctx);
    for (const id of [JAX, MARA, BETTINA]) {
      const thought = actorOf(world, id).thoughts.find((t) => t.key === "sawCrewHurt");
      expect(thought?.refId).toBe(PRIYA);
    }
    expect(actorOf(world, PRIYA).thoughts.some((t) => t.key === "sawCrewHurt")).toBe(false);
  });
});

describe("thrown by an impact (§accidents-aboard)", () => {
  it("throws everyone in the struck room, a blunt graze below the head, and nobody elsewhere", () => {
    const world = settled();
    const elsewhere = ctxWith(world, CERTAIN);
    thrownByImpact(elsewhere.ctx, compartment(world, "engineering"));
    expect(accidents(elsewhere.drafts)).toHaveLength(0);

    const { ctx, drafts } = ctxWith(world, CERTAIN);
    thrownByImpact(ctx, compartment(world, "hold"));
    expect(accidents(drafts).map((d) => d.payload)).toEqual(
      [JAX, MARA, PRIYA, BETTINA].map((id) => ({
        actorId: id,
        hazard: "thrown",
        how: `${actorOf(world, id).name} is thrown down by the impact`,
      })),
    );
    for (const id of [JAX, MARA, PRIYA, BETTINA]) {
      const [wound, ...more] = actorOf(world, id).body.wounds;
      expect(more).toHaveLength(0);
      expect(wound).toMatchObject({ severity: "graze", type: "blunt", bleeding: false });
      expect(wound?.part).not.toBe("head");
    }
  });

  it("never kills nor reaches the head, however many rocks land", () => {
    const world = settled();
    for (let n = 0; n < 40; n++) {
      const { ctx } = ctxWith(world, CERTAIN);
      thrownByImpact({ ...ctx, tick: ctx.tick + n }, compartment(world, "hold"));
    }
    const { tolerance } = world.config.values.bodies;
    for (const id of [JAX, MARA, PRIYA, BETTINA]) {
      const actor = actorOf(world, id);
      expect(actor.availability).not.toBe("dead");
      expect(actor.body.wounds.some((w) => w.part === "head")).toBe(false);
      for (const [part, { damage }] of Object.entries(actor.body.parts)) {
        expect(damage).toBeLessThan(tolerance[part as keyof typeof tolerance]);
      }
    }
  });

  it("spares someone braced at a machine's seat", () => {
    const world = settled();
    const bridge = compartment(world, "bridge");
    const index = world.caches.index.actorsByCompartment;
    for (const ids of Object.values(index)) {
      for (const id of [JAX, MARA]) {
        const at = ids.indexOf(id);
        if (at >= 0) ids.splice(at, 1);
      }
    }
    index[bridge] = [JAX, MARA];
    const deckId = shipDeckId(world.state);
    actorOf(world, JAX).location = { kind: "onDeck", deckId, x: 14.5, y: 2.5 };
    actorOf(world, MARA).location = { kind: "onDeck", deckId, x: 13.5, y: 3.5 };
    const { ctx, drafts } = ctxWith(world, CERTAIN);
    thrownByImpact(ctx, bridge);
    expect(accidents(drafts).map((d) => d.payload.actorId)).toEqual([MARA]);
  });

  it("throws nobody at a chance of 0", () => {
    const world = settled();
    const never = ctxWith(world, NEVER);
    thrownByImpact(never.ctx, compartment(world, "hold"));
    expect(accidents(never.drafts)).toHaveLength(0);
  });

  it("doubles every chance for someone past the essential fatigue threshold", () => {
    const world = settled();
    for (const id of [JAX, MARA, PRIYA, BETTINA]) actorOf(world, id).needs.fatigue = 0;
    actorOf(world, JAX).needs.fatigue = 0.95;
    // At one half only the doubled chance is certain; the keyed draws decide the others.
    for (let n = 0; n < 5; n++) {
      const { ctx, drafts } = ctxWith(world, { impactThrowChance: 0.5 });
      thrownByImpact({ ...ctx, tick: ctx.tick + n }, compartment(world, "hold"));
      expect(accidents(drafts).map((d) => d.payload.actorId)).toContain(JAX);
    }
  });
});
