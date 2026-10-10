/**
 * The recreation lifecycle (slice 4, calls 1, 2 and 4) on the lounge fixture: a host opens a
 * session at the games table, a second joins and it starts, a third who dislikes cards never
 * comes; a session nobody joins collapses to solitaire and the host backs off; a bell takes a
 * player out and a two-hand contest is abandoned; recreation falls by the def's restores only
 * while playing; mood picks solitaire or a hosted game; five would-be hosts race for four seats.
 */
import { describe, expect, it } from "vitest";
import { FIXTURE_ACTIVITIES, FIXTURE_TOPICS } from "../../core/fixtures/ship-life";
import type { TestWorld } from "../../core/fixtures/test-world";
import { tinyEffectiveConfig } from "../../core/fixtures/tiny-content";
import { createKernel } from "../../core/kernel";
import { createRegistry } from "../../core/registry";
import type { ActivityDef } from "../../core/types/content";
import type { SimEvent } from "../../core/types/events";
import type { ActivityDefId, TopicDefId } from "../../core/types/ids";
import type { ActorId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import { registerPlannerDefaults } from "../../planner/index";
import { recreationCandidate } from "../../planner/recreation";
import { registerNeeds } from "../needs/index";
import { registerSpatial } from "../spatial/index";
import { currentStep } from "../work/activity";
import { ALL_DERIVATIONS, CREW, crewConfig, crewContent } from "../work/fixtures/crew-deck";
import { registerWork } from "../work/index";
import {
  ACTIVITY,
  BETTINA,
  DANE,
  JAX,
  LOUNGE,
  LOUNGE_WATCH,
  MARA,
  NOOR,
  TABLE_SEATS,
  TOMAS,
  loungeConfig,
  loungeWorld,
  ofType,
  runFor,
  runUntil,
  secondsOf,
  setCourseAway,
  setMood,
  setNeed,
  tileNow,
} from "./fixtures/lounge-deck";
import { registerRecreation } from "./index";

/** After the first look (everyone knows where things are), nobody bored. */
function looked(options: Parameters<typeof loungeWorld>[0] = {}): TestWorld {
  const fixture = loungeWorld(options);
  runFor(fixture, 1);
  setNeed(fixture.world, "recreation", 0);
  return fixture;
}

const recreating = (world: World, id: ActorId) => {
  const step = currentStep(world.state.actors[id]?.activity ?? { kind: "idle" });
  return step?.kind === "recreate" ? step : undefined;
};

const labelOf = (world: World, id: ActorId): string => {
  const activity = world.state.actors[id]?.activity;
  return activity === undefined || activity.kind === "idle" ? "idle" : (activity.label ?? "");
};

/**
 * The seeded winner of the lounge's first game of cards (weights 1 + interest: Jax 4, Tomas 2).
 * §ambient-chat: a chat's draw on the social stream comes before it, so the pin moved to Jax.
 */
const PINNED_WINNER: ActorId = JAX;

/** A recreation candidate's personal choice, if it is one. */
function chosen(result: ReturnType<typeof recreationCandidate>) {
  if (result === undefined || !("choice" in result)) return undefined;
  return result.choice.kind === "personal" ? result.choice : undefined;
}

const sessions = (world: World) => Object.values(world.state.social.sessions);

const atTable = (world: World, id: ActorId): boolean => {
  const tile = tileNow(world, id);
  return TABLE_SEATS.some((seat) => seat.x === tile.x && seat.y === tile.y);
};

/** A voyage long enough to stand watches at sea (25 distance units at 0.02 a second). */
function seaConfig() {
  const config = loungeConfig();
  return { ...config, travel: { ...config.travel, nominalSpeed: 0.02 } };
}

/** Cards only (and the two solo fixture activities), so nothing else competes for the table. */
const CARDS_ONLY = Object.values(FIXTURE_ACTIVITIES);

describe("a game of cards (call 4)", () => {
  it("the cards-liker hosts at the games table; quiet until a second (a neutral) joins and it starts once", () => {
    const fixture = looked({ activities: CARDS_ONLY });
    const { world } = fixture;
    setNeed(world, "recreation", 0.6, [JAX]);
    const opening = runUntil(fixture, 30, (w) => sessions(w).length > 0);
    const [session] = sessions(world);
    expect(session?.hostId).toBe(JAX);
    expect(session?.activityId).toBe(ACTIVITY.cards);
    expect(session !== undefined && "machineId" in session.venue).toBe(true);
    expect(atTable(world, JAX)).toBe(true);
    // Waiting is trace only: no notable line while the table gathers.
    const waiting = runFor(fixture, 5);
    expect(ofType([...opening, ...waiting], "sessionStarted")).toHaveLength(0);
    expect(labelOf(world, JAX)).toBe("waiting for a game of cards");
    // Tomas has no feeling about cards and a little time on his hands; Dane dislikes cards.
    setNeed(world, "recreation", 0.3, [TOMAS]);
    setNeed(world, "recreation", 0.6, [DANE]);
    const events = runFor(fixture, 40);
    const started = ofType(events, "sessionStarted");
    expect(started).toHaveLength(1);
    expect(started[0]?.payload.memberIds).toEqual([JAX, TOMAS]);
    expect(atTable(world, TOMAS)).toBe(true);
    expect(labelOf(world, JAX)).toBe("playing cards");
    expect(sessions(world)[0]?.members).not.toContain(DANE);
    // The game runs its 0.1 day (60 s) and ends; the third never came.
    const rest = runFor(fixture, 70);
    const ended = ofType(rest, "sessionEnded");
    expect(ended).toHaveLength(1);
    expect(ended[0]?.payload.outcome).toBe("contest");
    expect(
      [...events, ...rest].some((e) => e.type === "sessionJoined" && e.subjectIds.includes(DANE)),
    ).toBe(false);
    expect(sessions(world)).toHaveLength(0);
  });

  it("a session nobody joins collapses at gatherSeconds to solitaire, and the host backs off hosting", () => {
    const fixture = looked({ activities: CARDS_ONLY });
    const { world } = fixture;
    setNeed(world, "recreation", 0.6, [JAX]);
    runUntil(fixture, 30, (w) => sessions(w).length > 0);
    const opened = world.state.tick;
    const events = runUntil(fixture, 40, (w) => sessions(w).length === 0);
    const collapsed = ofType(events, "sessionCollapsed");
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.payload.toSolo).toBe(true);
    expect(world.state.tick - opened).toBeGreaterThanOrEqual(secondsOf(world, 30) - 1);
    expect(ofType(events, "sessionStarted")).toHaveLength(0);
    runFor(fixture, 1);
    const step = recreating(world, JAX);
    expect(step?.role).toBe("solo");
    expect(labelOf(world, JAX)).toBe("playing solitaire");
    const backoff = world.state.actors[JAX]?.workBackoff?.["recreate:activity.cards"];
    const day = world.config.values.time.daySeconds;
    expect(backoff).toBeGreaterThanOrEqual(opened + secondsOf(world, 0.1 * day) - 1);
    // Solitaire plays out its 0.06 day (36 s); he does not host cards again while backing off.
    const after = runFor(fixture, 60);
    expect(ofType(after, "sessionOpened")).toHaveLength(0);
  });

  it("a bell pulls the oncoming stander out mid-game and a two-hand contest ends abandoned", () => {
    const fixture = looked({ activities: CARDS_ONLY, config: seaConfig() });
    const { world } = fixture;
    // At sea the helm is essential work: the oncoming pilot leaves the table for it.
    setCourseAway(fixture);
    runUntil(fixture, 200, (w) => w.state.travel.stage === "transit");
    runUntil(fixture, LOUNGE_WATCH, (w) => w.state.tick >= secondsOf(w, LOUNGE_WATCH - 80));
    setNeed(world, "recreation", 0.6, [JAX]);
    runUntil(fixture, 30, (w) => sessions(w).length > 0);
    setNeed(world, "recreation", 0.6, [TOMAS]);
    const start = runUntil(fixture, 60, (w) => sessions(w)[0]?.startedTick !== undefined);
    expect(ofType(start, "sessionStarted")[0]?.payload.memberIds).toEqual([JAX, TOMAS]);
    const events = runUntil(fixture, 60, (w) => sessions(w).length === 0);
    const left = ofType(events, "sessionLeft");
    expect(left.map((e) => e.payload.actorId)).toEqual([JAX]);
    const ended = ofType(events, "sessionEnded");
    expect(ended).toHaveLength(1);
    expect(ended[0]?.payload.outcome).toBe("abandoned");
    expect(ended[0]?.payload.winnerId).toBeUndefined();
    expect(world.state.tick).toBeLessThan(secondsOf(world, LOUNGE_WATCH));
  });

  it("recreation falls during the game by the def's restores, and not while waiting", () => {
    const fixture = looked({ activities: CARDS_ONLY });
    const { world } = fixture;
    setNeed(world, "recreation", 0.6, [JAX]);
    runUntil(fixture, 30, (w) => sessions(w).length > 0);
    setNeed(world, "recreation", 0.6, [TOMAS]);
    runUntil(fixture, 30, (w) => sessions(w)[0]?.members.length === 2);
    // Gathering: two at the table, waiting for more until the gather timer.
    const jax = () => world.state.actors[JAX]?.needs.recreation ?? Number.NaN;
    const before = jax();
    runFor(fixture, 10);
    expect(jax()).toBeCloseTo(before, 6);
    runUntil(fixture, 40, (w) => sessions(w)[0]?.startedTick !== undefined);
    const atStart = jax();
    runUntil(fixture, 80, (w) => sessions(w).length === 0);
    // Cards restore 0.4 recreation over their 0.1 day.
    expect(atStart - jax()).toBeCloseTo(0.4, 2);
  });

  it("the lounge fixture shows a game start, end, and a collapse in one headless run", () => {
    const fixture = looked({ config: loungeConfig(1.2), activities: CARDS_ONLY });
    const events: SimEvent[] = [];
    setNeed(fixture.world, "recreation", 0.6, [JAX]);
    events.push(...runFor(fixture, 40));
    setNeed(fixture.world, "recreation", 0.6, [JAX, TOMAS]);
    events.push(...runFor(fixture, 250));
    expect(ofType(events, "sessionCollapsed").length).toBeGreaterThanOrEqual(1);
    expect(ofType(events, "sessionStarted").length).toBeGreaterThanOrEqual(1);
    expect(ofType(events, "sessionEnded").some((e) => e.payload.outcome === "contest")).toBe(true);
  });

  it("the game of cards ends with a winner (W2's outcome): wonContest for one, lostContest for the other", () => {
    const fixture = looked({ activities: CARDS_ONLY });
    const { world } = fixture;
    setNeed(world, "recreation", 0.6, [JAX]);
    runUntil(fixture, 30, (w) => sessions(w).length > 0);
    setNeed(world, "recreation", 0.6, [TOMAS]);
    const events = runUntil(fixture, 120, (_w, ev) => ofType(ev, "sessionEnded").length > 0);
    const ended = ofType(events, "sessionEnded")[0];
    expect(ended?.payload.outcome).toBe("contest");
    const winnerId = ended?.payload.winnerId;
    // Seeded: the keen player usually wins (W2 tests that); this seed gives it to Jax.
    expect(winnerId).toBe(PINNED_WINNER);
    const loserId = winnerId === JAX ? TOMAS : JAX;
    const keys = (id: ActorId) => world.state.actors[id]?.thoughts.map((t) => t.key) ?? [];
    expect(keys(winnerId ?? JAX)).toContain("wonContest");
    expect(keys(loserId)).toContain("lostContest");
  });
});

