/**
 * Passages (passengers-and-galaxy §3, §4.2, §9): offer validation (bands, luggage, round trip),
 * boarding, ashore/return, the overdue card both ways, `endPassage` docked and in transit, one
 * payment, one-way completion. On the travel/commerce fixture there is no spatial system, so
 * the passenger steps off the deck the moment the ship docks (the walk cannot be planned).
 */
import { describe, expect, it } from "vitest";
import { cmd } from "../../core/fixtures/test-world";
import { createKernel } from "../../core/kernel";
import { createRegistry } from "../../core/registry";
import type { Command } from "../../core/types/commands";
import type { ContentBundle } from "../../core/types/content";
import type { NarratorHook } from "../../core/types/decisions";
import type { SimEvent } from "../../core/types/events";
import type { ActorId, DecisionId, JobId, MachineDefId, PortDefId } from "../../core/types/ids";
import type { Kernel, World } from "../../core/types/kernel";
import type { DeckGeometry } from "../../core/types/nav";
import type { Item } from "../../core/types/ship";
import { registerPlannerDefaults } from "../../planner/index";
import { registerSpatial } from "../spatial/index";
import { registerTravel } from "../travel";
import {
  FIX,
  FIXTURE_DAY,
  type FixtureConfigOverrides,
  type FixtureWorld,
  PORTS,
  fixtureConfig,
  fixtureContent,
  fixtureEffectiveConfig,
  freightTestWorld,
} from "../travel/fixtures";
import { travelTaskDerivations } from "../travel/tasks";
import { registerWatch } from "../watch/index";
import { registerWork } from "../work/index";
import { commerceTaskDerivations, registerCommerce } from "./index";
import { PASSENGER_OVERDUE_PROMPT_KEY } from "./passage";

const TICK_RATE = 20;

interface PassageOptions {
  roundTrip?: boolean;
  luggage?: number;
  /** Defaults to `PORTS.b` (one hop); `PORTS.d` is two hops away for voyage cases. */
  toPortId?: PortDefId;
}

function passageDraft(pay: number, options: PassageOptions = {}) {
  return {
    issuer: { name: "Halla Thorne", role: "assayer" },
    description: { key: "test.passage", params: {} },
    fromPortId: PORTS.a,
    toPortId: options.toPortId ?? PORTS.b,
    cargo: options.luggage === undefined ? [] : [{ itemDefId: FIX.crate, count: options.luggage }],
    pay,
    passenger: true,
    roundTrip: options.roundTrip ?? false,
  };
}

/**
 * Advance one tick at a time, collecting events and acknowledging hooks, until `until` holds, a
 * decision halts the world, or `maxTicks` is spent.
 */
function runUntil(
  kernel: Kernel,
  world: World,
  maxTicks: number,
  until: (world: World) => boolean = () => false,
): { events: SimEvent[]; hooks: NarratorHook[]; halted: "decision" | "ticks" | "until" } {
  const events: SimEvent[] = [];
  const hooks: NarratorHook[] = [];
  for (let i = 0; i < maxTicks; i++) {
    const result = kernel.advance(world, 1);
    events.push(...result.events);
    if (result.halt.kind === "hook") {
      const hook = world.state.narrator.pendingHook;
      if (hook === undefined) throw new Error("hook halt without a pending hook");
      hooks.push(hook);
      kernel.enqueueCommand(
        world,
        cmd({ source: "system", kind: "acknowledgeHook", payload: { hookId: hook.id } }),
      );
    } else if (result.halt.kind === "decision") {
      return { events, hooks, halted: "decision" };
    }
    if (until(world)) return { events, hooks, halted: "until" };
  }
  return { events, hooks, halted: "ticks" };
}

function headDecision(world: World) {
  const id = world.state.decisions.queue[0];
  if (id === undefined) throw new Error("no decision queued");
  const decision = world.state.decisions.records[id];
  if (decision === undefined) throw new Error("decision vanished");
  return decision;
}

function resolve(kernel: Kernel, world: World, decisionId: DecisionId, side: "left" | "right") {
  const result = kernel.enqueueCommand(
    world,
    cmd({ source: "player", kind: "resolveDecision", payload: { decisionId, side } }),
  );
  expect(result.status).toBe("accepted");
}

function theJob(world: World) {
  const job = Object.values(world.state.jobs)[0];
  if (job === undefined) throw new Error("no job");
  return job;
}

/** Fake the crew: every open cargo problem of the job is done and its items are `where`. */
function fakeCargoWork(world: World, where: "aboard" | "ashore"): void {
  const job = theJob(world);
  for (const problem of Object.values(world.state.work.problems)) {
    if (problem.kind === "cargoToLoad" || problem.kind === "cargoToUnload") {
      if (problem.payload.jobId === job.id) problem.status = "resolved";
    }
  }
  for (const itemId of job.cargoItemIds) {
    const item = world.state.items[itemId] as Item;
    item.location =
      where === "aboard"
        ? { kind: "onDeck", deckId: FIX.deck, x: 1.5, y: 2.5 }
        : { kind: "inExternalStore", portId: PORTS.b, storeKey: "warehouse" };
  }
}

/** Offer a surfaced passage at A and take it (accept + course for B). */
function offerAndAccept(
  pay: number,
  options: PassageOptions = {},
  overrides: FixtureConfigOverrides = {},
  fixture: FixtureWorld = freightTestWorld(overrides),
) {
  const { world, kernel } = fixture;
  const offer = kernel.enqueueCommand(
    world,
    cmd({
      source: "narrator",
      kind: "offerJob",
      payload: { job: passageDraft(pay, options), surface: true },
    }),
  );
  expect(offer.status).toBe("accepted");
  const first = runUntil(kernel, world, 5);
  expect(first.halted).toBe("decision");
  resolve(kernel, world, headDecision(world).id, "left");
  // With no luggage there is no cargo work, so the course begins departure the same tick.
  const accepted = runUntil(kernel, world, 3, (w) => passengerOf(w).actor !== undefined);
  expect(accepted.halted).toBe("until");
  return { world, kernel, events: [...first.events, ...accepted.events] };
}

