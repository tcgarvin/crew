/**
 * D66: locals on the dock and the guaranteed staging call.
 *
 * - A new game's dock has its posted regulars at their posts; locals are never actors.
 * - `stageDock` is raised `narrator.approachHookLeadSeconds` before the end of the route, and
 *   transit holds at the end of the route until it has been answered: even when another hook was
 *   pending at the lead point (it waits as `due`), when the engine dies during the hold, and
 *   across a save and restore.
 * - Its only answer is a `stageDock` plan, valid only while the hook is pending; every other
 *   narrator command is refused meanwhile. The plan's people and props land with the floor set
 *   when the dock comes alongside, and its ambience line reaches the log.
 * - Locals go with the dock at the end of undocking; departure never waits for them.
 */
import { describe, expect, it } from "vitest";
import { dockToDeck } from "../../core/docks";
import type { TestWorld } from "../../core/fixtures/test-world";
import { TINY } from "../../core/fixtures/tiny-content";
import { raiseHookIfIdle } from "../../core/hooks";
import { checkInvariants } from "../../core/invariants";
import { getRenderFrame, tickerLine } from "../../core/render";
import type { Command } from "../../core/types/commands";
import type { CastSeedDef, ConfigDef } from "../../core/types/content";
import type { StagingPlan } from "../../core/types/dockside";
import type { SimEvent } from "../../core/types/events";
import type { CommandId, HookId, PortDefId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import { WAREHOUSE_DOOR, dockWorkWorld } from "../commerce/fixtures-dock";
import { commerceViolations } from "../commerce/invariants";
import { spatialViolations } from "../spatial/invariants";
import { workViolations } from "../work/invariants";
import { FAR_DOCK, docksideConfig } from "./fixtures-dock";
import { travelViolations } from "./invariants";

const HOME = TINY.port;
const FAR = TINY.port2;

const SEEDS: Readonly<Record<string, readonly CastSeedDef[]>> = {
  [HOME]: [{ name: "Hal Test", role: "queue clerk", note: "Knows every berth.", post: "stall" }],
  [FAR]: [
    { name: "Greta Test", role: "shift boss", note: "Runs the quay.", post: "gate" },
    { name: "Osric Test", role: "assayer", note: "Not posted anywhere." },
  ],
};

/** The furnished quays with dock hands and regulars; `lead` is the staging lead in seconds. */
function stagingWorld(lead = 0.5, travel: Partial<ConfigDef["travel"]> = {}): TestWorld {
  const base = docksideConfig(travel);
  const config: ConfigDef = {
    ...base,
    narrator: { ...base.narrator, approachHookLeadSeconds: lead },
  };
  return dockWorkWorld({ dockHands: true, castSeed: SEEDS }, config);
}

let n = 0;
function command(test: TestWorld, draft: Omit<Command, "id">) {
  n += 1;
  return test.kernel.enqueueCommand(test.world, {
    ...draft,
    id: `cmd:staging:${n}` as CommandId,
  } as Command);
}

function ack(test: TestWorld, hookId: HookId) {
  return command(test, { source: "system", kind: "acknowledgeHook", payload: { hookId } });
}

function violations(world: World): string[] {
  return [
    ...checkInvariants(world.state),
    ...spatialViolations(world),
    ...workViolations(world),
    ...travelViolations(world),
    ...commerceViolations(world),
  ];
}

/**
 * Step tick by tick, acknowledging every hook but `stageDock` (which stops the run), checking
 * every invariant, until `until` holds or `ticks` run out.
 */
function run(
  test: TestWorld,
  ticks: number,
  until: (world: World) => boolean,
  ackStaging = false,
): SimEvent[] {
  const { kernel, world } = test;
  const events: SimEvent[] = [];
  for (let i = 0; i < ticks && !until(world); i++) {
    const hook = world.state.narrator.pendingHook;
    if (hook !== undefined && (hook.kind !== "stageDock" || ackStaging)) ack(test, hook.id);
    const result = kernel.advance(world, 1);
    events.push(...result.events);
    const broken = violations(world);
    if (broken.length > 0) throw new Error(`tick ${world.state.tick}: ${broken.join("; ")}`);
    if (result.halt.kind === "decision") throw new Error("unexpected card");
  }
  return events;
}

const stagingPending = (world: World) => world.state.narrator.pendingHook?.kind === "stageDock";

function setCourse(test: TestWorld, to: PortDefId) {
  const result = command(test, {
    source: "player",
    kind: "setCourse",
    payload: { destinationPortId: to },
  });
  expect(result.status).toBe("accepted");
}

function stage(test: TestWorld, plan: StagingPlan) {
  return command(test, { source: "narrator", kind: "stageDock", payload: plan });
}

const PLAN: StagingPlan = {
  place: [
    {
      who: { kind: "newFace", name: "Wren Okafor", role: "Courier", look: "a rain-dark coat" },
      postKey: "door",
      label: "waiting with a parcel",
    },
    { who: { kind: "seed", name: "greta test" }, postKey: "door", label: "checking a manifest" },
  ],
  props: [{ itemDefId: TINY.crate, count: 2, at: { kind: "staging" } }],
  ambience: "The shift horn sounds twice across the quay.",
};

describe("locals on the dock (D66)", () => {
  it("dresses a new game's dock with its posted regulars, who are not crew", () => {
    const { world } = stagingWorld();
    const locals = Object.values(world.state.dockside.locals);
    expect(locals.map((l) => [l.name, l.postKey, l.origin.kind])).toEqual([
      ["Hal Test", "stall", "regular"],
    ]);
    expect(Object.values(world.state.actors).some((a) => a.name === "Hal Test")).toBe(false);
    const frame = getRenderFrame(world);
    expect(frame.locals).toMatchObject([{ name: "Hal Test", role: "queue clerk", carrying: 0 }]);
    expect(frame.actors.some((a) => a.name === "Hal Test")).toBe(false);
    expect(travelViolations(world)).toEqual([]);
  });
});

describe("the staging call (D66)", () => {
  it("is raised at the lead point and the dock comes alongside with the floor set", () => {
    const test = stagingWorld();
    setCourse(test, FAR);
    run(test, 20 * 60, stagingPending);
    const { world } = test;
    const travel = world.state.travel;
    if (travel.stage !== "transit") throw new Error(`expected transit, got ${travel.stage}`);
    const lead = 0.5 * world.config.values.travel.nominalSpeed;
    expect(travel.routeDistance - travel.routeProgress).toBeLessThanOrEqual(lead);
    expect(travel.routeProgress).toBeLessThan(travel.routeDistance);
    const hook = world.state.narrator.pendingHook;
    expect(hook).toMatchObject({
      kind: "stageDock",
      context: { portId: FAR, dockId: FAR_DOCK.id },
    });
    if (hook?.kind !== "stageDock") throw new Error("no stageDock hook");
    // Greta is posted at the gate; Osric has no post, so he is not on the dock.
    expect(hook.context.floorSet.map((e) => [e.name, e.postKey])).toEqual([["Greta Test", "gate"]]);
    expect(travel.staging).toEqual({ status: "raised", hookId: hook.id });
    // Halted on it: nothing moves until it is answered.
    expect(test.kernel.advance(world, 50).ticksAdvanced).toBe(0);

    ack(test, hook.id);
    const events = run(test, 20 * 60, (w) => w.state.travel.stage === "docked");
    const dressed = events.find((e) => e.type === "dockDressed");
    expect(dressed).toMatchObject({ payload: { portId: FAR, staged: false, unplaced: [] } });
    expect(Object.values(world.state.dockside.locals).map((l) => l.name)).toEqual(["Greta Test"]);
    expect(events.some((e) => e.type === "decisionPending")).toBe(false);
  });

  it("holds at the end of the route until the call is answered, raising it that same tick", () => {
    const test = stagingWorld();
    setCourse(test, FAR);
    run(test, 20 * 60, (w) => w.state.travel.stage === "transit");
    const { world } = test;
    const travel = world.state.travel;
    if (travel.stage !== "transit") throw new Error("not in transit");
    // A save from before D66, or a leg already over its lead distance: the route is done and no
    // call has been made.
    travel.routeProgress = travel.routeDistance;
    const result = test.kernel.advance(world, 1);
    expect(result.halt).toEqual({ kind: "hook" });
    expect(world.state.narrator.pendingHook?.kind).toBe("stageDock");
    expect(world.state.travel.stage).toBe("transit");
    run(test, 20 * 30, (w) => w.state.travel.stage === "approaching", true);
    expect(world.state.travel.stage).toBe("approaching");
  });

  it("waits as due while another hook is pending, then is raised before anything else", () => {
    const test = stagingWorld(5);
    let raised = false;
    test.registry.registerSystem({
      name: "test.earlyHook",
      phase: "topology",
      run(ctx) {
        if (raised || ctx.state.travel.stage !== "transit") return;
        raised = raiseHookIfIdle(ctx, "quietTooLong", { quietSinceTick: 0 });
      },
    });
    setCourse(test, FAR);
    run(test, 20 * 60, (w) => w.state.narrator.pendingHook?.kind === "quietTooLong");
    const { world } = test;
    // The whole leg is inside the lead distance: the record opened on the first transit tick
    // and waits for the quiet hook.
    expect(world.state.travel).toMatchObject({ stage: "transit", staging: { status: "due" } });
    const quiet = world.state.narrator.pendingHook?.id;
    if (quiet === undefined) throw new Error("no quiet hook");
    ack(test, quiet);
    const result = test.kernel.advance(world, 1);
    expect(result.halt).toEqual({ kind: "hook" });
    expect(world.state.narrator.pendingHook?.kind).toBe("stageDock");
  });

  it("holds through a drift and docks once answered", () => {
    const test = stagingWorld();
    setCourse(test, FAR);
    run(test, 20 * 60, (w) => w.state.travel.stage === "transit");
    const { world } = test;
    const travel = world.state.travel;
    if (travel.stage !== "transit") throw new Error("not in transit");
    travel.routeProgress = travel.routeDistance;
    const engines = Object.values(world.state.machines).filter((m) =>
      world.content.machines[m.defId]?.tags.includes("engine"),
    );
    expect(engines.length).toBeGreaterThan(0);
    for (const engine of engines) {
      engine.desiredMode = "off";
      engine.actualMode = "off";
    }
    test.kernel.advance(world, 1);
    expect(world.state.travel).toMatchObject({ stage: "transit", drifting: true });
    const hookId = world.state.narrator.pendingHook?.id;
    if (hookId === undefined) throw new Error("no hook");
    ack(test, hookId);
    const events = run(test, 20 * 60, (w) => w.state.travel.stage === "docking");
    // The route was already run: the approach needs no engine, and the call is not asked again.
    expect(world.state.travel.stage).toBe("docking");
    expect(events.filter((e) => e.type === "narratorHookRaised")).toEqual([]);
  });

  it("survives a save and restore with the call pending, plan and all", () => {
    const test = stagingWorld();
    setCourse(test, FAR);
    run(test, 20 * 60, stagingPending);
    expect(stage(test, PLAN).status).toBe("accepted");
    const envelope = test.kernel.serialize(test.world);
    const world = test.kernel.restore(envelope, test.world.content);
    const restored: TestWorld = { ...test, world };
    expect(world.state.narrator.pendingHook?.kind).toBe("stageDock");
    expect(test.kernel.advance(world, 10).ticksAdvanced).toBe(0);
    const hookId = world.state.narrator.pendingHook?.id;
    if (hookId === undefined) throw new Error("no hook");
    ack(restored, hookId);
    run(restored, 20 * 60, (w) => w.state.travel.stage === "docking");
    const names = Object.values(world.state.dockside.locals).map((l) => l.name);
    expect(names).toContain("Wren Okafor");
    expect(names).toContain("Greta Test");
  });
});

/**
 * D69: a hookable narrative event committed in the tick a hook is raised (here the staging call)
 * keeps its `notableEvent`: it is raised once the call is answered, not dropped because the
 * check only looked one tick back. A story hook raised after the event covers it instead.
 */
describe("a notable event beside the staging call (D69)", () => {
  function notableWorld(): TestWorld {
    const base = docksideConfig({});
    const config: ConfigDef = {
      ...base,
      narrator: {
        ...base.narrator,
        approachHookLeadSeconds: 0.5,
        hookOnEvents: ["driftingChanged"],
      },
    };
    return dockWorkWorld({ dockHands: true, castSeed: SEEDS }, config);
  }

  /** Emit a hookable event (after travel, in its phase) on the first tick `when` holds. */
  function emitOnce(test: TestWorld, when: (world: World) => boolean): { tick?: number } {
    const at: { tick?: number } = {};
    test.registry.registerSystem({
      name: "test.notable",
      phase: "equipment",
      run(ctx) {
        if (at.tick !== undefined || !when(test.world)) return;
        at.tick = ctx.tick;
        ctx.emit({
          type: "driftingChanged",
          subjectIds: [],
          causeIds: [],
          source: "sim",
          payload: { drifting: false },
        });
      },
    });
    return at;
  }

  it("raises notableEvent once a staging call raised the next tick is answered", () => {
    const test = notableWorld();
    let fire = false;
    const at = emitOnce(test, () => fire);
    setCourse(test, FAR);
    run(test, 20 * 60, (w) => w.state.travel.stage === "transit");
    const { world } = test;
    fire = true;
    test.kernel.advance(world, 1);
    expect(at.tick).toBe(world.state.tick);
    // The next tick travel reaches the end of the route and raises the staging call first.
    const travel = world.state.travel;
    if (travel.stage !== "transit") throw new Error("not in transit");
    travel.routeProgress = travel.routeDistance;
    expect(test.kernel.advance(world, 1).halt).toEqual({ kind: "hook" });
    const staging = world.state.narrator.pendingHook;
    if (staging?.kind !== "stageDock") throw new Error("no staging hook");
    ack(test, staging.id);
    expect(test.kernel.advance(world, 1).halt).toEqual({ kind: "hook" });
    const hook = world.state.narrator.pendingHook;
    if (hook?.kind !== "notableEvent") throw new Error(`expected notableEvent, got ${hook?.kind}`);
    expect(hook.context.eventIds).toHaveLength(1);
    // Raised once: answering it does not raise it again.
    ack(test, hook.id);
    const events = run(test, 20 * 60, (w) => w.state.travel.stage === "docking", true);
    expect(
      events.filter((e) => e.type === "narratorHookRaised" && e.payload.kind === "notableEvent"),
    ).toEqual([]);
  });

  it("lets a story hook raised after the event cover it", () => {
    const test = notableWorld();
    const at = emitOnce(test, (w) => w.state.travel.stage === "transit");
    test.registry.registerSystem({
      name: "test.storyHook",
      phase: "topology",
      run(ctx) {
        if (at.tick !== undefined && ctx.tick === at.tick + 1) {
          raiseHookIfIdle(ctx, "quietTooLong", { quietSinceTick: 0 });
        }
      },
    });
    setCourse(test, FAR);
    const events = run(test, 20 * 60, stagingPending);
    const kinds = events
      .filter((e) => e.type === "narratorHookRaised")
      .map((e) => (e.type === "narratorHookRaised" ? e.payload.kind : ""));
    expect(kinds).toEqual(["quietTooLong", "stageDock"]);
  });
});

describe("the stageDock command (D66)", () => {
  it("places the plan's people and props with the floor set and logs the ambience", () => {
    const test = stagingWorld();
    setCourse(test, FAR);
    run(test, 20 * 60, stagingPending);
    const { world } = test;
    expect(stage(test, PLAN).status).toBe("accepted");
    const hookId = world.state.narrator.pendingHook?.id;
    if (hookId === undefined) throw new Error("no hook");
    ack(test, hookId);
    const events = run(test, 20 * 60, (w) => w.state.travel.stage === "docked");

    const locals = Object.values(world.state.dockside.locals);
    const wren = locals.find((l) => l.name === "Wren Okafor");
    const greta = locals.find((l) => l.name === "Greta Test");
    expect(wren).toMatchObject({
      role: "courier",
      look: "a rain-dark coat",
      label: "waiting with a parcel",
      postKey: "door",
      origin: { kind: "staged", source: "newFace" },
    });
    // A seed the plan places moves to the plan's post; there is still only one of her.
    expect(greta).toMatchObject({ postKey: "door", label: "checking a manifest" });
    expect(locals.filter((l) => l.name === "Greta Test")).toHaveLength(1);
    for (const local of [wren, greta]) {
      if (local === undefined) throw new Error("missing local");
      expect(Math.abs(local.location.x - (WAREHOUSE_DOOR.x + 0.5))).toBeLessThanOrEqual(3);
      expect(Math.abs(local.location.y - (WAREHOUSE_DOOR.y + 0.5))).toBeLessThanOrEqual(3);
    }
    const frame = getRenderFrame(world);
    expect(frame.dockProps).toMatchObject([{ defId: TINY.crate, count: 2 }]);
    const ambience = events.find((e) => e.type === "dockAmbience");
    if (ambience === undefined) throw new Error("no ambience line");
    expect(tickerLine(ambience, world.state, world.content)).toBe(PLAN.ambience);
    expect(world.state.dockside.ambience).toBe(PLAN.ambience);
    // Props are set dressing, never items: nobody can pick them up.
    expect(
      Object.values(world.state.items).some((i) => i.jobId === undefined && i.defId === TINY.crate),
    ).toBe(false);
  });

  it("is refused outside the call, and every other narrator command is refused during it", () => {
    const test = stagingWorld();
    expect(stage(test, PLAN)).toMatchObject({
      status: "rejected",
      rejection: { code: "preconditionFailed" },
    });
    setCourse(test, FAR);
    run(test, 20 * 60, stagingPending);
    const offer = command(test, {
      source: "narrator",
      kind: "stockMarket",
      payload: { portId: FAR, itemDefId: TINY.crate, count: 1, price: 10 },
    });
    expect(offer).toMatchObject({
      status: "rejected",
      rejection: { code: "preconditionFailed" },
    });
    expect(
      stage(test, { ...PLAN, place: [{ who: PLAN.place[0]?.who as never, postKey: "nowhere" }] }),
    ).toMatchObject({ status: "rejected", rejection: { code: "invalidPayload" } });
    const crewName = Object.values(test.world.state.actors)[0]?.name ?? "";
    expect(
      stage(test, {
        place: [{ who: { kind: "cast", name: crewName, role: "pilot" }, postKey: "gate" }],
        props: [],
      }),
    ).toMatchObject({ status: "rejected", rejection: { code: "invalidPayload" } });
    expect(
      stage(test, {
        place: [{ who: { kind: "seed", name: "Nobody Here" }, postKey: "gate" }],
        props: [],
      }),
    ).toMatchObject({ status: "rejected", rejection: { code: "invalidPayload" } });
    expect(stage(test, { place: [], props: [], ambience: "{braces}" })).toMatchObject({
      status: "rejected",
    });
    const tooMany = Array.from({ length: 4 }, (_, i) => ({
      who: { kind: "newFace" as const, name: `Face ${i}`, role: "loiterer", look: "plain" },
      postKey: "gate",
    }));
    expect(stage(test, { place: tooMany, props: [] })).toMatchObject({
      status: "rejected",
      rejection: { code: "outOfBounds" },
    });
    // One plan per call: the first is kept, a second is refused when it applies.
    expect(stage(test, PLAN).status).toBe("accepted");
    expect(stage(test, { place: [], props: [] }).status).toBe("accepted");
    const hookId = test.world.state.narrator.pendingHook?.id;
    if (hookId === undefined) throw new Error("no hook");
    ack(test, hookId);
    const events = run(test, 2, () => false);
    const rejected = events.filter((e) => e.type === "commandRejected");
    expect(rejected.map((e) => e.type === "commandRejected" && e.payload.rejection.code)).toEqual([
      "duplicate",
    ]);
    const travel = test.world.state.travel;
    expect(travel.stage === "transit" || travel.stage === "approaching").toBe(true);
    if (travel.stage === "transit" || travel.stage === "approaching") {
      expect(travel.staging).toMatchObject({ status: "raised", plan: { ambience: PLAN.ambience } });
    }
  });
});

describe("locals go with the dock (D66)", () => {
  it("are gone at the end of undocking, and departure never waits for them", () => {
    const test = stagingWorld();
    const { world } = test;
    expect(Object.keys(world.state.dockside.locals)).toHaveLength(1);
    const hal = Object.values(world.state.dockside.locals)[0];
    if (hal === undefined) throw new Error("no Hal");
    const post = dockToDeck({ shipAt: { x: 2, y: 1 } }, { x: 12, y: 11 });
    expect(Math.floor(hal.location.x)).toBe(post.x);
    setCourse(test, FAR);
    let undockingTicks = 0;
    run(test, 20 * 60, (w) => {
      if (w.state.travel.stage === "undocking") undockingTicks += 1;
      return w.state.travel.stage === "departing";
    });
    expect(world.state.deck.dock).toBeUndefined();
    expect(world.state.dockside).toEqual({ locals: {}, props: [] });
    // Undocking ran its clock: nothing about a local held it.
    expect(undockingTicks).toBeLessThanOrEqual(
      Math.ceil(world.config.values.travel.undockSeconds * 20) + 1,
    );
  });
});