describe("mood (call 2)", () => {
  it("a low-mood person plays solitaire rather than hosting", () => {
    const fixture = looked({ activities: CARDS_ONLY });
    const { world } = fixture;
    setMood(world, JAX, -0.6);
    setNeed(world, "recreation", 0.6, [JAX]);
    const events = runUntil(fixture, 30, (w) => recreating(w, JAX) !== undefined);
    expect(recreating(world, JAX)?.role).toBe("solo");
    runFor(fixture, 5);
    expect(labelOf(world, JAX)).toBe("playing solitaire");
    expect(ofType([...events], "sessionOpened")).toHaveLength(0);
    expect(sessions(world)).toHaveLength(0);
  });

  it("a low-mood person keeps to a book, a high-mood one hosts rather than sitting alone", () => {
    const fixture = looked({ activities: CARDS_ONLY });
    const { world } = fixture;
    // Keen on reading, fond of cards: alone with a book when low... (§choosing-recreation: at an
    // ordinary mood hosting is worth its interest + 1, which ties the book and hosts, so the
    // contrast is drawn from low spirits now, not ordinary ones.)
    const jax = world.state.actors[JAX];
    if (jax === undefined) throw new Error("no Jax");
    jax.interests = { likes: ["reading", "cards"], strong: "reading", dislikes: [] };
    setNeed(world, "recreation", 0.6, [JAX]);
    const view = () => fixture.registry.buildAgentView(world, JAX);
    const config = world.config.values;
    setMood(world, JAX, -0.6);
    const low = recreationCandidate(view(), config);
    expect(low !== undefined && "choice" in low ? low.choice : undefined).toMatchObject({
      activityId: ACTIVITY.reading,
      role: "solo",
    });
    // ...in high spirits, a game.
    setMood(world, JAX, 0.6);
    const high = recreationCandidate(view(), config);
    expect(high !== undefined && "choice" in high ? high.choice : undefined).toMatchObject({
      activityId: ACTIVITY.cards,
      role: "host",
    });
  });
});

