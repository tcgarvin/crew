/**
 * The `recreate` plan (slice 4, calls 12 and 13) on the lounge fixture: the harmonica fetched from
 * its owner's locker, played in the lounge and put back, never anyone else's; a book split off
 * the shelf, read at one's own desk in a cabin or on the lounge floor without one, and put back;
 * an interrupted reader setting the book down where she stands; the plan refused off its voyage
 * stage, under a blocking problem, and for a session that is gone.
 */
import { describe, expect, it } from "vitest";
import type { TestWorld } from "../../core/fixtures/test-world";
import { tickerLine } from "../../core/render";
import type { ActivityDef } from "../../core/types/content";
import type { ActivityDefId, ActorId, ProblemId, SessionId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import type { Item } from "../../core/types/ship";
import type { Intent } from "../../core/types/work";
import { currentStep } from "../work/activity";
import { abortActivity } from "../work/execute";
import {
  ACTIVITY,
  BETTINA,
  BETTINA_LOCKER,
  DANE,
  DESK_SEAT,
  JAX,
  LOUNGE,
  LOUNGE_ACTIVITIES,
  LOUNGE_WATCH,
  MARA,
  SHELF,
  loungeStepCtx,
  loungeWorld,
  runFor,
  runUntil,
  secondsOf,
  setNeed,
  tileNow,
} from "./fixtures/lounge-deck";
import { recreatePlan } from "./plans";

/** Past the first bell: Red (Mara, Noor, Bettina) off watch, nobody bored. */
function redOffWatch(activities?: readonly ActivityDef[]): TestWorld {
  const fixture = loungeWorld(activities === undefined ? {} : { activities });
  runFor(fixture, 1);
  setNeed(fixture.world, "recreation", 0);
  runUntil(fixture, LOUNGE_WATCH + 5, (w) => w.state.tick >= secondsOf(w, LOUNGE_WATCH + 2));
  return fixture;
}

const harmonica = (world: World): Item => {
  const item = Object.values(world.state.items).find((i) => i.defId === LOUNGE.harmonica);
  if (item === undefined) throw new Error("no harmonica");
  return item;
};

const books = (world: World): Item[] =>
  Object.values(world.state.items).filter((i) => i.defId === LOUNGE.book);

const shelfCount = (world: World): number =>
  books(world)
    .filter((i) => i.location.kind === "onDeck")
    .filter((i) => {
      const at = i.location.kind === "onDeck" ? i.location : undefined;
      return SHELF.some(
        (t) => at !== undefined && Math.floor(at.x) === t.x && Math.floor(at.y) === t.y,
      );
    })
    .reduce((sum, i) => sum + (i.stacking === "stack" ? i.count : 1), 0);

const compartmentKeyAt = (world: World, id: ActorId): string | undefined => {
  const tile = tileNow(world, id);
  const symbol = world.content.decks[LOUNGE.deck]?.tiles[tile.y]?.[tile.x];
  return world.content.decks[LOUNGE.deck]?.compartments.find((c) => c.symbol === symbol)?.key;
};

const stepOf = (world: World, id: ActorId) =>
  currentStep(world.state.actors[id]?.activity ?? { kind: "idle" });

function intent(activityId: ActivityDefId, extra: Partial<Intent> = {}) {
  return {
    kind: "personal",
    activity: "recreate",
    activityId,
    urgency: "routineObligation",
    trace: { candidates: 1, chosenReason: "test", rejected: [] },
    ...extra,
  } as Extract<Intent, { kind: "personal" }>;
}

describe("the harmonica (call 13)", () => {
  it("its owner fetches it from her locker, plays in the lounge and puts it back; nobody else picks it up", () => {
    const fixture = redOffWatch();
    const { world } = fixture;
    const item = harmonica(world);
    expect(item.stacking === "unique" ? item.ownerId : undefined).toBe(BETTINA);
    // Dane likes music too, but it is not his to play.
    setNeed(world, "recreation", 0.6, [BETTINA, DANE]);
    let fetched = false;
    let playedIn: string | undefined;
    runUntil(
      fixture,
      150,
      (w) => fetched && w.state.actors[BETTINA]?.activity.kind === "idle",
      (w) => {
        const location = harmonica(w).location;
        if (location.kind === "carriedBy") {
          expect(location.actorId).toBe(BETTINA);
          fetched = true;
        }
        const step = stepOf(w, BETTINA);
        if (step?.kind === "recreate" && playedIn === undefined) {
          expect(step.activityId).toBe(ACTIVITY.music);
          playedIn = compartmentKeyAt(w, BETTINA);
        }
      },
    );
    expect(playedIn).toBe("lounge");
    const back = harmonica(world).location;
    expect(back.kind === "onDeck" && { x: Math.floor(back.x), y: Math.floor(back.y) }).toEqual(
      BETTINA_LOCKER,
    );
  });
});

describe("a solo performance (D84 tuning)", () => {
  it("the harmonica ends with one sessionEnded, a performance on the ticker; a book with none", () => {
    const fixture = redOffWatch();
    const { world } = fixture;
    setNeed(world, "recreation", 0.6, [BETTINA]);
    let played = false;
    // The line is said from where the performer stands, so read it the tick it is emitted.
    let line: string | null | undefined;
    const events = runUntil(
      fixture,
      150,
      (w) => played && w.state.actors[BETTINA]?.activity.kind === "idle",
      (w, fresh) => {
        const step = stepOf(w, BETTINA);
        if (step?.kind === "recreate" && step.activityId === ACTIVITY.music) played = true;
        const ended = fresh.find((e) => e.type === "sessionEnded");
        if (line === undefined && ended !== undefined) line = tickerLine(ended, w.state, w.content);
      },
    );
    const ended = events.filter((e) => e.type === "sessionEnded");
    expect(ended).toHaveLength(1);
    const [performance] = ended;
    if (performance?.type !== "sessionEnded") throw new Error("no performance");
    expect(performance.payload).toMatchObject({
      activityId: ACTIVITY.music,
      outcome: "perform",
      memberIds: [BETTINA],
    });
    // A real id, allocated for the one-person session; it was never a row, so never opened.
    expect(performance.payload.sessionId).toMatch(/^s\d+$/);
    expect(world.state.social.sessions[performance.payload.sessionId]).toBeUndefined();
    expect(events.some((e) => e.type === "sessionOpened" || e.type === "sessionStarted")).toBe(
      false,
    );
    expect(line).toMatch(/^Bettina \w+ played the harmonica in the lounge$/);
    // Reading is solo with outcome `none`: no line (call 18), no id spent.
    const reader = redOffWatch();
    setNeed(reader.world, "recreation", 0.6, [MARA]);
    let read = false;
    const readerEvents = runUntil(
      reader,
      200,
      (w) => read && w.state.actors[MARA]?.activity.kind === "idle",
      (w) => {
        const step = stepOf(w, MARA);
        if (step?.kind === "recreate" && step.activityId === ACTIVITY.reading) read = true;
      },
    );
    expect(read).toBe(true);
    expect(readerEvents.some((e) => e.type === "sessionEnded")).toBe(false);
  });
});

describe("a book (calls 12 and 13)", () => {
  it("a reader with a cabin takes one off the shelf to her own desk, and puts it back", () => {
    const fixture = redOffWatch();
    const { world } = fixture;
    // Mara (captain, cabin with a desk) likes reading; docked, stargazing is not on.
    setNeed(world, "recreation", 0.6, [MARA]);
    let readAt: { x: number; y: number } | undefined;
    let during = Number.NaN;
    runUntil(
      fixture,
      150,
      (w) => readAt !== undefined && w.state.actors[MARA]?.activity.kind === "idle",
      (w) => {
        if (stepOf(w, MARA)?.kind === "recreate" && readAt === undefined) {
          readAt = tileNow(w, MARA);
          during = shelfCount(w);
        }
      },
    );
    expect(readAt).toEqual(DESK_SEAT);
    expect(during).toBe(2);
    expect(shelfCount(world)).toBe(3);
  });

  it("a reader without one reads in the lounge", () => {
    const fixture = redOffWatch();
    const { world } = fixture;
    const jax = world.state.actors[JAX];
    if (jax === undefined) throw new Error("no Jax");
    jax.interests = { likes: ["reading"], strong: "reading", dislikes: [] };
    const { ctx } = loungeStepCtx(world);
    const plan = recreatePlan(ctx, jax, intent(ACTIVITY.reading));
    if (!plan.ok) throw new Error(`blocked: ${plan.reason}`);
    const kinds = plan.plan.steps.map((s) => s.kind);
    expect(kinds).toEqual(["moveTo", "pickUp", "moveTo", "recreate", "moveTo", "putDown"]);
    const venue = plan.plan.steps[2];
    if (venue?.kind !== "moveTo" || "machineId" in venue.target)
      throw new Error("not a floor tile");
    const symbol = world.content.decks[LOUNGE.deck]?.tiles[venue.target.y]?.[venue.target.x];
    expect(symbol).toBe("L");
    const home = plan.plan.steps[4];
    expect(home?.kind === "moveTo" ? home.target : undefined).toEqual(SHELF[0]);
  });

  it("an interrupted reader sets the book down where she stands, and the shelf is one short", () => {
    const fixture = redOffWatch();
    const { world } = fixture;
    setNeed(world, "recreation", 0.6, [MARA]);
    runUntil(fixture, 60, (w) => stepOf(w, MARA)?.kind === "recreate");
    runFor(fixture, 2);
    const mara = world.state.actors[MARA];
    if (mara === undefined) throw new Error("no Mara");
    const { ctx } = loungeStepCtx(world);
    abortActivity(ctx, mara, "interrupted");
    const held = books(world).filter((b) => b.location.kind === "carriedBy");
    expect(held).toHaveLength(0);
    const here = tileNow(world, MARA);
    const dropped = books(world).find(
      (b) =>
        b.location.kind === "onDeck" &&
        Math.floor(b.location.x) === here.x &&
        Math.floor(b.location.y) === here.y,
    );
    expect(dropped).toBeDefined();
    expect(shelfCount(world)).toBe(2);
    // She knows where she left it.
    const fact = dropped === undefined ? undefined : mara.knowledge[`${dropped.id}/itemLocation`];
    expect(fact?.factType).toBe("itemLocation");
  });
});

describe("refusals", () => {
  it("is refused docked for a transit-only activity, and under a blocking problem", () => {
    const baking: ActivityDef = {
      id: "activity.baking" as ActivityDefId,
      label: "baking",
      waitingLabel: "baking",
      interest: "cooking",
      venue: [{ compartmentTag: "lounge" }],
      participants: { min: 1, max: 1 },
      durationDays: 0.05,
      restores: { recreation: 0.35 },
      outcome: "none",
      blockedByProblems: ["mealToCook"],
    };
    const fixture = redOffWatch([...LOUNGE_ACTIVITIES, baking]);
    const { world } = fixture;
    const bettina = world.state.actors[BETTINA];
    if (bettina === undefined) throw new Error("no Bettina");
    const { ctx } = loungeStepCtx(world);
    expect(recreatePlan(ctx, bettina, intent(ACTIVITY.stargazing))).toEqual({
      ok: false,
      reason: "dependencyPending",
    });
    expect(recreatePlan(ctx, bettina, intent(baking.id)).ok).toBe(true);
    world.state.work.problems["p90" as ProblemId] = {
      id: "p90" as ProblemId,
      kind: "mealToCook",
      payload: { watchIndex: 1 },
      owner: "galley",
      visibility: "public",
      dedupeKey: "meal:1",
      status: "open",
      createdTick: world.state.tick,
      revision: 1,
      baseUrgency: "routineObligation",
      location: { kind: "tile", deckId: LOUNGE.deck, x: 3, y: 3 },
    };
    expect(recreatePlan(ctx, bettina, intent(baking.id))).toEqual({
      ok: false,
      reason: "dependencyPending",
    });
  });

  it("a join whose session is gone is occupiedPosition", () => {
    const fixture = redOffWatch();
    const { world } = fixture;
    const bettina = world.state.actors[BETTINA];
    if (bettina === undefined) throw new Error("no Bettina");
    const { ctx } = loungeStepCtx(world);
    const plan = recreatePlan(
      ctx,
      bettina,
      intent(ACTIVITY.cards, { role: "join", sessionId: "s9" as SessionId }),
    );
    expect(plan).toEqual({ ok: false, reason: "occupiedPosition" });
  });
});
