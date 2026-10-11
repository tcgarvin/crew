/**
 * §requested-call-back: the narrator's call-back request (`requestCall`, `NarratorState.callBack`)
 * and the `requestedCall` hook it raises; §notable-event-hook: travel raising `notableEvent` for an
 * aftermath event. The freight fixture's legs: prepare, undock and depart 1 s (20 ticks) each, then
 * 25 route units at 5 a second (100 ticks) from alpha to beta.
 */
import { describe, expect, it } from "vitest";
import { raiseHookIfIdle } from "../../core/hooks";
import type { Command } from "../../core/types/commands";
import type { CallBackWhen } from "../../core/types/decisions";
import type { EventDraft } from "../../core/types/events";
import type { CommandId, HookId } from "../../core/types/ids";
import type { Kernel, World } from "../../core/types/kernel";
import { type FixtureConfigOverrides, PORTS, freightTestWorld } from "./fixtures";

let counter = 0;
function cmd<C extends Omit<Command, "id">>(command: C): C & { id: CommandId } {
  counter += 1;
  return { ...command, id: `cmd:requested-call-test:${counter}` as CommandId };
}

function requestCall(kernel: Kernel, world: World, when: CallBackWhen, why = "a debris field") {
  return kernel.enqueueCommand(
    world,
    cmd({ source: "narrator", kind: "requestCall", payload: { when, why } }),
  );
}

function setCourse(kernel: Kernel, world: World, portId = PORTS.b) {
  const result = kernel.enqueueCommand(
    world,
    cmd({ source: "player", kind: "setCourse", payload: { destinationPortId: portId } }),
  );
  expect(result.status).toBe("accepted");
}

function acknowledge(kernel: Kernel, world: World): HookId {
  const hook = world.state.narrator.pendingHook;
  if (hook === undefined) throw new Error("no hook is pending");
  kernel.enqueueCommand(
    world,
    cmd({ source: "system", kind: "acknowledgeHook", payload: { hookId: hook.id } }),
  );
  return hook.id;
}

/** Acknowledge the pending hook, if any, and advance one tick. */
function step(kernel: Kernel, world: World): void {
  if (world.state.narrator.pendingHook !== undefined) acknowledge(kernel, world);
  kernel.advance(world, 1);
}

/**
 * Advance a tick at a time, acknowledging every other hook, until a `requestedCall` is pending
 * (returned) or `maxTicks` runs out (throws).
 */
function untilRequestedCall(kernel: Kernel, world: World, maxTicks = 1_000) {
  for (let i = 0; i < maxTicks; i++) {
    const hook = world.state.narrator.pendingHook;
    if (hook?.kind === "requestedCall") return hook;
    if (hook !== undefined) acknowledge(kernel, world);
    const result = kernel.advance(world, 1);
    if (result.halt.kind === "decision") throw new Error("decision halt");
  }
  throw new Error("no requestedCall was raised");
}

/** Advance, acknowledging every hook but a `requestedCall` (which fails the test), to `stage`. */
function untilStage(kernel: Kernel, world: World, stage: World["state"]["travel"]["stage"]) {
  for (let i = 0; i < 1_000; i++) {
    if (world.state.travel.stage === stage) return;
    const hook = world.state.narrator.pendingHook;
    if (hook?.kind === "requestedCall") throw new Error(`requestedCall raised before ${stage}`);
    if (hook !== undefined) acknowledge(kernel, world);
    kernel.advance(world, 1);
  }
  throw new Error(`never reached ${stage}`);
}

function inFlight(world: World) {
  const travel = world.state.travel;
  if (travel.stage === "docked") throw new Error("docked");
  return travel;
}

