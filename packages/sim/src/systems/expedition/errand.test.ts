/**
 * Expeditions A2 W1 (§6, plan calls 5 and 11): settling the errand when its expedition resolves,
 * and the errand played end to end by commands on the site world (`commerce/fixtures-errand.ts`:
 * docked at `TINY.port`, the test site 10 away, a lone unarmed target unless a test says
 * otherwise). The real bundle's course via Green Meridian to Harrow End is `apps/cli`'s.
 */
import { describe, expect, it } from "vitest";
import { isOnDock } from "../../core/docks";
import { TINY } from "../../core/fixtures/tiny-content";
import { allocateId } from "../../core/ids";
import type { Actor } from "../../core/types/actor";
import type { TileCoord } from "../../core/types/common";
import type { NarratorHookKind } from "../../core/types/decisions";
import type { EventDraft, SimEvent } from "../../core/types/events";
import type { ItemDefId, ItemId, JobId } from "../../core/types/ids";
import type { ExpeditionOutcome } from "../../core/types/state";
import type { ErrandOutcome, Job, JobErrand } from "../../core/types/travel";
import {
  ERRAND_PEOPLE,
  beginExpedition,
  errandDraft,
  errandWorld,
  fightIt,
  flyHome,
  flyToSite,
  loneTarget,
  runErrand,
  send,
  stepCtxOf,
  takeErrand,
} from "../commerce/fixtures-errand";
import { PASSENGER_CREW_DEF_ID } from "../commerce/passage";
import { fightOf } from "./combat";
import { errandFulfilled, settleErrand } from "./errand";
import { testDamage } from "./fixtures/damage";
import { SITE } from "./fixtures/site";
import { groundOf } from "./ground";

type Test = ReturnType<typeof errandWorld>;

const jobOf = (test: Test, jobId: JobId): Job => {
  const job = test.world.state.jobs[jobId];
  if (job === undefined) throw new Error(`job ${jobId} vanished`);
  return job;
};

const targetOf = (test: Test): Actor | undefined =>
  Object.values(test.world.state.actors).find((a) => a.combatant?.disposition.part === "target");

const ofType = <T extends SimEvent["type"]>(events: readonly SimEvent[], type: T) =>
  events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

/** An errand taken, flown to the site and its expedition begun, nothing resolved yet. */
function atTheSite(errand: Partial<JobErrand> = {}, cast = loneTarget) {
  const test = errandWorld({ cast });
  const draft = errandDraft(test);
  const base = draft.errand;
  if (base === undefined) throw new Error("the draft lost its errand");
  const jobId = takeErrand(test, { ...draft, errand: { ...base, ...errand } });
  const out = flyToSite(test);
  beginExpedition(test, jobId);
  return { test, jobId, out };
}

/** Settle the errand directly, as `resolve()` would with `outcome`; returns what it emitted. */
function settle(test: Test, outcome: ExpeditionOutcome): EventDraft[] {
  const { ctx, drafts } = stepCtxOf(test);
  const ground = groundOf(ctx);
  if (ground === undefined) throw new Error("no site alongside");
  const fight = fightOf(ctx, { applyDamage: testDamage }, ground);
  if (fight === undefined) throw new Error("no expedition");
  settleErrand(fight, outcome);
  return drafts;
}

/** A new item lying on the site's floor at `tile` (deck frame). */
function dropOnFloor(test: Test, defId: ItemDefId, tile: TileCoord): ItemId {
  const presence = test.world.state.deck.dock;
  if (presence === undefined) throw new Error("no dock alongside");
  const id = allocateId(test.world.state, "item");
  test.world.state.items[id] = {
    id,
    defId,
    stacking: "unique",
    location: { kind: "onDeck", deckId: presence.deckId, x: tile.x + 0.5, y: tile.y + 0.5 },
    condition: 1,
  };
  test.world.caches.dirty.inventory = true;
  return id;
}

