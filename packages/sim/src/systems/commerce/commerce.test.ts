/**
 * Commerce tests (PLAN §6 W6 "Tests"): price bands, the offer/accept/decline decision path, the
 * full freight loop (offer -> accept -> load -> travel -> unload -> pay exactly once), and the
 * `captainAshore` hook.
 */
import { describe, expect, it } from "vitest";
import { cmd } from "../../core/fixtures/test-world";
import type { HookId, JobId } from "../../core/types/ids";
import type { Item } from "../../core/types/ship";
import {
  FIX,
  PORTS,
  advanceThroughHooks,
  advanceToStage,
  freightTestWorld,
} from "../travel/fixtures";
import { jobBlockingAcceptance } from "../travel/in-hand";

function jobDraft(pay: number) {
  return {
    issuer: "Test Shipper",
    description: { key: "test.job", params: {} },
    fromPortId: PORTS.a,
    toPortId: PORTS.b,
    cargo: [{ itemDefId: FIX.crate, count: 2 }],
    pay,
  };
}

describe("commerce: price bands (D6)", () => {
  it("rejects offerJob outside the price band", () => {
    const { world, kernel } = freightTestWorld();
    // band for "general" is [1,3] credits per unit per distance-unit; distance 25, units 2 =>
    // valid range [50, 150]. 1 credit is absurdly outside it.
    const result = kernel.enqueueCommand(
      world,
      cmd({ source: "scenario", kind: "offerJob", payload: { job: jobDraft(1), surface: false } }),
    );
    expect(result).toMatchObject({ status: "rejected", rejection: { code: "outOfBounds" } });
  });

  it("bands pay over the shortest path to a port beyond one hop (§2.3)", () => {
    // a -> c -> d is 95; 2 crates × general [1, 3] gives [190, 570].
    const draft = (pay: number) => ({ ...jobDraft(pay), toPortId: PORTS.d });
    const offer = (pay: number) =>
      freightTestWorld().kernel.enqueueCommand(
        freightTestWorld().world,
        cmd({ source: "narrator", kind: "offerJob", payload: { job: draft(pay), surface: false } }),
      );
    expect(offer(190).status).toBe("accepted");
    expect(offer(570).status).toBe("accepted");
    expect(offer(189)).toMatchObject({
      status: "rejected",
      rejection: { code: "outOfBounds", reason: expect.stringContaining("[190, 570]") },
    });
    expect(offer(571).status).toBe("rejected");
  });

  it("rejects a destination no chain of routes reaches, with a reason", () => {
    const { world, kernel } = freightTestWorld();
    const result = kernel.enqueueCommand(
      world,
      cmd({
        source: "narrator",
        kind: "offerJob",
        payload: { job: { ...jobDraft(100), toPortId: "port.nowhere" as never }, surface: false },
      }),
    );
    expect(result).toMatchObject({
      status: "rejected",
      rejection: { code: "outOfBounds", reason: expect.stringContaining("unknown port") },
    });
  });

  it("accepts a narrator offerJob within the band (AUTHORITY allows it)", () => {
    const { world, kernel } = freightTestWorld();
    const result = kernel.enqueueCommand(
      world,
      cmd({
        source: "narrator",
        kind: "offerJob",
        payload: { job: jobDraft(100), surface: false },
      }),
    );
    expect(result.status).toBe("accepted");
  });
});

describe("commerce: setCourse authority", () => {
  it("rejects setCourse while in transit", () => {
    const { world, kernel } = freightTestWorld();
    kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "setCourse", payload: { destinationPortId: PORTS.b } }),
    );
    kernel.advance(world, 60);
    expect(world.state.travel.stage).toBe("transit");
    const again = kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "setCourse", payload: { destinationPortId: PORTS.c } }),
    );
    expect(again).toMatchObject({ status: "rejected", rejection: { code: "preconditionFailed" } });
  });
});

describe("commerce: decision perspective (D8)", () => {
  it("surfaces the offer to the first officer when the captain is unavailable", () => {
    const { world, kernel } = freightTestWorld();
    const captain = Object.values(world.state.actors).find((a) => a.roleTags.includes("captain"));
    if (captain === undefined) throw new Error("no captain");
    captain.availability = "incapacitated";
    const firstOfficer = Object.values(world.state.actors).find((a) =>
      a.roleTags.includes("firstOfficer"),
    );
    if (firstOfficer === undefined) throw new Error("no first officer");

    kernel.enqueueCommand(
      world,
      cmd({ source: "scenario", kind: "offerJob", payload: { job: jobDraft(100), surface: true } }),
    );
    kernel.advance(world, 1);
    const decisionId = world.state.decisions.queue[0];
    expect(decisionId).toBeDefined();
    const decision =
      decisionId === undefined ? undefined : world.state.decisions.records[decisionId];
    expect(decision?.perspectiveActorId).toBe(firstOfficer.id);
  });
});