describe("requestCall (§requested-call-back)", () => {
  it("records the request, the port it was asked at, and no service", () => {
    const { world, kernel } = freightTestWorld();
    expect(requestCall(kernel, world, "departure", "spring a field on the pilot").status).toBe(
      "accepted",
    );
    const { events } = kernel.advance(world, 1);
    expect(world.state.narrator.callBack).toEqual({
      when: "departure",
      why: "spring a field on the pilot",
      requestedTick: 1,
      portId: PORTS.a,
    });
    expect(events.map((e) => e.type)).toContain("callBackRequested");
  });

  it("rejects an unknown when, a long why, control characters, a lost ship and the player", () => {
    const { world, kernel } = freightTestWorld();
    const code = (result: ReturnType<Kernel["enqueueCommand"]>) =>
      result.status === "rejected" ? result.rejection.code : "accepted";
    expect(code(requestCall(kernel, world, "nextWeek" as CallBackWhen))).toBe("invalidPayload");
    expect(code(requestCall(kernel, world, "midLeg", "x".repeat(201)))).toBe("invalidPayload");
    expect(code(requestCall(kernel, world, "midLeg", "x".repeat(200)))).toBe("accepted");
    expect(code(requestCall(kernel, world, "midLeg", "one\nline"))).toBe("invalidPayload");
    const player = kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "requestCall", payload: { when: "midLeg", why: "" } }),
    );
    expect(code(player)).toBe("unauthorized");
    world.state.hull.lostAtTick = 0;
    expect(code(requestCall(kernel, world, "midLeg"))).toBe("preconditionFailed");
  });

  it("replaces the whole standing request", () => {
    const { world, kernel } = freightTestWorld();
    requestCall(kernel, world, "departure", "first");
    step(kernel, world);
    requestCall(kernel, world, "nextPort", "second");
    step(kernel, world);
    expect(world.state.narrator.callBack).toEqual({
      when: "nextPort",
      why: "second",
      requestedTick: 2,
      portId: PORTS.a,
    });
  });
});