function passengerOf(world: World) {
  const passage = theJob(world).passage;
  if (passage === undefined) throw new Error("job has no passage");
  return { passage, actor: world.state.actors[passage.actorId] };
}

const ofType = (events: readonly SimEvent[], type: SimEvent["type"]) =>
  events.filter((e) => e.type === type);

describe("passage offers: bands and shape", () => {
  function offer(draft: ReturnType<typeof passageDraft>) {
    const { world, kernel } = freightTestWorld();
    return kernel.enqueueCommand(
      world,
      cmd({ source: "narrator", kind: "offerJob", payload: { job: draft, surface: false } }),
    );
  }

  it("bands a fare by the passenger band over path distance, doubled for a round trip", () => {
    // a -> b is 25; passenger band [2, 4] => one way [50, 100], round trip [100, 200].
    expect(offer(passageDraft(50)).status).toBe("accepted");
    expect(offer(passageDraft(100)).status).toBe("accepted");
    expect(offer(passageDraft(49))).toMatchObject({
      status: "rejected",
      rejection: { code: "outOfBounds", reason: expect.stringContaining("[50, 100]") },
    });
    expect(offer(passageDraft(101)).status).toBe("rejected");
    expect(offer(passageDraft(200, { roundTrip: true })).status).toBe("accepted");
    expect(offer(passageDraft(201, { roundTrip: true }))).toMatchObject({
      status: "rejected",
      rejection: { reason: expect.stringContaining("[100, 200]") },
    });
    // Two hops a -> c -> d (95): [190, 380]; luggage adds nothing to the band.
    expect(offer({ ...passageDraft(190, { luggage: 1 }), toPortId: PORTS.d }).status).toBe(
      "accepted",
    );
    expect(offer({ ...passageDraft(381), toPortId: PORTS.d }).status).toBe("rejected");
  });

  it("rejects roundTrip without passenger, with a reason", () => {
    const result = offer({ ...passageDraft(60), passenger: false, roundTrip: true, cargo: [] });
    expect(result).toMatchObject({
      status: "rejected",
      rejection: { code: "invalidPayload", reason: expect.stringContaining("roundTrip") },
    });
  });

  it("limits luggage to one line of one unit", () => {
    const twoLines = offer({
      ...passageDraft(60),
      cargo: [
        { itemDefId: FIX.crate, count: 1 },
        { itemDefId: FIX.parts, count: 1 },
      ],
    });
    expect(twoLines).toMatchObject({
      status: "rejected",
      rejection: { code: "invalidPayload", reason: expect.stringContaining("luggage") },
    });
    const { world } = offerAndAccept(60, { luggage: 3 });
    const job = theJob(world);
    expect(job.cargo).toEqual([{ itemDefId: FIX.crate, count: 1 }]);
    expect(job.cargoItemIds).toHaveLength(1);
    expect(job.pay).toBe(60);
  });
});

