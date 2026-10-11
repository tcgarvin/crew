/**
 * Expeditions A2 W2 (calls 4, 12, 13, 15): set down at a site for an errand, the expedition starts
 * itself and the arrival card asks for a plan; the fight's first turn asks "press on or pull back";
 * a plan for a target wanted alive never fires at them. On the kernel's test site (`fixtures/
 * landing.ts`), every invariant checked at every step.
 */
import { describe, expect, it } from "vitest";
import { findItemDef } from "../../core/defs";
import type { TestWorld } from "../../core/fixtures/test-world";
import { TINY } from "../../core/fixtures/tiny-content";
import type { Actor } from "../../core/types/actor";
import type { SiteCastEntryDef } from "../../core/types/content";
import type { Decision } from "../../core/types/decisions";
import type { SimEvent } from "../../core/types/events";
import type { ActorId, DecisionId, JobId } from "../../core/types/ids";
import type { Job } from "../../core/types/travel";
import type { PlanOption } from "../../core/types/view";
import { CREW } from "../work/fixtures/crew-deck";
import { ARRIVAL_PROMPT_KEY, TURN_PROMPT_KEY, arrivalPair } from "./cards";
import { startExpedition, violations } from "./fixtures/fight";
import {
  type LandingWorld,
  TARGET_NAME,
  acknowledge,
  addErrand,
  answer,
  flyToSite,
  landingWorld,
  sendAs,
  step,
} from "./fixtures/landing";
import { SITE, SITE_CAST, siteWorld } from "./fixtures/site";
import { lockerWeapons } from "./muster";
import { DEFAULT_PLANS } from "./plans";
import { castFor } from "./start";

const RATE = 20;
const EXPEDITION_KEYS = [ARRIVAL_PROMPT_KEY, TURN_PROMPT_KEY];

function decision(test: LandingWorld, id: DecisionId | undefined): Decision {
  const record = id === undefined ? undefined : test.world.state.decisions.records[id];
  if (record === undefined) throw new Error(`no decision ${id}`);
  return record;
}

const cards = (test: { world: LandingWorld["world"] }, key: string) =>
  Object.values(test.world.state.decisions.records).filter((d) => d.prompt.key === key);

const cast = (test: LandingWorld): Actor[] =>
  Object.values(test.world.state.actors).filter((a) => a.combatant?.side === "them");

const where = (test: LandingWorld) =>
  Object.values(test.world.state.actors).map((a) => [a.id, JSON.stringify(a.location)]);

/**
 * Landed, the expedition started and its arrival card's hook raised (one tick after docking), the
 * hook not yet acknowledged.
 */
function landed(options: Parameters<typeof landingWorld>[0] = {}) {
  const test = landingWorld({ scenario: CREW.scenario8, ...options });
  flyToSite(test);
  const { events } = test.kernel.advance(test.world, 1);
  expect(violations(test)).toEqual([]);
  return { test, events };
}

/** Landed, the hook acknowledged, the arrival card on screen and answered `side`. */
function adopted(side: "left" | "right", options: Parameters<typeof landingWorld>[0] = {}) {
  const { test } = landed(options);
  acknowledge(test);
  step(test, 5);
  const card = test.world.state.expedition?.cards?.arrival;
  if (card === undefined) throw new Error("no arrival card");
  const resolved = answer(test, card, side);
  if (resolved.status !== "accepted")
    throw new Error(`resolve refused: ${JSON.stringify(resolved)}`);
  return test;
}

/** Run until the turn card is on screen (or the expedition resolves); returns the events. */
function toTurnCard(test: LandingWorld): SimEvent[] {
  return step(test, 300 * RATE, () => {
    const expedition = test.world.state.expedition;
    return expedition?.phase === "resolved" || expedition?.cards?.turn !== undefined;
  });
}

/** Run to the resolution, answering any card left (hooks acknowledged by `step`). */
function toResolution(test: TestWorld, seconds = 300, check = true): SimEvent[] {
  const events: SimEvent[] = [];
  const end = test.world.state.tick + seconds * RATE;
  const resolved = () => test.world.state.expedition?.phase === "resolved";
  while (test.world.state.tick < end && !resolved()) {
    events.push(...step(test, end - test.world.state.tick, resolved, check));
    const head = test.world.state.decisions.queue[0];
    if (head === undefined) continue;
    const answered = answer(test, head, "left");
    if (answered.status !== "accepted")
      throw new Error(`card refused: ${JSON.stringify(answered)}`);
  }
  return events;
}

