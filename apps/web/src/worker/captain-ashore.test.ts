/**
 * §looking-for-work (Dockside phase 4, design §6.2–6.3, §10) on the real authored bundle with every
 * V1 system: the captain goes ashore to look for work, the `captainAshore` ask is raised the tick
 * they step onto the dock (once per docking), and cards from the port's people are delivered in
 * person: by walking over to someone on the dock and talking, by going out through the gate to
 * someone in the port, or (with the captain aboard) by the speaker walking to the foot of the ramp.
 * Nothing is offered in flight, interruptions and a save mid-walk do not lose a card, and nothing
 * waits forever. Every invariant holds every tick.
 *
 * It lives here, not in `packages/sim`, for the same reason `dockside.test.ts` does: the kernel
 * package may not depend on `@crew/content`.
 */
import type {
  ActorId,
  Command,
  CommandId,
  Decision,
  Kernel,
  NarratorHook,
  PortDefId,
  SimEvent,
  World,
} from "@crew/sim";
import { decisionShownTick, getRenderFrame, isOnDock } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { assertInvariants, captainOf, newGame } from "./testGame";

const HUB = "port.crossroads_hub" as PortDefId;
const KESSLER = "port.kessler_drift" as PortDefId;
const CRATE = "item.crate_general";
const SEED = 20261003;

type Answer = (world: World, hook: NarratorHook) => Omit<Command, "id">[];

let n = 0;

function send(kernel: Kernel, world: World, command: Omit<Command, "id">): void {
  n += 1;
  const result = kernel.enqueueCommand(world, {
    ...command,
    id: `cmd:ashore:${n}` as CommandId,
  } as Command);
  if (result.status !== "accepted") throw new Error(`${command.kind}: ${JSON.stringify(result)}`);
}

/** A narrator `offerJob` from `issuer` at the hub, Hub → Kessler, two crates, surfaced. */
function hubOffer(world: World, issuer: { name: string; role: string }): Omit<Command, "id"> {
  const band = world.config.values.commerce.priceBands.general;
  return {
    source: "narrator",
    kind: "offerJob",
    payload: {
      job: {
        issuer,
        description: { key: "test.job", params: {} },
        fromPortId: HUB,
        toPortId: KESSLER,
        cargo: [{ itemDefId: CRATE as never, count: 2 }],
        pay: Math.ceil(band.min * 25 * 2),
      },
      surface: true,
    },
  };
}

/** Answers `captainAshore` at the hub with one offer from `issuer`; everything else, nothing. */
function offerAtHubFrom(issuer: { name: string; role: string }): Answer {
  return (world, hook) =>
    hook.kind === "captainAshore" && hook.context.portId === HUB ? [hubOffer(world, issuer)] : [];
}

const answerNothing: Answer = () => [];

interface Run {
  events: SimEvent[];
  hooks: { kind: string; tick: number; context: unknown }[];
  /** Each card as it came up: tick, where the ship was, and where the captain stood. */
  cards: {
    tick: number;
    docked: boolean;
    captainOnDock: boolean;
    captainAt: { x: number; y: number };
  }[];
}

/**
 * Advance tick by tick, answering hooks with `answer` and taking the left side of every card,
 * checking every invariant, until `until` holds or `ticks` run out.
 */
function drive(
  kernel: Kernel,
  world: World,
  ticks: number,
  answer: Answer,
  until: (world: World, run: Run) => boolean,
  run: Run = { events: [], hooks: [], cards: [] },
): Run {
  for (let i = 0; i < ticks; i++) {
    const result = kernel.advance(world, 1);
    run.events.push(...result.events);
    assertInvariants(world);
    for (const e of result.events) {
      if (e.type !== "decisionPending") continue;
      const captain = captainOf(world);
      const at = captain.location.kind === "onDeck" ? captain.location : { x: -99, y: -99 };
      run.cards.push({
        tick: e.tick,
        docked: world.state.travel.stage === "docked",
        captainOnDock: isOnDock(world.content, world.state, captain.location),
        captainAt: { x: at.x, y: at.y },
      });
    }
    if (result.halt.kind === "hook") {
      const hook = world.state.narrator.pendingHook;
      if (hook === undefined) throw new Error("hook halt without a pending hook");
      run.hooks.push({ kind: hook.kind, tick: world.state.tick, context: hook.context });
      for (const command of answer(world, hook)) send(kernel, world, command);
      send(kernel, world, {
        source: "system",
        kind: "acknowledgeHook",
        payload: { hookId: hook.id },
      });
    } else if (result.halt.kind === "decision") {
      const head = world.state.decisions.queue[0];
      if (head === undefined) throw new Error("decision halt without a queued decision");
      send(kernel, world, {
        source: "player",
        kind: "resolveDecision",
        payload: { decisionId: head, side: "left" },
      });
    }
    if (until(world, run)) break;
  }
  return run;
}