describe("the requestedCall hook (§requested-call-back)", () => {
  it("raises a departure call the tick the ship casts off, and the ack spends it", () => {
    const { world, kernel } = freightTestWorld();
    requestCall(kernel, world, "departure", "a field on the leg");
    setCourse(kernel, world);
    const hook = untilRequestedCall(kernel, world);
    expect(world.state.travel.stage).toBe("departing");
    expect(inFlight(world).stageStartedTick).toBe(world.state.tick);
    expect(hook.context).toEqual({
      when: "departure",
      why: "a field on the leg",
      requestedTick: 1,
    });
    expect(world.state.narrator.callBack?.servedByHookId).toBe(hook.id);

    acknowledge(kernel, world);
    kernel.advance(world, 1);
    expect(world.state.narrator.callBack).toBeUndefined();
    // Spent: the rest of the leg raises nothing more.
    untilStage(kernel, world, "docked");
  });

  it("serves a departure asked while departing on the first transit tick of that leg", () => {
    const { world, kernel } = freightTestWorld();
    setCourse(kernel, world);
    untilStage(kernel, world, "departing");
    requestCall(kernel, world, "departure");
    untilRequestedCall(kernel, world);
    expect(world.state.travel.stage).toBe("transit");
    expect(inFlight(world).stageStartedTick).toBe(world.state.tick);
  });

  it("serves a departure asked in transit at the next cast-off, not on this leg", () => {
    const { world, kernel } = freightTestWorld();
    setCourse(kernel, world);
    untilStage(kernel, world, "transit");
    requestCall(kernel, world, "departure");
    untilStage(kernel, world, "docked");
    expect(world.state.narrator.callBack?.servedByHookId).toBeUndefined();
    setCourse(kernel, world, PORTS.a);
    untilRequestedCall(kernel, world);
    expect(world.state.travel.stage).toBe("departing");
    expect(inFlight(world).toPortId).toBe(PORTS.a);
  });

  it("raises a midLeg call halfway through the next transit", () => {
    const { world, kernel } = freightTestWorld();
    requestCall(kernel, world, "midLeg", "a beat for the cook");
    setCourse(kernel, world);
    const hook = untilRequestedCall(kernel, world);
    const travel = inFlight(world);
    expect(travel.stage).toBe("transit");
    expect(travel.routeProgress).toBeGreaterThanOrEqual(travel.routeDistance / 2);
    expect(travel.routeProgress).toBeLessThan(travel.routeDistance);
    expect(hook.context).toMatchObject({ when: "midLeg", why: "a beat for the cook" });
  });

  it("serves a midLeg asked before this transit's halfway point on this transit", () => {
    const { world, kernel } = freightTestWorld();
    setCourse(kernel, world);
    untilStage(kernel, world, "transit");
    kernel.advance(world, 10);
    const started = inFlight(world).stageStartedTick;
    requestCall(kernel, world, "midLeg");
    kernel.advance(world, 1);
    expect(world.state.narrator.callBack?.legStartedTick).toBe(started);
    untilRequestedCall(kernel, world);
    expect(inFlight(world).stageStartedTick).toBe(started);
  });

  it("serves a midLeg asked past this transit's halfway point on the next transit", () => {
    const { world, kernel } = freightTestWorld();
    setCourse(kernel, world);
    untilStage(kernel, world, "transit");
    kernel.advance(world, 70);
    requestCall(kernel, world, "midLeg");
    kernel.advance(world, 1);
    expect(world.state.narrator.callBack?.legStartedTick).toBeUndefined();
    untilStage(kernel, world, "docked");
    setCourse(kernel, world, PORTS.a);
    untilRequestedCall(kernel, world);
    expect(inFlight(world).toPortId).toBe(PORTS.a);
  });

  it("waits while another hook is pending, then raises and settles the notable owed", () => {
    const { world, kernel, registry } = freightTestWorld({ hookOnEvents: ["driftingChanged"] });
    let blockAt = -1;
    registry.registerSystem({
      name: "blocker",
      phase: "topology",
      run: (ctx) => {
        if (ctx.tick === blockAt) raiseHookIfIdle(ctx, "quietTooLong", { quietSinceTick: 0 });
      },
    });
    requestCall(kernel, world, "departure");
    setCourse(kernel, world);
    untilStage(kernel, world, "undocking");
    // Cast-off comes 20 ticks into undocking; block it with another hook that tick.
    blockAt = inFlight(world).stageStartedTick + 20;
    while (world.state.tick < blockAt) step(kernel, world);
    expect(world.state.travel.stage).toBe("departing");
    expect(world.state.narrator.pendingHook?.kind).toBe("quietTooLong");
    expect(world.state.narrator.callBack?.servedByHookId).toBeUndefined();

    // A hookable event is owed meanwhile; the requested call, raised first, covers it.
    world.state.narrator.pendingNotable = { tick: world.state.tick, type: "driftingChanged" };
    acknowledge(kernel, world);
    kernel.advance(world, 1);
    const hook = world.state.narrator.pendingHook;
    expect(hook?.kind).toBe("requestedCall");
    expect(world.state.narrator.callBack?.servedByHookId).toBe(hook?.id);
    expect(world.state.narrator.pendingNotable).toBeUndefined();
  });

  it("keeps a request applied in the same tick as the ack of the hook it replaces", () => {
    const { world, kernel } = freightTestWorld();
    requestCall(kernel, world, "departure");
    setCourse(kernel, world);
    untilRequestedCall(kernel, world);
    // The host enqueues the plan's commands before the ack, so the new request applies first.
    requestCall(kernel, world, "nextPort", "the closing card at beta");
    acknowledge(kernel, world);
    kernel.advance(world, 1);
    expect(world.state.narrator.callBack).toEqual({
      when: "nextPort",
      why: "the closing card at beta",
      requestedTick: world.state.tick,
    });
  });

  it("serves a nextPort request with the first story hook docked elsewhere", () => {
    const { world, kernel } = freightTestWorld();
    requestCall(kernel, world, "nextPort", "the closing card");
    kernel.advance(world, 1);
    // The captainAshore asked at alpha, the port it was asked at, does not serve it.
    expect(world.state.narrator.pendingHook?.kind).toBe("captainAshore");
    expect(world.state.narrator.callBack?.servedByHookId).toBeUndefined();
    step(kernel, world);
    setCourse(kernel, world);
    untilStage(kernel, world, "transit");
    untilStage(kernel, world, "docked");
    // Docked at beta, the captain's ask (captainAshore) is the first story hook: it serves it.
    for (let i = 0; i < 100 && world.state.narrator.pendingHook === undefined; i++) {
      kernel.advance(world, 1);
    }
    const hook = world.state.narrator.pendingHook;
    expect(hook?.kind).toBe("captainAshore");
    expect(world.state.narrator.callBack?.servedByHookId).toBe(hook?.id);
    acknowledge(kernel, world);
    kernel.advance(world, 1);
    expect(world.state.narrator.callBack).toBeUndefined();
  });

  it("survives save and restore with a request standing", () => {
    const { world, kernel } = freightTestWorld();
    requestCall(kernel, world, "midLeg", "halfway");
    setCourse(kernel, world);
    untilStage(kernel, world, "transit");
    const restored = kernel.restore(kernel.serialize(world), world.content);
    expect(restored.state.narrator.callBack).toEqual(world.state.narrator.callBack);
    const original = untilRequestedCall(kernel, world);
    const copy = untilRequestedCall(kernel, restored);
    expect(copy).toEqual(original);
    expect(restored.state).toStrictEqual(world.state);
  });
});