describe("setting down for an errand (call 12)", () => {
  it("starts the expedition once, the tick after setting down, the target renamed and nobody sent", () => {
    const test = landingWorld({ scenario: CREW.scenario8 });
    flyToSite(test);
    expect(test.world.state.expedition).toBeUndefined();
    const events = step(test, 1);
    const started = events.filter((e) => e.type === "expeditionStarted");
    expect(started).toHaveLength(1);
    expect(started[0]?.source).toBe("sim");
    const expedition = test.world.state.expedition;
    expect(expedition).toMatchObject({ siteId: SITE.port, phase: "mustering", jobId: test.jobId });
    expect(expedition?.plan).toBeUndefined();
    expect(expedition?.causeCommandId).toBeUndefined();
    const names = cast(test).map((a) => a.name);
    expect(names).toContain(TARGET_NAME);
    expect(names).not.toContain("Corran Vale");
    expect(names).toEqual(expect.arrayContaining(["Hesk Marrow", "Darrow Finch", "Old Pell"]));
    const target = cast(test).find((a) => a.combatant?.disposition.part === "target");
    expect(target?.name).toBe(TARGET_NAME);
    for (const actor of Object.values(test.world.state.actors)) {
      if (!actor.crew) continue;
      expect(actor.combatant).toBeUndefined();
      const activity = actor.activity;
      expect(activity.kind === "personal" && activity.activity === "muster").toBe(false);
    }
  });

  it("never starts a second one for the same errand once it is over", () => {
    const test = adopted("right");
    const events = toResolution(test);
    expect(test.world.state.expedition?.phase).toBe("resolved");
    const startedTick = test.world.state.expedition?.startedTick;
    // Settling the errand sets the voyage home; the ship lifts off and never sets down again for it.
    expect(test.world.state.travel).toMatchObject({ voyageDestinationId: TINY.port });
    events.push(...step(test, 60 * RATE));
    expect(test.world.state.expedition?.startedTick).toBe(startedTick);
    expect(events.filter((e) => e.type === "expeditionStarted")).toHaveLength(0);
  });

  it("with no two plans to offer, asks nothing and gives up after maxApproachSeconds", () => {
    const test = landingWorld({ scenario: CREW.scenario8 });
    flyToSite(test);
    // Everyone ashore on the site floor, so nobody is fit to go and the menu offers nothing.
    const deckId = test.world.state.deck.dock?.deckId;
    if (deckId === undefined) throw new Error("no site alongside");
    for (const actor of Object.values(test.world.state.actors)) {
      if (!actor.crew) continue;
      actor.location = { kind: "onDeck", deckId, x: 9.5, y: 8.5 };
      actor.movement = { kind: "stationary" };
    }
    const events = step(test, 1);
    expect(events.filter((e) => e.type === "expeditionStarted")).toHaveLength(1);
    expect(test.world.state.expedition?.cards).toBeUndefined();
    expect(test.world.state.decisions.queue).toEqual([]);
    const limit = test.world.config.values.expedition.maxApproachSeconds * RATE;
    const startedTick = test.world.state.expedition?.startedTick ?? 0;
    step(test, limit + 10, () => test.world.state.expedition?.phase === "resolved");
    expect(test.world.state.expedition).toMatchObject({ phase: "resolved", outcome: "timedOut" });
    expect(test.world.state.expedition?.resolvedTick).toBe(startedTick + limit);
    // Nobody went, so nobody remembers fighting beside anyone.
    expect(JSON.stringify(test.world.state.social)).not.toContain("foughtBeside");
  });

  it("puts a fetchItem errand's thing down at the loot post and leaves the cast as authored", () => {
    const { test } = landed({ kind: "fetchItem" });
    expect(cast(test).map((a) => a.name)).toContain("Corran Vale");
    // The loot post (11, 11) in the dock frame; the quay berths the deck at (2, 1).
    const loot = Object.values(test.world.state.items).filter((i) => {
      const at = i.location;
      return at.kind === "onDeck" && Math.floor(at.x) === 9 && Math.floor(at.y) === 10;
    });
    expect(loot.map((i) => i.defId)).toEqual([SITE.baton]);
  });
});