describe("passage lifecycle", () => {
  it("accepting spawns the passenger at the ramp with the issuer's name, and the luggage as freight", () => {
    const { world, events } = offerAndAccept(60, { luggage: 1 });
    const job = theJob(world);
    expect(job.passage).toMatchObject({ roundTrip: false, leg: "out" });
    const { actor } = passengerOf(world);
    expect(actor).toBeDefined();
    expect(actor?.name).toBe("Halla Thorne");
    expect(actor?.defId).toBe(FIX.passenger);
    expect(actor?.passenger).toBe(true);
    expect(actor?.crew).toBe(true);
    expect(actor?.location).toEqual({ kind: "onDeck", deckId: FIX.deck, x: 0.5, y: 1.5 });
    expect(ofType(events, "passengerBoarded")).toHaveLength(1);
    expect(ofType(events, "passengerBoarded")[0]?.payload).toEqual({
      jobId: job.id,
      actorId: actor?.id,
      name: "Halla Thorne",
    });
    const luggage = world.state.items[job.cargoItemIds[0] as never] as Item;
    expect(luggage.location).toEqual({
      kind: "inExternalStore",
      portId: PORTS.a,
      storeKey: "warehouse",
    });
    expect(
      Object.values(world.state.work.problems).filter(
        (p) => p.kind === "cargoToLoad" && p.status === "open",
      ),
    ).toHaveLength(1);
  });

  it("one-way: the passenger leaves at the destination, the passage completes and pays once", () => {
    const { world, kernel } = offerAndAccept(60, {}, { dockingFee: 3 });
    const start = world.state.money.balance;
    const { actor } = passengerOf(world);
    const actorId = actor?.id as ActorId;
    const arrived = runUntil(
      kernel,
      world,
      2000,
      (w) => w.state.travel.stage === "docked" && w.state.travel.portId === PORTS.b,
    );
    expect(arrived.halted).toBe("until");
    // Walking off is instant here (no nav); the same tick ends and pays the passage.
    const after = runUntil(kernel, world, 2, (w) => theJob(w).status === "paid");
    const events = [...arrived.events, ...after.events];
    const job = theJob(world);
    expect(job.status).toBe("paid");
    expect(job.passage?.endReason).toBe("completed");
    expect(world.state.actors[actorId]).toBeUndefined();
    expect(ofType(events, "passageEnded").map((e) => e.payload)).toEqual([
      { jobId: job.id, actorId, name: "Halla Thorne", reason: "completed", portId: PORTS.b },
    ]);
    expect(ofType(events, "contractCompleted")).toHaveLength(1);
    expect(ofType(events, "paymentMade")).toHaveLength(1);
    expect(world.state.money.balance).toBe(start - 3 + 60);
    runUntil(kernel, world, 100);
    expect(world.state.money.balance).toBe(start - 3 + 60);
    expect(
      Object.values(world.state.money.transactions).filter((t) => t.jobId === job.id),
    ).toHaveLength(1);
  });

  it("round trip: ashore at the destination, home planned, departure waits, back at returnsAtTick, paid once at home", () => {
    const { world, kernel } = offerAndAccept(150, { roundTrip: true, luggage: 1 });
    fakeCargoWork(world, "aboard");
    const start = world.state.money.balance;
    const actorId = passengerOf(world).actor?.id as ActorId;
    const arrived = runUntil(
      kernel,
      world,
      2000,
      (w) => w.state.travel.stage === "docked" && w.state.travel.portId === PORTS.b,
    );
    expect(arrived.halted).toBe("until");
    const { passage, actor } = passengerOf(world);
    expect(passage.leg).toBe("ashore");
    expect(actor?.availability).toBe("offShip");
    expect(actor?.location).toEqual({
      kind: "inExternalStore",
      portId: PORTS.b,
      storeKey: "lounge",
    });
    // Fixture: ashore for exactly 3 s.
    expect(passage.returnsAtTick).toBe(world.state.tick + 3 * TICK_RATE);
    expect(passage.ashoreSinceTick).toBe(world.state.tick);
    expect(ofType(arrived.events, "passengerAshore")).toHaveLength(1);
    expect(world.state.travel).toMatchObject({
      stage: "docked",
      portId: PORTS.b,
      plannedDestinationId: PORTS.a,
    });
    fakeCargoWork(world, "ashore");
    // Luggage is ashore and the course is set, yet the ship waits for the passenger.
    const waiting = runUntil(kernel, world, 2 * TICK_RATE);
    expect(waiting.halted).toBe("ticks");
    expect(world.state.travel.stage).toBe("docked");
    expect(theJob(world).status).toBe("inTransit");
    const back = runUntil(
      kernel,
      world,
      2 * TICK_RATE,
      (w) => passengerOf(w).passage.leg === "back",
    );
    expect(back.halted).toBe("until");
    expect(ofType(back.events, "passengerReturned")[0]?.payload).toEqual({
      jobId: theJob(world).id,
      actorId,
      name: "Halla Thorne",
    });
    expect(actor?.availability).toBe("available");
    expect(actor?.location).toMatchObject({ kind: "onDeck", deckId: FIX.deck });
    const home = runUntil(kernel, world, 2000, (w) => theJob(w).status === "paid");
    expect(home.halted).toBe("until");
    expect(world.state.travel).toMatchObject({ stage: "docked", portId: PORTS.a });
    expect(theJob(world).passage?.endReason).toBe("completed");
    expect(world.state.actors[actorId]).toBeUndefined();
    expect(ofType(home.events, "passageEnded")[0]?.payload).toMatchObject({
      reason: "completed",
      portId: PORTS.a,
    });
    expect(world.state.money.balance).toBe(start + 150);
    runUntil(kernel, world, 50);
    expect(ofType(home.events, "paymentMade")).toHaveLength(1);
    expect(world.state.money.balance).toBe(start + 150);
  });

  function lateReturn() {
    // Ashore 20 s, overdue after 5 s: the card comes long before they are back.
    const run = offerAndAccept(
      150,
      { roundTrip: true },
      {
        passage: {
          ashoreDaysMin: 20 / FIXTURE_DAY,
          ashoreDaysMax: 20 / FIXTURE_DAY,
          overdueDays: 5 / FIXTURE_DAY,
        },
      },
    );
    const { world, kernel } = run;
    const arrived = runUntil(
      kernel,
      world,
      2000,
      (w) => w.state.travel.stage === "docked" && w.state.travel.portId === PORTS.b,
    );
    expect(arrived.halted).toBe("until");
    const ashoreTick = world.state.tick;
    const card = runUntil(kernel, world, 20 * TICK_RATE);
    expect(card.halted).toBe("decision");
    expect(world.state.tick).toBe(ashoreTick + 5 * TICK_RATE);
    const decision = headDecision(world);
    expect(decision.origin).toBe("policy");
    expect(decision.prompt.key).toBe(PASSENGER_OVERDUE_PROMPT_KEY);
    expect(decision.prompt.params).toMatchObject({
      name: "Halla Thorne",
      speaker: "First Officer Kade",
      port: PORTS.b,
    });
    expect(decision.narratorHookId).toBeDefined();
    expect(decision.left.commands).toEqual([]);
    expect(decision.right.commands).toEqual([
      { kind: "endPassage", payload: { jobId: theJob(world).id } },
    ]);
    expect(ofType(card.events, "policyDecisionNeeded")).toHaveLength(1);
    return { ...run, decision, events: card.events };
  }

  it("overdue: 'Wait for them' keeps waiting and the passenger still comes back", () => {
    const { world, kernel, decision } = lateReturn();
    const actorId = passengerOf(world).actor?.id as ActorId;
    resolve(kernel, world, decision.id, "left");
    const back = runUntil(
      kernel,
      world,
      30 * TICK_RATE,
      (w) => passengerOf(w).passage.leg === "back",
    );
    expect(back.halted).toBe("until");
    expect(world.state.travel).toMatchObject({ stage: "docked", portId: PORTS.b });
    // Asked once: no second card while still waiting.
    expect(
      Object.values(world.state.decisions.records).filter(
        (d) => d.prompt.key === PASSENGER_OVERDUE_PROMPT_KEY,
      ),
    ).toHaveLength(1);
    const home = runUntil(kernel, world, 2000, (w) => theJob(w).status === "paid");
    expect(home.halted).toBe("until");
    expect(world.state.actors[actorId]).toBeUndefined();
  });

  it("overdue: 'Leave without them' ends the passage leftBehind, no fare, passenger stays ashore", () => {
    const { world, kernel, decision } = lateReturn();
    const start = world.state.money.balance;
    const actorId = passengerOf(world).actor?.id as ActorId;
    resolve(kernel, world, decision.id, "right");
    const left = runUntil(kernel, world, 2000, (w) => w.state.travel.stage === "transit");
    expect(left.halted).toBe("until");
    const job = theJob(world);
    expect(job.status).toBe("failed");
    expect(job.passage).toMatchObject({ leg: "ashore", endReason: "leftBehind" });
    expect(job.passage?.returnsAtTick).toBeUndefined();
    expect(ofType(left.events, "passageEnded")[0]?.payload).toEqual({
      jobId: job.id,
      actorId,
      name: "Halla Thorne",
      reason: "leftBehind",
      portId: PORTS.b,
    });
    const actor = world.state.actors[actorId];
    expect(actor?.availability).toBe("offShip");
    expect(actor?.location).toEqual({
      kind: "inExternalStore",
      portId: PORTS.b,
      storeKey: "lounge",
    });
    const home = runUntil(kernel, world, 2000, (w) => w.state.travel.stage === "docked");
    expect(home.halted).toBe("until");
    expect(world.state.travel).toMatchObject({ stage: "docked", portId: PORTS.a });
    expect(world.state.money.balance).toBe(start);
    expect(ofType([...left.events, ...home.events], "paymentMade")).toHaveLength(0);
    expect(world.state.actors[actorId]?.location).toMatchObject({ portId: PORTS.b });
  });

  it("endPassage while docked puts the passenger off here, no fare", () => {
    const { world, kernel } = offerAndAccept(60, { luggage: 1 });
    const job = theJob(world);
    const actorId = passengerOf(world).actor?.id as ActorId;
    expect(world.state.travel).toMatchObject({ stage: "docked", portId: PORTS.a });
    const result = kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "endPassage", payload: { jobId: job.id } }),
    );
    expect(result.status).toBe("accepted");
    const { events } = runUntil(
      kernel,
      world,
      3,
      (w) => w.state.actors[actorId]?.availability === "offShip",
    );
    expect(job.status).toBe("failed");
    expect(job.passage).toMatchObject({ leg: "out", endReason: "putOff" });
    expect(ofType(events, "passageEnded")[0]?.payload).toMatchObject({
      reason: "putOff",
      portId: PORTS.a,
    });
    const actor = world.state.actors[actorId];
    expect(actor?.location).toEqual({
      kind: "inExternalStore",
      portId: PORTS.a,
      storeKey: "lounge",
    });
    // Luggage work is dropped, so nothing holds the ship for it.
    expect(
      Object.values(world.state.work.problems).filter(
        (p) => p.kind === "cargoToLoad" && p.status === "open",
      ),
    ).toHaveLength(0);
    const again = kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "endPassage", payload: { jobId: job.id } }),
    );
    expect(again).toMatchObject({ status: "rejected", rejection: { code: "preconditionFailed" } });
  });

  it("endPassage in transit: the passenger leaves at the next docking", () => {
    const { world, kernel } = offerAndAccept(60);
    const job = theJob(world);
    const actorId = passengerOf(world).actor?.id as ActorId;
    const out = runUntil(kernel, world, 2000, (w) => w.state.travel.stage === "transit");
    expect(out.halted).toBe("until");
    kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "endPassage", payload: { jobId: job.id } }),
    );
    const ended = runUntil(kernel, world, 3, (w) => theJob(w).status === "failed");
    expect(ended.halted).toBe("until");
    expect(ofType(ended.events, "passageEnded")[0]?.payload).toMatchObject({
      reason: "putOff",
      portId: PORTS.b,
    });
    // Still aboard until the ship docks.
    expect(world.state.actors[actorId]?.location).toMatchObject({ kind: "onDeck" });
    const docked = runUntil(
      kernel,
      world,
      2000,
      (w) => w.state.actors[actorId]?.availability === "offShip",
    );
    expect(docked.halted).toBe("until");
    expect(world.state.travel).toMatchObject({ stage: "docked", portId: PORTS.b });
    expect(world.state.actors[actorId]?.location).toEqual({
      kind: "inExternalStore",
      portId: PORTS.b,
      storeKey: "lounge",
    });
    runUntil(kernel, world, 50);
    expect(theJob(world).paymentTransactionId).toBeUndefined();
  });

  it("endPassage rejects a job with no passenger", () => {
    const { world, kernel } = freightTestWorld();
    kernel.enqueueCommand(
      world,
      cmd({
        source: "scenario",
        kind: "offerJob",
        payload: {
          job: { ...passageDraft(60, { luggage: 2 }), passenger: false, roundTrip: false },
          surface: false,
        },
      }),
    );
    runUntil(kernel, world, 1);
    const result = kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "endPassage", payload: { jobId: theJob(world).id } }),
    );
    expect(result).toMatchObject({ status: "rejected", rejection: { code: "preconditionFailed" } });
  });

  it("a passage job survives a save round trip", () => {
    const { world, kernel } = offerAndAccept(150, { roundTrip: true });
    const snapshot = kernel.serialize(world);
    const copy = JSON.parse(JSON.stringify(snapshot));
    expect(copy.state.jobs[theJob(world).id as JobId].passage).toEqual(theJob(world).passage);
  });
});