/** A narrator card with nothing on either side, for the `afterCard` moment. */
function surfaceCard(kernel: Kernel, world: World, followUp = false) {
  const side = (prose: string) => ({
    label: { key: "narrator.side", params: {}, prose },
    commands: [],
  });
  const card = (title: string) => ({
    prompt: { key: "narrator.situation", params: { title }, prose: `${title}.` },
    left: side(`${title} yes`),
    right: side(`${title} no`),
  });
  const main = card("Main");
  const result = kernel.enqueueCommand(
    world,
    cmd({
      source: "narrator",
      kind: "surfaceDecision",
      payload: { card: followUp ? { ...main, left: { ...main.left, next: card("After") } } : main },
    }),
  );
  expect(result.status).toBe("accepted");
}

/** Advance, acknowledging every hook, until the world halts on the card. */
function untilCardUp(kernel: Kernel, world: World) {
  for (let i = 0; i < 100; i++) {
    if (world.state.narrator.pendingHook !== undefined) acknowledge(kernel, world);
    const result = kernel.advance(world, 1);
    if (result.halt.kind === "decision") return;
  }
  throw new Error("no card came up");
}

function answerHead(kernel: Kernel, world: World, side: "left" | "right" = "left") {
  const decisionId = world.state.decisions.queue[0];
  if (decisionId === undefined) throw new Error("no card is up");
  const result = kernel.enqueueCommand(
    world,
    cmd({ source: "player", kind: "resolveDecision", payload: { decisionId, side } }),
  );
  expect(result.status).toBe("accepted");
  kernel.advance(world, 1);
}