describe("commerce: captainAshore hook", () => {
  it("raises captainAshore when docked with nothing on, and not again within the cooldown", () => {
    // D40/D46: the narrator is the only source of work, so a fresh world docked at its start
    // port asks for an offer on the first tick, and asks again only after reofferDays.
    const { world, kernel } = freightTestWorld();

    const first = kernel.advance(world, 1);
    expect(first.halt).toEqual({ kind: "hook" });
    expect(world.state.narrator.pendingHook?.kind).toBe("captainAshore");

    const hookId = world.state.narrator.pendingHook?.id as HookId;
    kernel.enqueueCommand(
      world,
      cmd({ source: "system", kind: "acknowledgeHook", payload: { hookId } }),
    );
    const after = kernel.advance(world, 50);
    expect(after.halt).toEqual({ kind: "completed" });
    expect(world.state.narrator.pendingHook).toBeUndefined();
  });
});

describe("commerce: full freight loop", () => {
  it("offers, accepts, loads, travels, unloads and pays exactly once", () => {
    // D40: nothing in the sim offers work, so the only job is the one offered explicitly below.
    const { world, kernel } = freightTestWorld({ dockingFee: 3 });
    const startingBalance = world.state.money.balance;

    const offerCmd = cmd({
      source: "scenario",
      kind: "offerJob",
      payload: { job: jobDraft(90), surface: true },
    });
    kernel.enqueueCommand(world, offerCmd);
    kernel.advance(world, 1);

    const decisionId = world.state.decisions.queue[0];
    if (decisionId === undefined) throw new Error("no decision queued");
    kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "resolveDecision", payload: { decisionId, side: "left" } }),
    );
    // D40: `captainAshore` stays quiet while an offer or an accepted job is open, so nothing halts
    // here; the helper only guards against an incidental hook.
    advanceThroughHooks(kernel, world, 30);

    const jobId = Object.keys(world.state.jobs)[0] as JobId | undefined;
    if (jobId === undefined) throw new Error("no job");
    const job = world.state.jobs[jobId];
    if (job === undefined) throw new Error("job vanished");
    expect(job.status).toBe("accepted");
    expect(job.cargoItemIds.length).toBeGreaterThan(0);

    const loadProblems = Object.values(world.state.work.problems).filter(
      (p) => p.kind === "cargoToLoad" && p.status === "open",
    );
    expect(loadProblems.length).toBe(job.cargoItemIds.length);
    for (const itemId of job.cargoItemIds) {
      const item = world.state.items[itemId];
      expect(item?.location).toEqual({
        kind: "inExternalStore",
        portId: PORTS.a,
        storeKey: "warehouse",
      });
    }

    // Fake hauling aboard: W4 isn't built yet, so the test plays its part directly.
    for (const problem of loadProblems) problem.status = "resolved";
    for (const itemId of job.cargoItemIds) {
      const item = world.state.items[itemId] as Item;
      item.location = { kind: "onDeck", deckId: FIX.deck, x: 1.5, y: 2.5 };
    }

    kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "setCourse", payload: { destinationPortId: PORTS.b } }),
    );
    advanceToStage(kernel, world, "approaching");
    // §one-job-in-hand: freight under way is the one job in hand until the ship docks at its
    // destination.
    expect(jobBlockingAcceptance(world.state)?.id).toBe(jobId);
    // Docking at B with nothing on raises `captainAshore` (D40); acknowledge that too.
    advanceThroughHooks(kernel, world, 1000);
    expect(world.state.travel).toEqual({
      stage: "docked",
      portId: PORTS.b,
      dockedSinceTick: expect.any(Number),
    });
    expect(job.status).toBe("inTransit");
    expect(jobBlockingAcceptance(world.state)).toBeUndefined();

    // Arrival raised cargoToUnload; another tick to be sure.
    kernel.advance(world, 1);
    const unloadProblems = Object.values(world.state.work.problems).filter(
      (p) => p.kind === "cargoToUnload" && p.payload.jobId === jobId,
    );
    expect(unloadProblems.length).toBe(job.cargoItemIds.length);

    for (const itemId of job.cargoItemIds) {
      const item = world.state.items[itemId] as Item;
      item.location = { kind: "inExternalStore", portId: PORTS.b, storeKey: "warehouse" };
    }
    kernel.advance(world, 1);
    expect(job.status).toBe("paid");
    expect(job.paymentTransactionId).toBeDefined();

    const balanceAfterFirstPay = world.state.money.balance;
    // dockingFee charged once on arrival at B (100 - 3), then +90 pay.
    expect(balanceAfterFirstPay).toBe(startingBalance - 3 + 90);

    // Re-running the completion check (more ticks) must not pay again.
    kernel.advance(world, 20);
    expect(world.state.money.balance).toBe(balanceAfterFirstPay);
    const paymentTxIds = Object.values(world.state.money.transactions).filter(
      (t) => t.jobId === jobId,
    );
    expect(paymentTxIds).toHaveLength(1);
  });

  it("declines an offered job", () => {
    const { world, kernel } = freightTestWorld();
    kernel.enqueueCommand(
      world,
      cmd({ source: "scenario", kind: "offerJob", payload: { job: jobDraft(90), surface: false } }),
    );
    kernel.advance(world, 1);
    const jobId = Object.keys(world.state.jobs)[0] as JobId | undefined;
    if (jobId === undefined) throw new Error("no job");
    kernel.enqueueCommand(world, cmd({ source: "player", kind: "declineJob", payload: { jobId } }));
    kernel.advance(world, 1);
    expect(world.state.jobs[jobId]?.status).toBe("declined");
  });
});