/** The cast's target dead where they stand. */
function killTarget(test: Test): void {
  const target = targetOf(test);
  if (target?.combatant === undefined) throw new Error("no target");
  target.availability = "dead";
  target.combatant.state = "dead";
}

describe("settling the errand (call 5)", () => {
  it("a target taken alive boards as the captive: a fresh passenger with their name, on their tile", () => {
    const { test, jobId } = atTheSite();
    const target = targetOf(test);
    const at = target?.location;
    if (target === undefined || at?.kind !== "onDeck") throw new Error("no target on the map");
    const drafts = settle(test, "targetTaken");
    const job = jobOf(test, jobId);
    expect(job.errand?.outcome).toBe("broughtAlive");
    expect(job.status).toBe("inTransit");
    const captiveId = job.passage?.actorId;
    expect(job.passage).toEqual({ actorId: captiveId, roundTrip: false, leg: "out" });
    expect(test.world.state.actors[target.id]).toBeUndefined();
    const captive = captiveId === undefined ? undefined : test.world.state.actors[captiveId];
    expect(captive).toMatchObject({
      name: ERRAND_PEOPLE.target,
      defId: PASSENGER_CREW_DEF_ID,
      crew: true,
      passenger: true,
      availability: "available",
      location: { kind: "onDeck", x: Math.floor(at.x) + 0.5, y: Math.floor(at.y) + 0.5 },
    });
    expect(captive?.combatant).toBeUndefined();
    expect(drafts.map((d) => d.type)).toEqual(["entitySpawned", "passengerBoarded"]);
    expect(test.world.state.travel.voyageDestinationId).toBe(TINY.port);
  });

  it.each<[string, JobErrand["wants"], ErrandOutcome]>([
    ["either", "either", "broughtDead"],
    ["dead", "dead", "broughtDead"],
    ["alive", "alive", "failed"],
  ])("a target taken dead when the job wants them %s is %s", (_, wants, expected) => {
    const { test, jobId } = atTheSite({ wants });
    killTarget(test);
    const drafts = settle(test, "targetTaken");
    const job = jobOf(test, jobId);
    expect(job.errand?.outcome).toBe(expected);
    expect(job.passage).toBeUndefined();
    expect(job.status).toBe(expected === "failed" ? "failed" : "inTransit");
    expect(drafts.filter((d) => d.type === "jobFailed")).toHaveLength(
      expected === "failed" ? 1 : 0,
    );
    expect(test.world.state.travel.voyageDestinationId).toBe(TINY.port);
  });

  it.each<ExpeditionOutcome>(["targetFled", "partyWithdrew", "partyRouted", "timedOut"])(
    "%s fails the job there and then, and the ship still goes home",
    (outcome) => {
      const { test, jobId } = atTheSite();
      const drafts = settle(test, outcome);
      const job = jobOf(test, jobId);
      expect(job.errand?.outcome).toBe("failed");
      expect(job.status).toBe("failed");
      expect(job.closedTick).toBe(test.world.state.tick + 1);
      expect(job.passage).toBeUndefined();
      expect(drafts.filter((d) => d.type === "jobFailed").map((d) => d.payload)).toEqual([
        { jobId, outcome: "failed" },
      ]);
      // Only the voyage: travel plans the hop itself once nothing holds the ship.
      const travel = test.world.state.travel;
      expect(travel).toMatchObject({ stage: "docked", voyageDestinationId: TINY.port });
      expect(travel.stage === "docked" ? travel.plannedDestinationId : "under way").toBeUndefined();
    },
  );

  it("settles nothing for an expedition with no errand (the A1 scenario start)", () => {
    const { test, jobId } = atTheSite();
    const expedition = test.world.state.expedition;
    if (expedition === undefined) throw new Error("no expedition");
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete expedition.jobId;
    expect(settle(test, "targetFled")).toEqual([]);
    expect(jobOf(test, jobId).errand?.outcome).toBeUndefined();
    expect(test.world.state.travel.voyageDestinationId).toBeUndefined();
  });

  it("refuses to settle an errand twice", () => {
    const { test } = atTheSite();
    settle(test, "targetFled");
    expect(() => settle(test, "targetFled")).toThrow("already settled");
  });
});