// ---------------------------------------------------------------------------------------------
// Review fixes (2026-10-02): the board at the far port, one job at a time, endPassage and the
// course, the overdue card and the return, reservations, luggage.
// ---------------------------------------------------------------------------------------------

/**
 * A nav cache makes the walk to the ramp real (`cannotWalk` is false) while nothing in this
 * registry carries the walk out, so a passenger placed off the ramp stays mid-deck for as long
 * as the test wants: the window between docking and stepping off.
 */
function giveTheDeckANavCache(world: World): void {
  // A door table, because travel syncs ramp passability through it (Dockside spike).
  world.caches.nav.decks[FIX.deck] = { doors: new Map() } as unknown as DeckGeometry;
}

function placeOnDeck(world: World, actorId: ActorId, x: number, y: number) {
  const actor = world.state.actors[actorId];
  if (actor === undefined) throw new Error("no actor");
  actor.movement = { kind: "stationary" };
  actor.location = { kind: "onDeck", deckId: FIX.deck, x, y };
  return actor;
}

function freightDraft(fromPortId: PortDefId = PORTS.a, toPortId: PortDefId = PORTS.b) {
  return {
    issuer: { name: "Dock Foreman", role: "foreman" },
    description: { key: "test.freight", params: {} },
    fromPortId,
    toPortId,
    cargo: [{ itemDefId: FIX.crate, count: 2 }],
    pay: 60,
    passenger: false,
    roundTrip: false,
  };
}