describe("the cast for an errand (call 13)", () => {
  const site = { id: "dock.test.site", defaultCast: SITE_CAST } as Parameters<typeof castFor>[1];
  const job = (errand: Partial<NonNullable<Job["errand"]>>) =>
    ({
      id: "j1" as JobId,
      errand: { kind: "fetchPerson", targetName: "Brannoc Vey", wants: "alive", ...errand },
    }) as unknown as Job;

  it("names the one target for the errand and leaves everyone else as authored", () => {
    const out = castFor(job({}), site);
    expect(out.map((e) => e.name)).toEqual([
      "Brannoc Vey",
      "Hesk Marrow",
      "Darrow Finch",
      "Old Pell",
    ]);
    expect(out.slice(1)).toEqual(SITE_CAST.slice(1));
    expect(SITE_CAST[0]?.name).toBe("Corran Vale");
  });

  it("leaves a fetchItem's cast untouched", () => {
    expect(castFor(job({ kind: "fetchItem", targetName: "the strongbox" }), site)).toBe(SITE_CAST);
  });

  it("fails loudly at a site with no target to fetch", () => {
    const empty = { ...site, defaultCast: SITE_CAST.slice(1) } as Parameters<typeof castFor>[1];
    expect(() => castFor(job({}), empty)).toThrow(/0 targets/);
  });
});

describe("the arrival card (call 4)", () => {
  it("is a policy card with no jobId, its hook raised before the world halts on it", () => {
    const { test, events } = landed();
    const expedition = test.world.state.expedition;
    const card = decision(test, expedition?.cards?.arrival);
    expect(card.origin).toBe("policy");
    expect(card.jobId).toBeUndefined();
    expect(card.perspectiveActorId).toBe("a1");
    expect(card.prompt).toEqual({
      key: "expedition.arrival",
      params: {
        jobId: test.jobId,
        site: SITE.port,
        target: TARGET_NAME,
        speaker: "Jon Reyes",
        leftPlan: "hold-lethal-armed",
        rightPlan: "assault-lethal-armed",
        leftLabel: "Hold the ramp from cover",
        rightLabel: "Go in and take them",
        leftWhy: "We make them come to us.",
        rightWhy: `We go in hard and bring ${TARGET_NAME} out.`,
      },
    });
    // Each side's own refs carry its label and its why: the templates read the ref.
    expect(card.left.label).toEqual({
      key: "expedition.arrival.left",
      params: { leftLabel: "Hold the ramp from cover" },
    });
    expect(card.left.aftermath?.params).toEqual({ leftWhy: "We make them come to us." });
    expect(card.right.label.params).toEqual({ rightLabel: "Go in and take them" });
    expect(card.left.commands).toEqual([
      { kind: "adoptPlan", payload: { planId: "hold-lethal-armed" } },
    ]);
    expect(card.right.commands).toEqual([
      { kind: "adoptPlan", payload: { planId: "assault-lethal-armed" } },
    ]);
    expect(events.filter((e) => e.type === "policyDecisionNeeded")).toHaveLength(1);
    // The kernel raises the hook in phase 8 of the tick the card is queued.
    const hook = test.world.state.narrator.pendingHook;
    expect(hook).toMatchObject({ kind: "policyDecision", context: { decisionId: card.id } });
    expect(card.narratorHookId).toBe(hook?.id);
  });

  it("holds everything while it is up: the hook halt, then the card, with nobody moving", () => {
    const { test } = landed();
    const tick = test.world.state.tick;
    const before = where(test);
    expect(test.kernel.advance(test.world, 100)).toMatchObject({ halt: { kind: "hook" } });
    expect(test.world.state.tick).toBe(tick);
    acknowledge(test);
    // Narrated, the card itself halts the world; the acknowledgement applies with the answer.
    for (let i = 0; i < 3; i++) {
      expect(test.kernel.advance(test.world, 100).halt.kind).toBe("decision");
      expect(test.world.state.tick).toBe(tick);
    }
    expect(where(test)).toEqual(before);
    expect(test.world.state.expedition?.phase).toBe("mustering");
    expect(test.world.state.expedition?.plan).toBeUndefined();
  });

  it.each([
    ["left", "hold-lethal-armed"],
    ["right", "assault-lethal-armed"],
  ] as const)("%s adopts %s at resolve, and the muster begins", (side, planId) => {
    const test = adopted(side);
    const events = step(test, 120 * RATE, () => test.world.state.expedition?.phase !== "mustering");
    const expedition = test.world.state.expedition;
    expect(expedition?.plan).toMatchObject({ id: planId, targetMustLive: true });
    expect(decision(test, expedition?.cards?.arrival)).toMatchObject({
      status: "resolved",
      chosen: side,
    });
    expect(expedition?.party).toHaveLength(5);
    expect(events.some((e) => e.type === "partyMustered")).toBe(true);
    expect(expedition?.phase).not.toBe("mustering");
  });

  it("takes targetMustLive from the errand: unset when it wants the target either way", () => {
    const test = adopted("left", { wants: "either" });
    step(test, 1);
    expect(test.world.state.expedition?.plan?.targetMustLive).toBe(false);
  });

  it("is not queued for a scenarioStartExpedition run, with a plan or without", () => {
    for (const plan of ["assault-lethal-armed", undefined]) {
      const test = siteWorld({ scenario: CREW.scenario8, seed: 3 });
      startExpedition(test, plan);
      step(test, 120 * RATE, () => test.world.state.expedition?.phase === "resolved");
      expect(test.world.state.expedition?.cards).toBeUndefined();
      expect(EXPEDITION_KEYS.flatMap((key) => cards(test, key))).toEqual([]);
    }
  });
});