describe("four seats, five would-be hosts (the reservation race)", () => {
  it("one game of four starts at the table; the fifth is turned away once", () => {
    const fixture = looked({
      activities: CARDS_ONLY,
      bill: {
        sections: [
          { key: "red", members: [LOUNGE.mara] },
          {
            key: "white",
            members: [LOUNGE.noor, LOUNGE.bettina, LOUNGE.jax, LOUNGE.tomas, LOUNGE.dane],
          },
        ],
        dayworkers: [],
      },
    });
    const { world } = fixture;
    const five = [NOOR, BETTINA, JAX, TOMAS, DANE];
    for (const id of five) {
      const actor = world.state.actors[id];
      if (actor === undefined) throw new Error(`no ${id}`);
      actor.interests = { likes: ["cards"], strong: "cards", dislikes: [] };
    }
    setNeed(world, "recreation", 0.6, five);
    const events = runFor(fixture, 60);
    const started = ofType(events, "sessionStarted");
    expect(started).toHaveLength(1);
    expect(started[0]?.payload.memberIds).toHaveLength(4);
    const opened = ofType(events, "sessionOpened");
    const collapsed = ofType(events, "sessionCollapsed");
    const failed = ofType(events, "actionFailed").filter((e) => e.payload.action === "recreate");
    // The measure the plan asks for: how many tables opened, collapsed and seats lost on the way.
    const players = new Set(started[0]?.payload.memberIds);
    const fifth = five.find((id) => !players.has(id));
    expect(fifth).toBeDefined();
    // Measured: one table, four seats taken without a lost seat on the way (planned walks are
    // spoken for), and the fifth host turned away once (one game of a kind at a time), no
    // second table gathering nobody.
    expect(opened).toHaveLength(1);
    expect(collapsed).toHaveLength(0);
    expect(failed.map((e) => e.subjectIds[0])).toEqual([fifth]);
    expect(failed[0]?.payload.reason).toBe("occupiedPosition");
  });
});