function send(kernel: Kernel, world: World, command: Omit<Command, "id">) {
  return kernel.enqueueCommand(world, cmd(command) as Command);
}

function offeredJob(world: World) {
  const job = Object.values(world.state.jobs).find((j) => j.status === "offered");
  if (job === undefined) throw new Error("no offered job");
  return job;
}

const captainAshorePorts = (hooks: readonly NarratorHook[]) =>
  hooks.filter((h) => h.kind === "captainAshore").map((h) => h.context.portId);

const openProblems = (world: World, kind: "cargoToUnload" | "cargoToLoad") =>
  Object.values(world.state.work.problems).filter((p) => p.kind === kind && p.status === "open");

describe("the board at the far port of a round trip", () => {
  it("plans the voyage home on the arrival tick, before the passenger reaches the ramp, and never asks captainAshore there", () => {
    const { world, kernel } = offerAndAccept(150, { roundTrip: true });
    const actorId = passengerOf(world).actor?.id as ActorId;
    giveTheDeckANavCache(world);
    const out = runUntil(kernel, world, 2000, (w) => w.state.travel.stage === "transit");
    expect(out.halted).toBe("until");
    const actor = placeOnDeck(world, actorId, 3.5, 2.5);
    const arrived = runUntil(
      kernel,
      world,
      2000,
      (w) => w.state.travel.stage === "docked" && w.state.travel.portId === PORTS.b,
    );
    expect(arrived.halted).toBe("until");
    // Same tick as docking: course home set, passenger still aboard and walking.
    expect(world.state.travel).toMatchObject({
      stage: "docked",
      portId: PORTS.b,
      plannedDestinationId: PORTS.a,
    });
    expect(actor.disembarking).toBe(true);
    expect(actor.location).toMatchObject({ kind: "onDeck" });
    expect(passengerOf(world).passage.leg).toBe("out");
    const walking = runUntil(kernel, world, 3 * TICK_RATE);
    expect(walking.halted).toBe("ticks");
    expect(captainAshorePorts([...arrived.hooks, ...walking.hooks])).toEqual([]);
    expect(world.state.travel.stage).toBe("docked");
    // At the ramp at last: ashore, and the course planned at arrival is the one home.
    placeOnDeck(world, actorId, 0.5, 1.5);
    const ashore = runUntil(kernel, world, 3, (w) => passengerOf(w).passage.leg === "ashore");
    expect(ashore.halted).toBe("until");
    expect(captainAshorePorts(ashore.hooks)).toEqual([]);
    expect(world.state.travel).toMatchObject({ stage: "docked", plannedDestinationId: PORTS.a });
  });

  it("does not ask captainAshore while a passenger is ashore, even with the walk instant", () => {
    const { world, kernel } = offerAndAccept(150, { roundTrip: true });
    const arrived = runUntil(kernel, world, 2000, (w) => passengerOf(w).passage.leg === "ashore");
    expect(arrived.halted).toBe("until");
    const waiting = runUntil(kernel, world, 2 * TICK_RATE);
    expect(captainAshorePorts([...arrived.hooks, ...waiting.hooks])).toEqual([]);
  });

  it("treats a passage in any live status as the job in hand, course or no course", () => {
    const { world, kernel } = offerAndAccept(150, { roundTrip: true });
    const arrived = runUntil(kernel, world, 2000, (w) => passengerOf(w).passage.leg === "ashore");
    expect(arrived.halted).toBe("until");
    expect(theJob(world).status).toBe("inTransit");
    // No course at all (an older save, or a home port that cannot be routed to): the passenger
    // ashore is still the job in hand, so the board stays quiet on that alone.
    const travel = world.state.travel;
    if (travel.stage !== "docked") throw new Error("expected docked");
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete travel.plannedDestinationId;
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete travel.voyageDestinationId;
    const waiting = runUntil(
      kernel,
      world,
      2 * TICK_RATE,
      (w) => passengerOf(w).passage.leg === "back",
    );
    expect(captainAshorePorts(waiting.hooks)).toEqual([]);
  });
});