describe("the arrival card's pair", () => {
  const option = (id: string, available: boolean): PlanOption => ({
    id,
    plan: { ...(DEFAULT_PLANS[0] as PlanOption["plan"]), id },
    available,
    why: "",
  });

  it("is the default pair when both are available, hold first", () => {
    const menu = [
      option("hold-lethal-armed", true),
      option("assault-lethal-armed", true),
      option("x", true),
    ];
    expect(arrivalPair(menu)?.map((o) => o.id)).toEqual([
      "hold-lethal-armed",
      "assault-lethal-armed",
    ]);
  });

  it("is else the first two available, and nothing with fewer", () => {
    const menu = [
      option("hold-lethal-armed", false),
      option("assault-lethal-armed", true),
      option("x", true),
    ];
    expect(arrivalPair(menu)?.map((o) => o.id)).toEqual(["assault-lethal-armed", "x"]);
    expect(arrivalPair(menu.slice(0, 2))).toBeUndefined();
  });
});

describe("the turn card (call 15)", () => {
  it("comes once, the tick of the first break, and pull back withdraws", () => {
    const test = adopted("right");
    const events = toTurnCard(test);
    const expedition = test.world.state.expedition;
    const card = decision(test, expedition?.cards?.turn);
    const broke = events.find((e) => e.type === "combatantBroke");
    expect(broke?.tick).toBe(card.createdTick);
    expect(card.origin).toBe("policy");
    expect(card.jobId).toBeUndefined();
    expect(card.prompt).toMatchObject({
      key: "expedition.turn",
      params: {
        jobId: test.jobId,
        site: SITE.port,
        how: "breaking",
        side: "them",
        speaker: "Jon Reyes",
      },
    });
    expect(card.prompt.params.actorId).toBe(
      broke?.payload && (broke.payload as { actorId: string }).actorId,
    );
    expect(card.left.commands).toEqual([]);
    expect(card.right.commands).toEqual([{ kind: "withdrawParty", payload: {} }]);
    expect(expedition?.phase).toBe("fight");
    acknowledge(test);
    step(test, 5);
    expect(answer(test, card.id, "right").status).toBe("accepted");
    const after = toResolution(test);
    expect(after.filter((e) => e.type === "partyWithdrew")).toHaveLength(1);
    expect(test.world.state.expedition?.withdrawTick).toBeDefined();
    expect(test.world.state.expedition?.outcome).toBe("partyWithdrew");
    expect(cards(test, TURN_PROMPT_KEY)).toHaveLength(1);
  });

  it("press on changes nothing, and it never comes again that expedition", () => {
    const test = adopted("right");
    toTurnCard(test);
    const card = test.world.state.expedition?.cards?.turn;
    acknowledge(test);
    step(test, 5);
    if (card === undefined) throw new Error("no turn card");
    expect(answer(test, card, "left").status).toBe("accepted");
    const after = toResolution(test);
    expect(after.filter((e) => e.type === "combatantBroke").length).toBeGreaterThan(0);
    expect(after.some((e) => e.type === "partyWithdrew")).toBe(false);
    expect(test.world.state.expedition?.phase).toBe("resolved");
    expect(cards(test, TURN_PROMPT_KEY)).toHaveLength(1);
  });
});