describe("errandFulfilled", () => {
  const travelAt = (portId: string) => ({ stage: "docked", portId }) as const;
  const job = (outcome: ErrandOutcome | undefined) =>
    ({
      cargoItemIds: [] as ItemId[],
      toPortId: TINY.port,
      errand: {
        kind: "fetchPerson",
        siteId: SITE.port,
        targetName: "Corran Vale",
        wants: "either",
        returnToPortId: TINY.port,
        ...(outcome === undefined ? {} : { outcome }),
      },
    }) as Pick<Job, "cargoItemIds" | "toPortId" | "errand">;

  it("pays a target brought dead once the ship is docked at the return port, and nothing else", () => {
    const test = errandWorld();
    const { content } = test.world;
    const state = (portId: string) =>
      ({ ...test.world.state, travel: travelAt(portId) }) as typeof test.world.state;
    expect(errandFulfilled(state(TINY.port), content, job("broughtDead"))).toBe(true);
    expect(errandFulfilled(state(SITE.port), content, job("broughtDead"))).toBe(false);
    for (const outcome of ["broughtAlive", "failed", undefined] as const) {
      expect(errandFulfilled(state(TINY.port), content, job(outcome)), String(outcome)).toBe(false);
    }
    expect(errandFulfilled(state(TINY.port), content, job("broughtItem"))).toBe(false);
  });
});