describe("one job at a time (§one-job-in-hand, D50)", () => {
  it("acceptContract refuses a second job while a passage is in hand; the offer itself can wait", () => {
    const { world, kernel } = offerAndAccept(60, { luggage: 1 });
    expect(
      send(kernel, world, {
        source: "narrator",
        kind: "offerJob",
        payload: { job: freightDraft(), surface: false },
      }).status,
    ).toBe("accepted");
    runUntil(kernel, world, 1);
    const second = offeredJob(world);
    const accept = send(kernel, world, {
      source: "player",
      kind: "acceptContract",
      payload: { jobId: second.id },
    });
    expect(accept).toMatchObject({
      status: "rejected",
      rejection: {
        code: "preconditionFailed",
        reason: expect.stringContaining("a job is already in hand"),
      },
    });
    expect(second.status).toBe("offered");
  });

  it("acceptContract refuses a job at the far port while the passenger is ashore", () => {
    const { world, kernel } = offerAndAccept(150, { roundTrip: true });
    const arrived = runUntil(kernel, world, 2000, (w) => passengerOf(w).passage.leg === "ashore");
    expect(arrived.halted).toBe("until");
    send(kernel, world, {
      source: "narrator",
      kind: "offerJob",
      payload: { job: freightDraft(PORTS.b, PORTS.a), surface: false },
    });
    runUntil(kernel, world, 1);
    const accept = send(kernel, world, {
      source: "player",
      kind: "acceptContract",
      payload: { jobId: offeredJob(world).id },
    });
    expect(accept).toMatchObject({
      status: "rejected",
      rejection: { reason: expect.stringContaining("a job is already in hand") },
    });
  });

  it("a job being finished here (freight unloading at its destination) does not block the next one", () => {
    const { world, kernel } = freightTestWorld();
    send(kernel, world, {
      source: "narrator",
      kind: "offerJob",
      payload: { job: freightDraft(), surface: true },
    });
    const card = runUntil(kernel, world, 5);
    expect(card.halted).toBe("decision");
    resolve(kernel, world, headDecision(world).id, "left");
    runUntil(kernel, world, 1);
    fakeCargoWork(world, "aboard");
    const arrived = runUntil(
      kernel,
      world,
      2000,
      (w) => w.state.travel.stage === "docked" && w.state.travel.portId === PORTS.b,
    );
    expect(arrived.halted).toBe("until");
    expect(theJob(world).status).toBe("inTransit");
    expect(openProblems(world, "cargoToUnload")).toHaveLength(2);
    send(kernel, world, {
      source: "narrator",
      kind: "offerJob",
      payload: { job: freightDraft(PORTS.b, PORTS.a), surface: false },
    });
    runUntil(kernel, world, 1);
    const accept = send(kernel, world, {
      source: "player",
      kind: "acceptContract",
      payload: { jobId: offeredJob(world).id },
    });
    expect(accept.status).toBe("accepted");
  });

  it("setCourse during a live passage: a far port is refused, a neighbouring detour and the passenger's own port are not", () => {
    const { world, kernel } = offerAndAccept(60, { luggage: 1 });
    expect(world.state.travel).toMatchObject({ stage: "docked", plannedDestinationId: PORTS.b });
    const course = (destinationPortId: PortDefId) =>
      send(kernel, world, { source: "player", kind: "setCourse", payload: { destinationPortId } });
    expect(course(PORTS.d)).toMatchObject({
      status: "rejected",
      rejection: {
        code: "preconditionFailed",
        reason: expect.stringContaining(`bound for "${PORTS.b}"`),
      },
    });
    expect(world.state.travel.voyageDestinationId).toBeUndefined();
    expect(course(PORTS.c).status).toBe("accepted");
    expect(course(PORTS.b).status).toBe("accepted");
  });

  it("setCourse with freight in hand is unchanged: a far port starts a voyage", () => {
    const { world, kernel } = freightTestWorld();
    send(kernel, world, {
      source: "narrator",
      kind: "offerJob",
      payload: { job: freightDraft(), surface: true },
    });
    expect(runUntil(kernel, world, 5).halted).toBe("decision");
    resolve(kernel, world, headDecision(world).id, "left");
    runUntil(kernel, world, 1);
    expect(theJob(world).status).toBe("accepted");
    const result = send(kernel, world, {
      source: "player",
      kind: "setCourse",
      payload: { destinationPortId: PORTS.d },
    });
    expect(result.status).toBe("accepted");
    runUntil(kernel, world, 1);
    expect(world.state.travel).toMatchObject({
      plannedDestinationId: PORTS.c,
      voyageDestinationId: PORTS.d,
    });
  });
});