describe("the voyage (calls 2 and 12)", () => {
  it("stargazing is offered in transit and not docked", () => {
    const fixture = looked({ config: seaConfig() });
    const { world } = fixture;
    // Mara is keen on stargazing and fond of reading; off watch once White has the deck.
    runUntil(fixture, LOUNGE_WATCH + 5, (w) => w.state.tick >= secondsOf(w, LOUNGE_WATCH + 2));
    setNeed(world, "recreation", 0.6, [MARA]);
    const docked = recreationCandidate(
      fixture.registry.buildAgentView(world, MARA),
      world.config.values,
    );
    expect(chosen(docked)?.activityId).toBe(ACTIVITY.reading);
    setCourseAway(fixture);
    runUntil(fixture, 200, (w) => w.state.travel.stage === "transit");
    const away = recreationCandidate(
      fixture.registry.buildAgentView(world, MARA),
      world.config.values,
    );
    expect(chosen(away)?.activityId).toBe(ACTIVITY.stargazing);
  });
});

describe("on crewWorld", () => {
  it("a day shows at least one sessionStarted: a debate in the mess, off watch", () => {
    const base = crewConfig();
    const config = { ...base, needs: { ...base.needs, recreationPerDay: 1.2 } };
    const debate: ActivityDef = {
      id: "activity.debate" as ActivityDefId,
      label: "debating",
      waitingLabel: "looking for an argument",
      interest: "debate",
      venue: [{ compartmentTag: "lounge" }, { compartmentTag: "mess" }],
      participants: { min: 2, max: 3 },
      durationDays: 0.06,
      restores: { recreation: 0.3, social: 0.4 },
      outcome: "debate",
      topics: Object.keys(FIXTURE_TOPICS) as TopicDefId[],
    };
    const content = crewContent(config);
    const registry = createRegistry();
    registerSpatial(registry);
    registerNeeds(registry);
    registerRecreation(registry);
    registerWork(registry, { derivations: ALL_DERIVATIONS });
    registerPlannerDefaults(registry);
    const kernel = createKernel(registry);
    const world = kernel.createWorld(
      CREW.scenario2,
      11,
      { ...content, activities: { [debate.id]: debate } },
      tinyEffectiveConfig(config),
    );
    for (const actor of Object.values(world.state.actors)) {
      actor.interests = { likes: ["debate"], strong: "debate", dislikes: [] };
    }
    const events = kernel.advance(world, secondsOf(world, 600)).events;
    const started = ofType(events, "sessionStarted");
    expect(started.length).toBeGreaterThanOrEqual(1);
    expect(started[0]?.payload.activityId).toBe(debate.id);
  });
});