describe("the errand end to end, by commands (fixtures-errand)", () => {
  it("takes the target alive, flies them home and is paid once as they walk off", () => {
    const { test, jobId, out } = atTheSite();
    const balance = test.world.state.money.balance;
    const hooks: NarratorHookKind[] = [];
    const fight = fightIt(test, { onHook: (h) => hooks.push(h.kind) });
    expect(test.world.state.expedition?.outcome).toBe("targetTaken");
    const resolvedAt = ofType(fight, "expeditionResolved")[0]?.tick;
    const boarded = ofType(fight, "passengerBoarded");
    expect(boarded.map((e) => [e.tick, e.payload])).toEqual([
      [resolvedAt, expect.objectContaining({ jobId, name: ERRAND_PEOPLE.target })],
    ]);
    const captiveId = jobOf(test, jobId).passage?.actorId;
    if (captiveId === undefined) throw new Error("no captive");

    // Aboard (off the site's floor) as the ship lifts off; the aftermath leaves them be.
    let aboardAtLiftOff: boolean | undefined;
    const home = flyHome(test, jobId, {
      onStep: () => {
        const { state, content } = test.world;
        const captive = state.actors[captiveId];
        if (state.travel.stage !== "undocking" || aboardAtLiftOff !== undefined) return;
        aboardAtLiftOff = captive !== undefined && !isOnDock(content, state, captive.location);
      },
    });
    expect(ofType(out, "arrived").map((e) => e.payload.portId)).toEqual([SITE.port]);
    expect(ofType(home, "departed").map((e) => e.payload)).toEqual([
      { fromPortId: SITE.port, toPortId: TINY.port },
    ]);
    expect(aboardAtLiftOff).toBe(true);
    expect(hooks).not.toContain("captainAshore");
    expect(hooks).not.toContain("stageDock");

    const order = ["departed", "arrived", "passageEnded", "contractCompleted", "paymentMade"].map(
      (type) => home.findIndex((e) => e.type === type),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(ofType(home, "passageEnded").map((e) => e.payload)).toEqual([
      expect.objectContaining({ jobId, reason: "completed", portId: TINY.port }),
    ]);
    const job = jobOf(test, jobId);
    expect(ofType(home, "contractCompleted")).toHaveLength(1);
    expect(ofType(home, "paymentMade").map((e) => e.payload)).toEqual([
      expect.objectContaining({ jobId, amount: job.pay }),
    ]);
    expect(ofType([...fight, ...home], "jobFailed")).toEqual([]);
    expect(job.status).toBe("paid");
    expect(job.errand?.outcome).toBe("broughtAlive");
    expect(test.world.state.money.balance).toBe(balance + job.pay);
    expect(test.world.state.actors[captiveId]).toBeUndefined();
    // Paid once: more time at home pays nothing more.
    expect(ofType(runErrand(test, 20), "paymentMade")).toEqual([]);
  }, 30_000);

  it("flies the leg to the site at its authored distance, and sets down with no staging call", () => {
    const test = errandWorld({ cast: loneTarget });
    const jobId = takeErrand(test);
    const legs: number[] = [];
    const hooks: NarratorHookKind[] = [];
    flyToSite(test, {
      onHook: (h) => hooks.push(h.kind),
      onStep: () => {
        const travel = test.world.state.travel;
        if (travel.stage === "transit" && !legs.includes(travel.routeDistance)) {
          legs.push(travel.routeDistance);
        }
      },
    });
    expect(legs).toEqual([10]);
    beginExpedition(test, jobId);
    runErrand(test, 5, { onHook: (h) => hooks.push(h.kind) });
    expect(hooks).not.toContain("stageDock");
    expect(hooks).not.toContain("captainAshore");
  }, 30_000);

  it("fails the job when the target gets away by the exit, and still sets course home", () => {
    const { test, jobId } = atTheSite();
    const { ctx } = stepCtxOf(test);
    const exit = groundOf(ctx)?.posts.exit;
    if (exit === undefined) throw new Error("the site has no exit");
    // The target slips out the moment the party is under way.
    const fight = fightIt(test, {
      onStep: () => {
        const phase = test.world.state.expedition?.phase;
        const target = targetOf(test);
        const at = target?.location;
        if (phase === "mustering" || target === undefined || at?.kind !== "onDeck") return;
        if (target.movement.kind !== "stationary") return;
        target.location = { ...at, x: exit.x + 0.5, y: exit.y + 0.5 };
      },
    });
    expect(test.world.state.expedition?.outcome).toBe("targetFled");
    const job = jobOf(test, jobId);
    expect(job).toMatchObject({ status: "failed", errand: { outcome: "failed" } });
    expect(ofType(fight, "jobFailed").map((e) => e.payload)).toEqual([
      { jobId, outcome: "failed" },
    ]);
    const travel = test.world.state.travel;
    expect(travel.voyageDestinationId).toBe(TINY.port);
    const home = flyHome(test, jobId);
    expect(ofType(home, "arrived").map((e) => e.payload.portId)).toEqual([TINY.port]);
    expect(ofType(home, "paymentMade")).toEqual([]);
    expect(ofType(home, "jobFailed")).toEqual([]);
  }, 30_000);

  it("fails the job when the captive is put off once under way (call 11): they leave at home", () => {
    const { test, jobId } = atTheSite();
    fightIt(test);
    const captiveId = jobOf(test, jobId).passage?.actorId;
    if (captiveId === undefined) throw new Error("no captive");
    // The hop home is planned the tick the fight resolves, and nothing holds the ship.
    expect(test.world.state.travel.stage).not.toBe("docked");
    expect(send(test, { source: "player", kind: "endPassage", payload: { jobId } }).status).toBe(
      "accepted",
    );
    const off = runErrand(test, 1);
    expect(ofType(off, "jobFailed").map((e) => e.payload)).toEqual([{ jobId, outcome: "putOff" }]);
    expect(jobOf(test, jobId)).toMatchObject({ status: "failed", errand: { outcome: "failed" } });
    expect(test.world.state.travel.voyageDestinationId).toBe(TINY.port);
    const home = flyHome(test, jobId);
    expect(ofType(home, "paymentMade")).toEqual([]);
    expect(ofType(home, "contractCompleted")).toEqual([]);
    expect(ofType(home, "jobFailed")).toEqual([]);
    expect(test.world.state.actors[captiveId]).toMatchObject({
      availability: "offShip",
      location: { kind: "inExternalStore", portId: TINY.port },
    });
  }, 30_000);

  it("a captive put off while the ship is held at the site walks free there, and the voyage home stands", () => {
    const { test, jobId } = atTheSite();
    // A hold for repairs keeps the ship set down with its voyage home unplanned.
    test.world.state.travel.holdForRepairs = true;
    fightIt(test);
    const captiveId = jobOf(test, jobId).passage?.actorId;
    if (captiveId === undefined) throw new Error("no captive");
    expect(test.world.state.travel).toMatchObject({ stage: "docked", portId: SITE.port });
    expect(send(test, { source: "player", kind: "endPassage", payload: { jobId } }).status).toBe(
      "accepted",
    );
    const off = runErrand(test, 60, {
      until: () => test.world.state.actors[captiveId] === undefined,
    });
    expect(test.world.state.actors[captiveId]).toBeUndefined();
    expect(ofType(off, "passageEnded").map((e) => e.payload)).toEqual([
      expect.objectContaining({ jobId, reason: "putOff", portId: SITE.port }),
    ]);
    expect(ofType(off, "jobFailed").map((e) => e.payload)).toEqual([{ jobId, outcome: "putOff" }]);
    expect(jobOf(test, jobId)).toMatchObject({ status: "failed", errand: { outcome: "failed" } });
    expect(test.world.state.travel.voyageDestinationId).toBe(TINY.port);
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete test.world.state.travel.holdForRepairs;
    const home = flyHome(test, jobId);
    expect(ofType(home, "paymentMade")).toEqual([]);
  }, 30_000);

  it("lifts off with a blaster left on the site's floor: it stays behind, and nothing throws (call 8)", () => {
    const { test, jobId } = atTheSite();
    fightIt(test);
    const presence = test.world.state.deck.dock;
    const { ctx } = stepCtxOf(test);
    const foot = groundOf(ctx)?.foot;
    if (presence === undefined || foot === undefined) throw new Error("no site floor");
    const blaster = dropOnFloor(test, SITE.blaster, foot);
    const home = flyHome(test, jobId);
    expect(ofType(home, "leftOnDock").map((e) => e.subjectIds[0])).toEqual([blaster]);
    expect(test.world.state.items[blaster]).toBeUndefined();
    expect(jobOf(test, jobId).status).toBe("paid");
  }, 30_000);
});

describe("fetchItem (W1 stretch)", () => {
  it("stows the item when the site is taken and is paid once it is delivered at home", () => {
    const { test, jobId } = atTheSite({
      kind: "fetchItem",
      targetName: "the strongbox papers",
      itemDefId: TINY.crate,
      wants: "either",
    });
    // The loot at the loot post (the landing start puts it there; the scenario start does not).
    const { ctx } = stepCtxOf(test);
    const loot = groundOf(ctx)?.posts.loot;
    const presence = test.world.state.deck.dock;
    if (loot === undefined || presence === undefined) throw new Error("no loot post");
    const there = Object.values(test.world.state.items).some((i) => i.defId === TINY.crate);
    if (!there) dropOnFloor(test, TINY.crate, loot);
    fightIt(test);
    const job = jobOf(test, jobId);
    expect(job.errand?.outcome).toBe("broughtItem");
    expect(job.cargo).toEqual([{ itemDefId: TINY.crate, count: 1 }]);
    const [itemId] = job.cargoItemIds;
    const item = itemId === undefined ? undefined : test.world.state.items[itemId];
    expect(item?.jobId).toBe(jobId);
    expect(item?.location.kind).toBe("onDeck");
    const home = flyHome(test, jobId);
    expect(ofType(home, "paymentMade").map((e) => e.payload)).toEqual([
      expect.objectContaining({ jobId, amount: job.pay }),
    ]);
  }, 60_000);
});