describe("endPassage and the course", () => {
  it("docked: clears the course and the voyage, the ship stays, and luggage aboard is put off with them", () => {
    const { world, kernel } = offerAndAccept(190, { luggage: 1, toPortId: PORTS.d });
    const job = theJob(world);
    const actorId = passengerOf(world).actor?.id as ActorId;
    expect(world.state.travel).toMatchObject({
      stage: "docked",
      portId: PORTS.a,
      plannedDestinationId: PORTS.c,
      voyageDestinationId: PORTS.d,
    });
    // The luggage is aboard and would let the ship leave: endPassage applies first next tick.
    fakeCargoWork(world, "aboard");
    expect(
      send(kernel, world, { source: "player", kind: "endPassage", payload: { jobId: job.id } })
        .status,
    ).toBe("accepted");
    const off = runUntil(
      kernel,
      world,
      3,
      (w) => w.state.actors[actorId]?.availability === "offShip",
    );
    expect(off.halted).toBe("until");
    expect(world.state.travel).toEqual({ stage: "docked", portId: PORTS.a });
    expect(openProblems(world, "cargoToUnload")).toMatchObject([
      {
        payload: {
          jobId: job.id,
          itemId: job.cargoItemIds[0],
          portId: PORTS.a,
          storeKey: "warehouse",
        },
      },
    ]);
    expect(runUntil(kernel, world, 2 * TICK_RATE).halted).toBe("ticks");
    expect(world.state.travel).toEqual({ stage: "docked", portId: PORTS.a });
  });

  it("in transit: the voyage is dropped, the ship stops at the next port, the passenger and their luggage leave there and captainAshore asks", () => {
    const { world, kernel } = offerAndAccept(190, { luggage: 1, toPortId: PORTS.d });
    const job = theJob(world);
    const actorId = passengerOf(world).actor?.id as ActorId;
    fakeCargoWork(world, "aboard");
    const out = runUntil(kernel, world, 2000, (w) => w.state.travel.stage === "transit");
    expect(out.halted).toBe("until");
    expect(world.state.travel).toMatchObject({ toPortId: PORTS.c, voyageDestinationId: PORTS.d });
    send(kernel, world, { source: "player", kind: "endPassage", payload: { jobId: job.id } });
    const ended = runUntil(kernel, world, 3, (w) => theJob(w).status === "failed");
    expect(ended.halted).toBe("until");
    expect(world.state.travel).toMatchObject({ stage: "transit", toPortId: PORTS.c });
    expect(world.state.travel.voyageDestinationId).toBeUndefined();
    const docked = runUntil(
      kernel,
      world,
      2000,
      (w) => w.state.actors[actorId]?.availability === "offShip",
    );
    expect(docked.halted).toBe("until");
    expect(world.state.travel).toEqual({ stage: "docked", portId: PORTS.c });
    expect(world.state.actors[actorId]?.location).toEqual({
      kind: "inExternalStore",
      portId: PORTS.c,
      storeKey: "lounge",
    });
    expect(openProblems(world, "cargoToUnload")).toMatchObject([
      { payload: { jobId: job.id, itemId: job.cargoItemIds[0], portId: PORTS.c } },
    ]);
    const after = runUntil(kernel, world, 2 * TICK_RATE);
    expect(captainAshorePorts([...docked.hooks, ...after.hooks])).toEqual([PORTS.c]);
    expect(world.state.travel).toEqual({ stage: "docked", portId: PORTS.c });
  });
});

describe("the overdue card and the return", () => {
  const LATE: FixtureConfigOverrides = {
    passage: {
      ashoreDaysMin: 20 / FIXTURE_DAY,
      ashoreDaysMax: 20 / FIXTURE_DAY,
      overdueDays: 5 / FIXTURE_DAY,
    },
  };

  /** Ashore at b, run to the tick before the overdue card is due. */
  function ashoreUntilJustBeforeOverdue() {
    const run = offerAndAccept(150, { roundTrip: true }, LATE);
    const { world, kernel } = run;
    const arrived = runUntil(kernel, world, 2000, (w) => passengerOf(w).passage.leg === "ashore");
    expect(arrived.halted).toBe("until");
    const since = passengerOf(world).passage.ashoreSinceTick ?? 0;
    const cardTick = since + 5 * TICK_RATE;
    const before = runUntil(kernel, world, 2000, (w) => w.state.tick === cardTick - 1);
    expect(before.halted).toBe("until");
    return { ...run, cardTick };
  }

  /**
   * The one window in which a return can fall due with the card unanswered: another card is
   * ahead of it in the queue (here a job offer applied in the same tick), so answering that one
   * runs a tick before the overdue card reaches the captain.
   */
  function returnDueBehindAnotherCard() {
    const run = ashoreUntilJustBeforeOverdue();
    const { world, kernel, cardTick } = run;
    send(kernel, world, {
      source: "narrator",
      kind: "offerJob",
      payload: { job: freightDraft(PORTS.b, PORTS.a), surface: true },
    });
    const halted = runUntil(kernel, world, 1);
    expect(halted.halted).toBe("decision");
    expect(world.state.tick).toBe(cardTick);
    expect(headDecision(world).prompt.key).toBe("job.offer");
    expect(overdueCardIds(world)).toHaveLength(1);
    const { passage } = passengerOf(world);
    passage.returnsAtTick = cardTick + 1;
    // "Pass" on the offer: the next tick runs with the return due and the overdue card pending.
    resolve(kernel, world, headDecision(world).id, "right");
    const next = runUntil(kernel, world, 2);
    expect(next.halted).toBe("decision");
    expect(world.state.tick).toBe(cardTick + 1);
    const decision = headDecision(world);
    expect(decision.prompt.key).toBe(PASSENGER_OVERDUE_PROMPT_KEY);
    // Due back, yet held while the card is on the table.
    expect(passage.leg).toBe("ashore");
    expect(passengerOf(world).actor?.availability).toBe("offShip");
    return { ...run, decision };
  }

  function overdueCardIds(world: World) {
    return Object.values(world.state.decisions.records)
      .filter((d) => d.prompt.key === PASSENGER_OVERDUE_PROMPT_KEY)
      .map((d) => d.id);
  }

  it("holds a return that falls due while the card is unanswered, so 'Leave without them' leaves them ashore", () => {
    const { world, kernel, decision } = returnDueBehindAnotherCard();
    const actorId = passengerOf(world).actor?.id as ActorId;
    resolve(kernel, world, decision.id, "right");
    const left = runUntil(kernel, world, 3, (w) => theJob(w).status === "failed");
    expect(left.halted).toBe("until");
    expect(theJob(world).passage).toMatchObject({ leg: "ashore", endReason: "leftBehind" });
    expect(world.state.actors[actorId]).toMatchObject({
      availability: "offShip",
      location: { kind: "inExternalStore", portId: PORTS.b, storeKey: "lounge" },
    });
    expect(runUntil(kernel, world, 2 * TICK_RATE).halted).toBe("ticks");
    expect(world.state.actors[actorId]?.availability).toBe("offShip");
  });

  it("'Wait for them' lets the held return happen on the next tick", () => {
    const { world, kernel, decision } = returnDueBehindAnotherCard();
    resolve(kernel, world, decision.id, "left");
    const back = runUntil(kernel, world, 2, (w) => passengerOf(w).passage.leg === "back");
    expect(back.halted).toBe("until");
    expect(ofType(back.events, "passengerReturned")).toHaveLength(1);
    expect(passengerOf(world).actor?.availability).toBe("available");
  });

  it("left behind: the voyage home planned when they went ashore is kept", () => {
    const { world, kernel } = ashoreUntilJustBeforeOverdue();
    const card = runUntil(kernel, world, 3);
    expect(card.halted).toBe("decision");
    expect(headDecision(world).prompt.key).toBe(PASSENGER_OVERDUE_PROMPT_KEY);
    resolve(kernel, world, headDecision(world).id, "right");
    const ended = runUntil(kernel, world, 3, (w) => theJob(w).status === "failed");
    expect(ended.halted).toBe("until");
    // Nothing waits for them any more: the course home set on arrival begins at once.
    expect(world.state.travel).toMatchObject({
      stage: "preparingDeparture",
      fromPortId: PORTS.b,
      toPortId: PORTS.a,
    });
  });
});

