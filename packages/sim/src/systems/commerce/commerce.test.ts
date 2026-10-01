/**
 * Commerce tests (PLAN §6 W6 "Tests"): price bands, the offer/accept/decline decision path, the
 * full freight loop (offer -> accept -> load -> travel -> unload -> pay exactly once), and the
 * `jobBoard` hook.
 */
import { describe, expect, it } from "vitest";
import type { Command } from "../../core/types/commands";
import type { CommandId, HookId, JobId } from "../../core/types/ids";
import type { Item } from "../../core/types/ship";
import { FIX, PORTS, advanceThroughHooks, freightTestWorld } from "../travel/fixtures";

let counter = 0;
function cmd<C extends Omit<Command, "id">>(command: C): C & { id: CommandId } {
  counter += 1;
  return { ...command, id: `cmd:commerce-test:${counter}` as CommandId };
}

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

describe("commerce: jobBoard hook", () => {
  it("raises jobBoard when docked with nothing on, and does not raise it twice", () => {
    // D40: the narrator is the only source of work, so a fresh world docked at its start port
    // asks for an offer on the first tick, and asks once per docking.
    const { world, kernel } = freightTestWorld();

    const first = kernel.advance(world, 1);
    expect(first.halt).toEqual({ kind: "hook" });
    expect(world.state.narrator.pendingHook?.kind).toBe("jobBoard");

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
    // D40: `jobBoard` stays quiet while an offer or an accepted job is open, so nothing halts
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
    const untilHook = kernel.advance(world, 1000);
    expect(untilHook.halt).toEqual({ kind: "hook" });
    expect(world.state.narrator.pendingHook?.kind).toBe("approachingPort");
    const hookId = world.state.narrator.pendingHook?.id as HookId;
    kernel.enqueueCommand(
      world,
      cmd({ source: "system", kind: "acknowledgeHook", payload: { hookId } }),
    );
    // Docking at B with nothing on raises `jobBoard` (D40); acknowledge that too.
    advanceThroughHooks(kernel, world, 1000);
    expect(world.state.travel).toEqual({ stage: "docked", portId: PORTS.b });
    expect(job.status).toBe("inTransit");

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