describe("commerce: offers are made at the dock, never in flight (§offers-in-person)", () => {
  function jobDraftFrom(fromPortId: typeof PORTS.a, toPortId: typeof PORTS.a, pay: number) {
    return { ...jobDraft(pay), fromPortId, toPortId };
  }

  /**
   * Drive the ship from A toward B and stop on approach, with no hook pending: an offer made in
   * flight now comes from a story hook such as `quietTooLong`, never from the arrival
   * (there is no `approachingPort`; the fixture's ports have no dock map, so no `stageDock`).
   */
  function approachB() {
    const { world, kernel } = freightTestWorld();
    kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "setCourse", payload: { destinationPortId: PORTS.b } }),
    );
    advanceToStage(kernel, world, "approaching");
    if (world.state.narrator.pendingHook !== undefined) {
      const hookId = world.state.narrator.pendingHook.id;
      kernel.enqueueCommand(
        world,
        cmd({ source: "system", kind: "acknowledgeHook", payload: { hookId } }),
      );
    }
    expect(world.state.travel.stage).toBe("approaching");
    return { world, kernel };
  }

  it("refuses a surfaced offer in flight: offers are put to the captain at the dock", () => {
    const { world, kernel } = approachB();
    const offer = kernel.enqueueCommand(
      world,
      cmd({
        source: "narrator",
        kind: "offerJob",
        payload: { job: jobDraftFrom(PORTS.b, PORTS.a, 100), surface: true },
      }),
    );
    expect(offer.status).toBe("rejected");
    kernel.advance(world, 1);
    expect(Object.values(world.state.jobs)).toEqual([]);
    expect(world.state.decisions.queue).toEqual([]);
    expect(world.state.decisions.held).toEqual([]);
  });

  it("still posts a quiet offer in flight, with no card", () => {
    const { world, kernel } = approachB();
    kernel.enqueueCommand(
      world,
      cmd({
        source: "scenario",
        kind: "offerJob",
        payload: { job: jobDraftFrom(PORTS.b, PORTS.a, 100), surface: false },
      }),
    );
    kernel.advance(world, 1);
    expect(Object.values(world.state.jobs).map((j) => j.status)).toEqual(["offered"]);
    expect(world.state.decisions.queue).toEqual([]);
    expect(world.state.decisions.held).toEqual([]);
  });

  it("shows the card at once when surfaced while docked at a port with no dock map", () => {
    const { world, kernel } = freightTestWorld();
    kernel.enqueueCommand(
      world,
      cmd({ source: "narrator", kind: "offerJob", payload: { job: jobDraft(100), surface: true } }),
    );
    const result = kernel.advance(world, 1);
    expect(result.halt).toEqual({ kind: "decision" });
    expect(world.state.decisions.queue).toHaveLength(1);
    expect(world.state.decisions.held).toEqual([]);
  });
});