describe("leaving the deck", () => {
  it("releases any tile reservation the passenger held", () => {
    const { world, kernel } = offerAndAccept(60);
    const actorId = passengerOf(world).actor?.id as ActorId;
    const key = `${FIX.deck}:3,2`;
    world.caches.nav.reservations[key] = [actorId];
    const gone = runUntil(kernel, world, 2000, (w) => w.state.actors[actorId] === undefined);
    expect(gone.halted).toBe("until");
    expect(world.caches.nav.reservations[key]).toBeUndefined();
  });
});

describe("the bridge while the ship waits for a passenger", () => {
  const CONSOLE = "machine.freight.console" as MachineDefId;
  const CONSOLE_ORIGIN = { x: 6, y: 2 };

  /** The freight fixture plus a pilot station at (6,2), operated from (6,3). */
  function worldWithConsole(): FixtureWorld {
    const registry = createRegistry();
    registerTravel(registry);
    registerCommerce(registry);
    // §who-has-the-helm: the helm watch is the watch's, and the helm is manned by someone holding
    // its seat, so the crew must be able to walk up and take it.
    registerSpatial(registry);
    registerWatch(registry);
    registerWork(registry, {
      derivations: { ...travelTaskDerivations, ...commerceTaskDerivations },
    });
    registerPlannerDefaults(registry);
    const kernel = createKernel(registry);
    const config = fixtureConfig();
    const base = fixtureContent(config);
    const engine = base.machines[FIX.engine];
    const deck = base.decks[FIX.deck];
    if (engine === undefined || deck === undefined) throw new Error("fixture changed");
    const content: ContentBundle = {
      ...base,
      machines: {
        ...base.machines,
        [CONSOLE]: {
          ...engine,
          id: CONSOLE,
          name: "Bridge console",
          tags: ["pilotStation"],
          interactionPositions: [
            { key: "seat", offset: { x: 0, y: 1 }, purposes: ["operate"], capacity: 1 },
          ],
          operation: { requiresOperator: true },
          faults: [],
        },
      },
      decks: {
        ...base.decks,
        [FIX.deck]: {
          ...deck,
          machines: [
            ...deck.machines,
            { key: "console1", machineDefId: CONSOLE, origin: CONSOLE_ORIGIN, rotation: 0 },
          ],
        },
      },
    };
    const world = kernel.createWorld(FIX.scenario, 42, content, fixtureEffectiveConfig(config));
    return { registry, kernel, world };
  }

  function captain(world: World) {
    const actor = Object.values(world.state.actors).find((a) => a.roleTags.includes("captain"));
    if (actor === undefined) throw new Error("no captain");
    return actor;
  }

  const staffingProblems = (world: World) =>
    Object.values(world.state.work.problems).filter(
      (p) => p.kind === "stationToStaff" && p.status === "open",
    );

  it("does not open stationToStaff while the passenger is ashore, and opens it once they are back aboard", () => {
    const fixture = worldWithConsole();
    // The captain stands at the console so the ship can leave A and dock at B.
    const skipper = captain(fixture.world);
    skipper.location = { kind: "onDeck", deckId: FIX.deck, x: 6.5, y: 3.5 };
    const { world, kernel } = offerAndAccept(150, { roundTrip: true }, {}, fixture);
    const arrived = runUntil(kernel, world, 2000, (w) => passengerOf(w).passage.leg === "ashore");
    expect(arrived.halted).toBe("until");
    expect(world.state.travel).toMatchObject({ portId: PORTS.b, plannedDestinationId: PORTS.a });
    expect(staffingProblems(world)).toEqual([]);
    // Nobody at the console for the rest of the stay: still no call for a pilot.
    skipper.location = { kind: "onDeck", deckId: FIX.deck, x: 1.5, y: 1.5 };
    const waiting = runUntil(kernel, world, 2 * TICK_RATE);
    expect(waiting.halted).toBe("ticks");
    expect(world.state.travel.stage).toBe("docked");
    expect(staffingProblems(world)).toEqual([]);
    const back = runUntil(
      kernel,
      world,
      2 * TICK_RATE,
      (w) => passengerOf(w).passage.leg === "back",
    );
    expect(back.halted).toBe("until");
    // Nothing holds the ship now: departure prep begins and waits on the pilot it just called.
    runUntil(kernel, world, 1);
    expect(staffingProblems(world)).toHaveLength(1);
    expect(world.state.travel).toMatchObject({ stage: "preparingDeparture", toPortId: PORTS.a });
  });
});