describe("targetMustLive (A2)", () => {
  /** The target armed and out for blood, so the party would shoot him if it could. */
  const ARMED_TARGET: readonly SiteCastEntryDef[] = [
    { ...(SITE_CAST[0] as SiteCastEntryDef), arms: "blaster", wants: "blood" },
    ...SITE_CAST.slice(1),
  ];

  function shotsAtTarget(wants: "alive" | "either", seed: number): number {
    const test = siteWorld({ scenario: CREW.scenario8, seed });
    startExpedition(test, undefined, ARMED_TARGET);
    step(test, 1);
    const expedition = test.world.state.expedition;
    if (expedition === undefined) throw new Error("no expedition");
    // As if it had started itself for an errand (only that path carries a jobId).
    expedition.jobId = addErrand(test, { wants });
    sendAs(test, {
      source: "player",
      kind: "adoptPlan",
      payload: { planId: "assault-lethal-armed" },
    });
    const target = Object.values(test.world.state.actors).find(
      (a) => a.combatant?.disposition.part === "target",
    );
    // Unchecked tick by tick: an unshot target makes it a full-length fight (the cost is seconds).
    const events = toResolution(test, 300, false);
    expect(test.world.state.expedition?.phase).toBe("resolved");
    expect(test.world.state.expedition?.plan?.targetMustLive).toBe(wants === "alive");
    return events.filter(
      (e) =>
        e.type === "shotFired" &&
        (e.payload as { atActorId: string; byActorId: string }).atActorId === target?.id &&
        test.world.state.actors[(e.payload as { byActorId: ActorId }).byActorId]?.crew === true,
    ).length;
  }

  it("never fires at a target the errand wants alive, even one armed and out for blood", () => {
    for (const seed of [1, 2, 3]) expect(shotsAtTarget("alive", seed)).toBe(0);
  });

  it("does fire at that target when the errand takes them either way", () => {
    const shots = [1, 2, 3].map((seed) => shotsAtTarget("either", seed));
    expect(shots.some((n) => n > 0)).toBe(true);
  });
});

describe("lifting off after the fight", () => {
  it("refuses a course while the expedition is under way", () => {
    const test = adopted("left");
    step(test, 5);
    expect(test.world.state.expedition?.phase).not.toBe("resolved");
    const course = sendAs(test, {
      source: "player",
      kind: "setCourse",
      payload: { destinationPortId: TINY.port },
    });
    expect(course).toMatchObject({ status: "rejected" });
    expect(JSON.stringify(course)).toContain("an expedition is under way");
  });

  it("takes the cast off the floor the tick a course is planned, so none is carried aboard", () => {
    const test = adopted("left");
    toResolution(test);
    // Settling the errand sets the voyage home, and travel plans the hop once nothing holds her.
    const leaving = () => {
      const travel = test.world.state.travel;
      return travel.stage !== "docked" || travel.plannedDestinationId !== undefined;
    };
    step(test, 60 * RATE, leaving);
    expect(leaving()).toBe(true);
    step(test, 2);
    expect(cast(test)).toEqual([]);
    step(test, 300 * RATE, () => test.world.state.travel.stage === "transit");
    expect(test.world.state.travel.stage).toBe("transit");
    expect(Object.values(test.world.state.actors).filter((a) => !a.crew)).toEqual([]);
  });

  it("puts the ship's arms back in the locker and leaves the cast's on the ground", () => {
    const test = adopted("right");
    const before = lockerWeapons(test.world.state, test.world.content).map((w) => w.itemId);
    expect(before.length).toBeGreaterThan(0);
    const events = toResolution(test);
    events.push(...step(test, 300 * RATE, () => test.world.state.travel.stage === "transit"));
    expect(test.world.state.travel.stage).toBe("transit");
    const after = lockerWeapons(test.world.state, test.world.content).map((w) => w.itemId);
    expect([...after].sort()).toEqual([...before].sort());
    expect(test.world.state.expedition?.arms).toBeUndefined();
    const weapons = Object.values(test.world.state.items).filter(
      (item) => findItemDef(test.world.content, test.world.state, item.defId)?.weapon !== undefined,
    );
    expect(weapons.map((w) => w.id).sort()).toEqual([...before].sort());
    expect(events.filter((e) => e.type === "leftOnDock")).toEqual([]);
  });
});