const ofType = <T extends SimEvent["type"]>(run: Run, type: T) =>
  run.events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

function localNamed(world: World, name: string) {
  return Object.values(world.state.dockside.locals).find((l) => l.name === name);
}

const near = (a: { x: number; y: number }, b: { x: number; y: number }, reach: number) =>
  Math.abs(a.x - b.x) <= reach && Math.abs(a.y - b.y) <= reach;

describe("the captain ashore (§looking-for-work)", { timeout: 30_000 }, () => {
  it("walks down the ramp and asks the narrator the tick they step onto the dock, once", () => {
    const { kernel, world } = newGame(SEED);
    const captain = captainOf(world);
    expect(isOnDock(world.content, world.state, captain.location)).toBe(false);
    const run = drive(kernel, world, 20 * 120, answerNothing, (w) => {
      const c = captainOf(w);
      return w.state.narrator.captainAshoreLastAsk !== undefined && c.activity.kind === "idle";
    });
    const asks = run.hooks.filter((h) => h.kind === "captainAshore");
    expect(asks).toHaveLength(1);
    const [ask] = asks;
    expect(ask?.context).toEqual({ portId: HUB, actorId: captain.id });
    // The log line and the hook share the tick: the one the captain stepped onto the dock.
    const [looking] = ofType(run, "lookingForWork");
    expect(looking?.tick).toBe(ask?.tick);
    expect(looking?.payload.name).toBe(captain.name);
    expect(world.state.narrator.captainAshoreLastAsk).toMatchObject({
      portId: HUB,
      actorId: captain.id,
    });
    // Nothing was on offer: a look round, and back aboard. No second ask, however long.
    const later = drive(kernel, world, 20 * 120, answerNothing, () => false);
    expect(later.hooks.filter((h) => h.kind === "captainAshore")).toEqual([]);
    expect(isOnDock(world.content, world.state, captainOf(world).location)).toBe(false);
  });

  it("says so in the headline while ashore", () => {
    const { kernel, world } = newGame(SEED);
    let seen = "";
    drive(kernel, world, 20 * 60, answerNothing, (w) => {
      const line = getRenderFrame(w).headline;
      if (line.includes("is ashore looking for work")) seen = line;
      return seen !== "";
    });
    expect(seen).toBe(
      `Docked at Crossroads Hub — ${captainOf(world).name} is ashore looking for work`,
    );
  });

  it("sends the first officer when the captain is asleep (D8)", () => {
    const { kernel, world } = newGame(SEED);
    const captain = captainOf(world);
    captain.activity = {
      kind: "personal",
      activity: "sleep",
      urgency: "essentialOperation",
      action: { kind: "sleep", stage: "asleep", progress: 0, startedTick: 0, interruptible: false },
      sinceTick: 0,
    };
    const firstOfficer = Object.values(world.state.actors).find((a) =>
      a.roleTags.includes("firstOfficer"),
    );
    const run = drive(kernel, world, 20 * 120, answerNothing, (w) => {
      return w.state.narrator.captainAshoreLastAsk !== undefined;
    });
    const [ask] = run.hooks.filter((h) => h.kind === "captainAshore");
    expect(firstOfficer).toBeDefined();
    expect(ask?.context).toEqual({ portId: HUB, actorId: firstOfficer?.id });
  });

  it("walks over to a local who has work, talks, and the card comes up there", () => {
    const { kernel, world } = newGame(SEED);
    const hal = localNamed(world, "Hal Petrosyan");
    expect(hal).toBeDefined();
    const run = drive(
      kernel,
      world,
      20 * 180,
      offerAtHubFrom({ name: "Hal Petrosyan", role: "queue clerk" }),
      (_w, r) => r.cards.length > 0,
    );
    const [held] = ofType(run, "cardHeld");
    expect(held?.payload.speaker).toBe("Hal Petrosyan");
    const [talk] = ofType(run, "talkingWith");
    expect(talk?.payload).toMatchObject({ name: captainOf(world).name, withName: "Hal Petrosyan" });
    const [card] = run.cards;
    if (card === undefined || talk === undefined || held === undefined) throw new Error("no card");
    const talkTicks = world.config.values.travel.talkSeconds * world.config.values.time.tickRate;
    expect(card.tick - talk.tick).toBeGreaterThanOrEqual(talkTicks - 1);
    expect(card.docked).toBe(true);
    expect(card.captainOnDock).toBe(true);
    const halNow = localNamed(world, "Hal Petrosyan");
    if (halNow === undefined) throw new Error("Hal left");
    expect(near(card.captainAt, halNow.location, 2)).toBe(true);
    expect(ofType(run, "cardDelivered").map((e) => e.payload.reason)).toEqual(["met"]);
    // The log does not announce the offer before the meeting: the card is its first word.
    expect(ofType(run, "jobOffered")[0]?.significance).toBe("trace");
    // While the card is up the captain is still with Hal, and the headline says so.
    const frame = getRenderFrame(world);
    expect(frame.headline).toBe(
      "Docked at Crossroads Hub — Mara Osei is talking with Hal Petrosyan",
    );
    expect(frame.actors.find((a) => a.name === "Mara Osei")?.actionLabel).toBe(
      "talking with Hal Petrosyan",
    );
    // The client shows (and logs) the card from the meeting, not from when it was held.
    const decision = world.state.decisions.records[held.payload.decisionId];
    expect(decision?.deliveredTick).toBe(card.tick);
    expect(decisionShownTick(decision as Decision)).toBe(card.tick);
    expect(decision?.createdTick).toBeLessThan(card.tick);
  });

  it("goes out through the gate to someone in the port, and the card comes up on the way back", () => {
    const { kernel, world } = newGame(SEED);
    expect(localNamed(world, "Ilse Brandt")).toBeUndefined();
    let wasOut = false;
    const run = drive(
      kernel,
      world,
      20 * 180,
      offerAtHubFrom({ name: "Ilse Brandt", role: "broker" }),
      (w, r) => {
        if (captainOf(w).availability === "offShip") wasOut = true;
        return r.cards.length > 0;
      },
    );
    const [went] = ofType(run, "wentToSee");
    expect(went?.payload.withName).toBe("Ilse Brandt");
    expect(wasOut).toBe(true);
    const [card] = run.cards;
    expect(card?.captainOnDock).toBe(true);
    expect(captainOf(world).availability).toBe("available");
    // Still the captain's card: going ashore does not hand the ship to the first officer.
    const decision = world.state.decisions.records[world.state.decisions.queue[0] as never];
    expect(decision?.perspectiveActorId).toBe(captainOf(world).id);
  });

  it("with the captain aboard, a docked offer's issuer walks to the foot of the ramp", () => {
    const { kernel, world } = newGame(SEED);
    // The docking's ask is spent on nothing, and the captain is back aboard.
    drive(kernel, world, 20 * 120, answerNothing, (w) => {
      const c = captainOf(w);
      return (
        w.state.narrator.captainAshoreLastAsk !== undefined &&
        c.activity.kind !== "personal" &&
        !isOnDock(w.content, w.state, c.location)
      );
    });
    expect(isOnDock(world.content, world.state, captainOf(world).location)).toBe(false);
    // §duty-and-the-sleep-watch: she has the watch and, awake (tiredness waits for the watch's
    // end), would walk her rounds, and her way to the hold runs out of the personnel ramp and along
    // the dock to the cargo ramp while both are down. Hold her rounds so she stays aboard for this
    // case.
    const captain = captainOf(world);
    captain.workBackoff = { ...(captain.workBackoff ?? {}), rounds: Number.MAX_SAFE_INTEGER };
    // A quiet check-in's offer, from someone beyond the gate: they walk in as a visitor.
    send(kernel, world, hubOffer(world, { name: "Ilse Brandt", role: "broker" }));
    const run = drive(kernel, world, 20 * 120, answerNothing, (_w, r) => r.cards.length > 0);
    const [came] = ofType(run, "cameToSee");
    expect(came?.payload).toMatchObject({ name: "Ilse Brandt", fromGate: true });
    const ilse = localNamed(world, "Ilse Brandt");
    expect(ilse?.origin.kind).toBe("visitor");
    const [card] = run.cards;
    expect(card?.captainOnDock).toBe(false);
    expect(ofType(run, "talkingWith")).toEqual([]);
    // She is at the foot of the personnel ramp when the card comes up, and goes back out after.
    const frame = getRenderFrame(world);
    expect(frame.locals.some((l) => l.name === "Ilse Brandt")).toBe(true);
    drive(kernel, world, 20 * 60, answerNothing, (w) => localNamed(w, "Ilse Brandt") === undefined);
    expect(localNamed(world, "Ilse Brandt")).toBeUndefined();
  });

  it("with the captain aboard, a local with work walks over from their post, then goes back", () => {
    const { kernel, world } = newGame(SEED);
    drive(kernel, world, 20 * 120, answerNothing, (w) => {
      const c = captainOf(w);
      return (
        w.state.narrator.captainAshoreLastAsk !== undefined &&
        c.activity.kind !== "personal" &&
        !isOnDock(w.content, w.state, c.location)
      );
    });
    const kiosk = localNamed(world, "Hal Petrosyan")?.location;
    if (kiosk === undefined) throw new Error("Hal is not at the hub");
    const at = { x: kiosk.x, y: kiosk.y };
    send(kernel, world, hubOffer(world, { name: "Hal Petrosyan", role: "queue clerk" }));
    const run = drive(kernel, world, 20 * 120, answerNothing, (_w, r) => r.cards.length > 0);
    expect(ofType(run, "cameToSee")[0]?.payload).toMatchObject({
      name: "Hal Petrosyan",
      fromGate: false,
    });
    const hal = localNamed(world, "Hal Petrosyan");
    if (hal === undefined) throw new Error("Hal left");
    expect(near(hal.location, at, 1.5)).toBe(false);
    drive(kernel, world, 20 * 60, answerNothing, (w) => {
      const l = localNamed(w, "Hal Petrosyan");
      return l !== undefined && l.movement.kind === "stationary" && near(l.location, at, 2);
    });
    expect(near(localNamed(world, "Hal Petrosyan")?.location ?? { x: 0, y: 0 }, at, 2)).toBe(true);
  });

  it("never offers work in flight: no card comes up away from the dock", () => {
    const { kernel, world } = newGame(SEED);
    const run = drive(
      kernel,
      world,
      20 * 600,
      offerAtHubFrom({ name: "Hal Petrosyan", role: "queue clerk" }),
      (w) => w.state.travel.stage === "docked" && w.state.travel.portId === KESSLER,
    );
    expect(run.cards.length).toBeGreaterThan(0);
    expect(run.cards.every((c) => c.docked)).toBe(true);
    // At the destination the command actor goes ashore while the crew unload, and the headline says
    // so over the crate count until they are back. §duty-and-the-sleep-watch: on this seed the
    // captain is asleep when the ship docks (her section's watch has ended), so it is the first
    // officer (D8).
    let seen = "";
    drive(kernel, world, 20 * 120, answerNothing, (w) => {
      const line = getRenderFrame(w).headline;
      if (line.includes("is ashore looking for work")) seen = line;
      return seen !== "";
    });
    const ashore = Object.values(world.state.actors).find(
      (a) => a.activity.kind === "personal" && a.activity.activity === "lookForWork",
    );
    expect(ashore?.roleTags.some((r) => r === "captain" || r === "firstOfficer")).toBe(true);
    expect(seen).toBe(`Docked at Kessler Drift — ${ashore?.name} is ashore looking for work`);
  });

  it("survives a save and restore mid-walk, and the card still comes up in person", () => {
    const { kernel, world } = newGame(SEED);
    const answer = offerAtHubFrom({ name: "Hal Petrosyan", role: "queue clerk" });
    drive(kernel, world, 20 * 180, answer, (w) => {
      const a = captainOf(w).activity;
      return a.kind === "personal" && a.activity === "meetSpeaker";
    });
    expect(world.state.decisions.held).toHaveLength(1);
    const restored = kernel.restore(kernel.serialize(world), world.content);
    expect(restored.state.decisions.held).toEqual(world.state.decisions.held);
    const run = drive(kernel, restored, 20 * 120, answer, (_w, r) => r.cards.length > 0);
    expect(ofType(run, "talkingWith").map((e) => e.payload.withName)).toEqual(["Hal Petrosyan"]);
    expect(ofType(run, "cardDelivered").map((e) => e.payload.reason)).toEqual(["met"]);
  });

  it("sends the first officer on if the captain is taken out mid-walk, and the card still comes", () => {
    const { kernel, world } = newGame(SEED);
    const answer = offerAtHubFrom({ name: "Hal Petrosyan", role: "queue clerk" });
    drive(kernel, world, 20 * 180, answer, (w) => {
      const a = captainOf(w).activity;
      return a.kind === "personal" && a.activity === "meetSpeaker";
    });
    captainOf(world).availability = "incapacitated";
    const run = drive(kernel, world, 20 * 120, answer, (_w, r) => r.cards.length > 0);
    const firstOfficer = Object.values(world.state.actors).find((a) =>
      a.roleTags.includes("firstOfficer"),
    );
    const [talk] = ofType(run, "talkingWith");
    expect(talk?.payload.actorId).toBe(firstOfficer?.id as ActorId);
    expect(run.cards).toHaveLength(1);
  });

  it("brings the card up anyway when nobody can go to meet the speaker", () => {
    const { kernel, world } = newGame(SEED);
    const answer = offerAtHubFrom({ name: "Hal Petrosyan", role: "queue clerk" });
    drive(kernel, world, 20 * 180, answer, (w) => w.state.decisions.held.length > 0);
    for (const actor of Object.values(world.state.actors)) actor.availability = "incapacitated";
    const giveUp = world.config.values.travel.cardDeliveryGiveUpSeconds;
    const run = drive(kernel, world, 20 * (giveUp + 5), answer, (_w, r) => r.cards.length > 0);
    expect(run.cards).toHaveLength(1);
    expect(ofType(run, "cardDelivered").map((e) => e.payload.reason)).toEqual(["gaveUp"]);
  });
});