describe("the arrival, afterCard and holdQuiet call-backs (§requested-call-back)", () => {
  it("raises an arrival call at the approach lead point of the next leg", () => {
    const { world, kernel } = freightTestWorld();
    requestCall(kernel, world, "arrival", "a face on the dock");
    setCourse(kernel, world);
    const hook = untilRequestedCall(kernel, world);
    const travel = inFlight(world);
    expect(travel.stage).toBe("transit");
    const config = world.config.values;
    const lead = config.narrator.approachHookLeadSeconds * config.travel.nominalSpeed;
    expect(travel.routeDistance - travel.routeProgress).toBeLessThanOrEqual(lead);
    expect(travel.routeDistance - travel.routeProgress).toBeGreaterThan(lead - 1);
    expect(hook.context).toMatchObject({ when: "arrival", why: "a face on the dock" });
  });

  it("serves an arrival asked past this leg's lead point on the next leg's", () => {
    const { world, kernel } = freightTestWorld();
    setCourse(kernel, world);
    untilStage(kernel, world, "approaching");
    requestCall(kernel, world, "arrival");
    kernel.advance(world, 1);
    expect(world.state.narrator.callBack?.afterDocking).toBe(true);
    untilStage(kernel, world, "docked");
    kernel.advance(world, 1);
    expect(world.state.narrator.callBack?.afterDocking).toBeUndefined();
    setCourse(kernel, world, PORTS.a);
    untilRequestedCall(kernel, world);
    expect(inFlight(world).toPortId).toBe(PORTS.a);
  });

  it("raises an afterCard call the tick after the next card is answered", () => {
    const { world, kernel } = freightTestWorld();
    requestCall(kernel, world, "afterCard", "see how they took it");
    surfaceCard(kernel, world);
    untilCardUp(kernel, world);
    expect(world.state.narrator.callBack?.cardResolvedTick).toBeUndefined();
    answerHead(kernel, world);
    const resolvedTick = world.state.narrator.callBack?.cardResolvedTick;
    expect(resolvedTick).toBeDefined();
    const hook = untilRequestedCall(kernel, world);
    expect(hook.tick).toBe((resolvedTick ?? 0) + 1);
    expect(hook.context).toMatchObject({ when: "afterCard", why: "see how they took it" });
    expect(world.state.travel.stage).toBe("docked");
  });

  it("waits for a follow-up card to be answered before the afterCard call", () => {
    const { world, kernel } = freightTestWorld();
    requestCall(kernel, world, "afterCard");
    surfaceCard(kernel, world, true);
    untilCardUp(kernel, world);
    answerHead(kernel, world, "left");
    expect(world.state.narrator.callBack?.cardResolvedTick).toBeUndefined();
    expect(world.state.decisions.queue).toHaveLength(1);
    answerHead(kernel, world, "left");
    expect(world.state.narrator.callBack?.cardResolvedTick).toBeDefined();
    untilRequestedCall(kernel, world);
  });

  it("doubles the quiet window while a holdQuiet request stands", () => {
    const quietTicks = 10 * 20;
    const quietAt = (holdQuiet: boolean) => {
      const { world, kernel } = freightTestWorld({ quietTooLongSeconds: 10 });
      kernel.enqueueCommand(
        world,
        cmd({
          source: "narrator",
          kind: "requestCall",
          payload: { when: "nextPort", why: "", holdQuiet },
        }),
      );
      for (let i = 0; i < 1_000; i++) {
        const hook = world.state.narrator.pendingHook;
        if (hook?.kind === "quietTooLong") return hook.tick;
        if (hook !== undefined) acknowledge(kernel, world);
        kernel.advance(world, 1);
      }
      throw new Error("no quiet check-in");
    };
    const plain = quietAt(false);
    const held = quietAt(true);
    expect(plain).toBeLessThanOrEqual(quietTicks + 2);
    expect(held - plain).toBeGreaterThanOrEqual(quietTicks - 2);
  });

  it("rejects a holdQuiet that is not true or false", () => {
    const { world, kernel } = freightTestWorld();
    const result = kernel.enqueueCommand(
      world,
      cmd({
        source: "narrator",
        kind: "requestCall",
        payload: { when: "nextPort", why: "", holdQuiet: "yes" as unknown as boolean },
      }),
    );
    expect(result.status).toBe("rejected");
  });
});

describe("aftermath events raise notableEvent from travel (§notable-event-hook)", () => {
  it("raises notableEvent the tick after a listed aftermath event of notable significance", () => {
    const overrides: FixtureConfigOverrides = { aftermathHookOnEvents: ["alertCleared"] };
    const { world, kernel, registry } = freightTestWorld(overrides);
    const alertCleared: EventDraft = {
      type: "alertCleared",
      subjectIds: [],
      causeIds: [],
      source: "sim",
      payload: { cause: "field" },
    };
    registry.registerSystem({
      name: "standDown",
      phase: "topology",
      run: (ctx) => {
        if (ctx.tick === 5) ctx.emit(alertCleared);
      },
    });
    // The captainAshore at alpha first.
    kernel.advance(world, 1);
    step(kernel, world);
    const result = kernel.advance(world, 10);
    expect(result).toMatchObject({ ticksAdvanced: 4, halt: { kind: "hook" } });
    expect(world.state.tick).toBe(6);
    const hook = world.state.narrator.pendingHook;
    expect(hook?.kind).toBe("notableEvent");
    const event = result.events.find((e) => e.type === "alertCleared");
    expect(hook?.context).toEqual({ eventIds: [event?.id] });
  });
});
