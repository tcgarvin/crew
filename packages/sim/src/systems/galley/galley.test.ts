/**
 * The galley's rhythm (D81) on the galley fixture: the meal problem before each bell, the cook
 * and her substitute, the mess call, the helm's plate, spoilage, the missed meal, provisions.
 */
import { describe, expect, it } from "vitest";
import { dayTicks, watchTicks } from "../../core/clock";
import { isTickerEvent } from "../../core/render";
import type { SimEvent } from "../../core/types/events";
import type { ActorId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import type { ProblemOfKind } from "../../core/types/work";
import { whoHasTheHelm } from "../watch/helm";
import { MARA as CREW_MARA, crewWorld } from "../work/fixtures/crew-deck";
import {
  BETTINA,
  COUNTER,
  GALLEY,
  GALLEY_WATCH,
  JAX,
  MARA,
  NOOR,
  SEATS,
  STANDBY,
  TOMAS,
  addServing,
  galleyConfig,
  galleyWorld,
  nowSeconds,
  ofType,
  onGalleyDeck,
  runToSecond,
  runUntil,
  secondsOf,
  setCourseAway,
  tileNow,
} from "./fixtures/galley-deck";
import { registerGalley } from "./index";

const mealProblems = (world: World): ProblemOfKind<"mealToCook">[] =>
  Object.values(world.state.work.problems).filter(
    (p): p is ProblemOfKind<"mealToCook"> => p.kind === "mealToCook",
  );

const servingsOnDeck = (world: World) =>
  Object.values(world.state.items).filter((i) => i.meal !== undefined);

/** Who claimed a task of `type`, and when, read the tick each claim is made (tasks are pruned). */
function claimWatcher(type: string) {
  const claims: { actorId: ActorId; tick: number }[] = [];
  const check = (world: World, events: readonly SimEvent[]) => {
    for (const e of ofType(events, "taskClaimed")) {
      if (world.state.work.tasks[e.payload.taskId]?.type !== type) continue;
      claims.push({ actorId: e.subjectIds[0] as ActorId, tick: e.tick });
    }
  };
  return { claims, check };
}

describe("the meal problem (D81)", () => {
  it("opens mealLeadDays before the bell for the coming watch, once", () => {
    const fixture = galleyWorld();
    const { world } = fixture;
    const config = world.config.values;
    const raiseAt = watchTicks(config) - dayTicks(config, config.galley.mealLeadDays);
    runUntil(fixture, GALLEY_WATCH, (w) => w.state.tick >= raiseAt - 1);
    expect(mealProblems(world)).toEqual([]);
    runUntil(fixture, 1, (w) => w.state.tick >= raiseAt);
    const [meal] = mealProblems(world);
    expect(meal).toMatchObject({
      owner: "galley",
      visibility: "public",
      baseUrgency: "routineObligation",
      dedupeKey: "meal:1",
      payload: { watchIndex: 1 },
      createdTick: raiseAt,
    });
    expect(world.state.galley.lastMealWatch).toBe(1);
    runToSecond(fixture, GALLEY_WATCH + 10);
    expect(mealProblems(world)).toHaveLength(1);
  });

  it("is cooked by the cook and served before the bell: one stack, good, known to all", () => {
    const fixture = galleyWorld();
    const { world } = fixture;
    const events = runToSecond(fixture, GALLEY_WATCH);
    const served = ofType(events, "mealServed");
    expect(served).toHaveLength(1);
    expect(served[0]?.payload).toEqual({ cookId: BETTINA, servings: 6, quality: "good" });
    expect(isTickerEvent(served[0] as (typeof events)[number])).toBe(true);
    expect(mealProblems(world)[0]?.status).toBe("resolved");
    const stackId = served[0]?.subjectIds[1];
    for (const actor of Object.values(world.state.actors)) {
      expect(actor.knowledge[`${stackId}/itemLocation`]).toBeDefined();
    }
    const tick = served[0]?.tick ?? 0;
    expect(tick).toBeLessThan(secondsOf(world, GALLEY_WATCH));
  });

  it("the cook cooks the off-watch meal off duty; the bell's meal after is cooked again", () => {
    const fixture = galleyWorld();
    const { world } = fixture;
    // Watch 1 is Bettina's sleep watch, but she is not tired: she is off duty and awake.
    const events = runToSecond(fixture, 2 * GALLEY_WATCH);
    const served = ofType(events, "mealServed");
    expect(served.map((e) => e.payload.cookId)).toEqual([BETTINA, BETTINA]);
    const second = served[1]?.tick ?? 0;
    expect(second).toBeGreaterThan(secondsOf(world, GALLEY_WATCH));
    expect(ofType(events, "mealMissed")).toEqual([]);
  });
});

describe("the substitute (D81 call 3)", () => {
  it("with the cook asleep, Tomas (on duty, cooking 1) cooks after substituteAfterDays: poor", () => {
    const base = galleyConfig();
    const config = {
      ...base,
      needs: { ...base.needs, fatigueRecoveryPerDayAsleep: 0.2, sleepDays: 0.5 },
    };
    const fixture = galleyWorld({ config });
    const { world } = fixture;
    runToSecond(fixture, GALLEY_WATCH + 5);
    const bettina = world.state.actors[BETTINA];
    if (bettina === undefined) throw new Error("no Bettina");
    bettina.needs.fatigue = 0.8;
    runUntil(fixture, 60, (w) => w.state.actors[BETTINA]?.activity.kind === "personal");
    const watcher = claimWatcher("cookMeal");
    const events = runToSecond(fixture, 2 * GALLEY_WATCH, watcher.check);
    const raised = mealProblems(world).find((p) => p.payload.watchIndex === 2);
    if (raised === undefined) throw new Error("no meal raised for watch 2");
    const cooks = watcher.claims;
    expect(cooks.map((c) => c.actorId)).toEqual([TOMAS]);
    const wait = (cooks[0]?.tick ?? 0) - raised.createdTick;
    expect(wait).toBeGreaterThanOrEqual(dayTicks(config, config.galley.substituteAfterDays));
    const served = ofType(events, "mealServed").filter((e) => e.tick > raised.createdTick);
    expect(served.map((e) => e.payload)).toEqual([{ cookId: TOMAS, servings: 6, quality: "poor" }]);
    expect(ofType(events, "wokeUp").filter((e) => e.subjectIds[0] === BETTINA)).toEqual([]);
  });
});

describe("the mess call (D81 call 1)", () => {
  it("the oncoming section eats before the bell, the section on watch after, at the table", () => {
    const fixture = galleyWorld();
    const { world } = fixture;
    const seatOf = new Map<ActorId, { tick: number; seated: boolean; hot: boolean }>();
    runToSecond(fixture, GALLEY_WATCH + 60, (w, tickEvents) => {
      for (const e of ofType(tickEvents, "ateMeal")) {
        const who = e.subjectIds[0] as ActorId;
        if (seatOf.has(who)) continue;
        const tile = tileNow(w, who);
        seatOf.set(who, {
          tick: e.tick,
          seated: SEATS.some((s) => s.x === tile.x && s.y === tile.y),
          hot: !e.payload.ration,
        });
      }
    });
    const bell = secondsOf(world, GALLEY_WATCH);
    // White (Jax, Tomas) stands the next watch: before the bell. Mara is on watch: after.
    for (const id of [JAX, TOMAS]) {
      expect(seatOf.get(id)).toMatchObject({ seated: true, hot: true });
      expect(seatOf.get(id)?.tick).toBeLessThan(bell);
    }
    expect(seatOf.get(MARA)).toMatchObject({ seated: true, hot: true });
    expect(seatOf.get(MARA)?.tick).toBeGreaterThanOrEqual(bell);
  });

  it("the gangway stander comes to dinner and goes back to the gangway", () => {
    const fixture = galleyWorld();
    const { world } = fixture;
    const activityOf = (w: World, id: ActorId) => {
      const a = w.state.actors[id]?.activity;
      return a?.kind === "personal" ? a.activity : a?.kind;
    };
    runUntil(fixture, GALLEY_WATCH, (w) => activityOf(w, NOOR) === "standWatch");
    const events = runToSecond(fixture, GALLEY_WATCH - 5);
    const ate = ofType(events, "ateMeal").filter((e) => e.subjectIds[0] === NOOR);
    expect(ate).toHaveLength(1);
    expect(ate[0]?.payload.ration).toBe(false);
    expect(activityOf(world, NOOR)).toBe("standWatch");
  });

  it("a sleeper is not woken for dinner and eats a hot meal on waking", () => {
    const base = galleyConfig();
    const config = { ...base, needs: { ...base.needs, fatigueRecoveryPerDayAsleep: 0.6 } };
    const fixture = galleyWorld({ config });
    const { world } = fixture;
    const tomas = world.state.actors[TOMAS];
    if (tomas === undefined) throw new Error("no Tomas");
    // Watch 0 is White's sleep watch: past bedtime, Tomas turns in.
    tomas.needs.fatigue = 0.45;
    const events = runToSecond(fixture, GALLEY_WATCH + 60);
    const served = ofType(events, "mealServed")[0]?.tick ?? 0;
    const woke = ofType(events, "wokeUp").filter((e) => e.subjectIds[0] === TOMAS);
    expect(ofType(events, "fellAsleep").some((e) => e.subjectIds[0] === TOMAS)).toBe(true);
    expect(woke[0]?.tick).toBeGreaterThan(served);
    expect(woke[0]?.tick).toBeGreaterThanOrEqual(secondsOf(world, GALLEY_WATCH));
    const ate = ofType(events, "ateMeal").filter((e) => e.subjectIds[0] === TOMAS);
    expect(ate).toHaveLength(1);
    expect(ate[0]?.payload.ration).toBe(false);
    expect(ate[0]?.tick).toBeGreaterThan(woke[0]?.tick ?? 0);
  });
});

describe("rations (D81 call 4)", () => {
  it("with no hot meal, a hungry person eats a ration and thinks ateRationPack", () => {
    const fixture = galleyWorld();
    const { world } = fixture;
    const mara = world.state.actors[MARA];
    if (mara === undefined) throw new Error("no Mara");
    mara.needs.hunger = 0.6;
    const events = runUntil(fixture, 60, (w) =>
      (w.state.actors[MARA]?.thoughts ?? []).some((t) => t.key === "ateRationPack"),
    );
    const ate = ofType(events, "ateMeal").filter((e) => e.subjectIds[0] === MARA);
    expect(ate.map((e) => e.payload)).toEqual([{ nutrition: 0.25, ration: true }]);
  });
});

describe("spoilage (D81 call 7)", () => {
  it("sweeps what is left on the counter mealSpoilDays after the serve", () => {
    // Nobody hungry, so the whole stack is still on the counter when it spoils.
    const base = galleyConfig();
    const fixture = galleyWorld({ config: { ...base, needs: { ...base.needs, hungerPerDay: 0 } } });
    const { world } = fixture;
    const events = runUntil(fixture, GALLEY_WATCH, (w) => servingsOnDeck(w).length > 0);
    const served = ofType(events, "mealServed")[0];
    const stack = servingsOnDeck(world)[0];
    if (served === undefined || stack?.meal === undefined) throw new Error("nothing served");
    expect(stack.meal.spoilsAtTick).toBe(
      served.tick + dayTicks(world.config.values, world.config.values.galley.mealSpoilDays),
    );
    expect(stack.location).toMatchObject({
      kind: "onDeck",
      x: COUNTER.x + 0.5,
      y: COUNTER.y + 0.5,
    });
    const spoilsAt = stack.meal.spoilsAtTick;
    const later = runUntil(fixture, GALLEY_WATCH, (w) => w.state.tick >= spoilsAt);
    const spoiled = ofType(later, "mealSpoiled");
    expect(spoiled).toHaveLength(1);
    expect(spoiled[0]?.tick).toBe(stack.meal.spoilsAtTick);
    expect(spoiled[0]?.payload.count).toBe(6);
    expect(world.state.items[stack.id]).toBeUndefined();
  });
});

describe("the missed meal (D81 call 2)", () => {
  it("with no provisions aboard, the meal is given up at the grace with mealMissed", () => {
    const fixture = galleyWorld({ crates: 0 });
    const { world } = fixture;
    const config = world.config.values;
    const grace = watchTicks(config) + dayTicks(config, config.galley.mealGraceDays);
    const events = runUntil(fixture, GALLEY_WATCH * 2, (w) => w.state.tick >= grace);
    expect(ofType(events, "mealServed")).toEqual([]);
    const missed = ofType(events, "mealMissed");
    expect(missed.map((e) => [e.tick, e.payload.watchIndex])).toEqual([[grace, 1]]);
    expect(isTickerEvent(missed[0] as (typeof events)[number])).toBe(true);
    expect(mealProblems(world)[0]?.status).toBe("cancelled");
  });
});

describe("a dirty galley (D81 call 4)", () => {
  it("lowers the cook's good dinner a step to plain", () => {
    const fixture = galleyWorld();
    const { world } = fixture;
    world.state.dirt.tiers.galley = "dirty";
    const events = runToSecond(fixture, GALLEY_WATCH);
    expect(ofType(events, "mealServed").map((e) => e.payload.quality)).toEqual(["plain"]);
  });
});

describe("the helm's plate (D81 call 5)", () => {
  it("the cook carries a plate to the standby tile and the stander eats it in the seat", () => {
    // An early meal, so the plate is up and eaten well before the oncoming comes to the standby;
    // a slow ship, so the leg (25 units) lasts the watch.
    const base = galleyConfig({ mealLeadDays: 0.2 });
    const config = { ...base, travel: { ...base.travel, nominalSpeed: 25 / 1000 } };
    const fixture = galleyWorld({ config });
    const { world } = fixture;
    setCourseAway(fixture);
    runUntil(fixture, 60, (w) => whoHasTheHelm(w.state, w.content) === NOOR);
    let labelSeen = false;
    let eaten = false;
    const events = runUntil(
      fixture,
      GALLEY_WATCH,
      () => eaten,
      (w, tickEvents) => {
        eaten ||= ofType(tickEvents, "ateMeal").some((e) => e.subjectIds[0] === NOOR);
        expect(whoHasTheHelm(w.state, w.content)).toBe(NOOR);
        const noor = w.state.actors[NOOR]?.activity;
        if (noor?.kind === "task" && noor.label === "at the helm, eating") labelSeen = true;
      },
    );
    const carried = ofType(events, "mealCarried");
    expect(carried.map((e) => e.payload)).toEqual([{ toActorId: NOOR, byActorId: BETTINA }]);
    const ate = ofType(events, "ateMeal").filter((e) => e.subjectIds[0] === NOOR);
    expect(ate.map((e) => e.payload.ration)).toEqual([false]);
    expect(labelSeen).toBe(true);
    expect(ofType(events, "helmUnattended")).toEqual([]);
    const relief = Object.values(world.state.work.problems).filter(
      (p) => p.kind === "stationToStaff" && p.payload.post === "relief",
    );
    expect(relief).toEqual([]);
    expect(tileNow(world, BETTINA)).not.toEqual(STANDBY);
    expect(nowSeconds(world)).toBeLessThan(GALLEY_WATCH - 30);
  });
});

describe("the helm's plate, the counter's last serving (D81 call 5)", () => {
  it("is still carried up when the carrier took the counter's last serving", () => {
    const base = galleyConfig();
    const config = { ...base, travel: { ...base.travel, nominalSpeed: 25 / 1000 } };
    const fixture = galleyWorld({ config, crates: 0 });
    const { world } = fixture;
    setCourseAway(fixture);
    runUntil(fixture, 60, (w) => whoHasTheHelm(w.state, w.content) === NOOR);
    const noor = world.state.actors[NOOR];
    if (noor === undefined) throw new Error("no Noor");
    noor.needs.hunger = 0.4;
    const plate = addServing(world, onGalleyDeck(COUNTER), "good", 1);
    let eaten = false;
    const events = runUntil(
      fixture,
      60,
      () => eaten,
      (_w, tickEvents) => {
        eaten ||= ofType(tickEvents, "ateMeal").some((e) => e.subjectIds[0] === NOOR);
      },
    );
    expect(ofType(events, "mealCarried").map((e) => e.payload)).toEqual([
      { toActorId: NOOR, byActorId: BETTINA },
    ]);
    expect(world.state.items[plate.id]).toBeUndefined();
  });
});

describe("provisions (D81 call 8, through D80's reserveLow)", () => {
  it("says provisionsLow at the serve that takes the crates under lowBelowDays", () => {
    // A crate is a meal and the fixture's day is two watches, so one crate is half a day.
    const config = galleyConfig({ lowBelowDays: 0.5, restockToDays: 4 });
    const fixture = galleyWorld({ config, crates: 1 });
    const events = runToSecond(fixture, GALLEY_WATCH);
    const low = ofType(events, "provisionsLow");
    expect(low).toHaveLength(1);
    expect(low[0]?.payload.crates).toBe(0);
    expect(low[0]?.tick).toBe(ofType(events, "mealServed")[0]?.tick);
  });

  it("under a day of servings the crew buy provisions at the port through buyParts", () => {
    const config = galleyConfig({ lowBelowDays: 1, restockToDays: 4 });
    const fixture = galleyWorld({ config, crates: 0, commerce: true, provisionsStock: 10 });
    const { world } = fixture;
    const reserve = () =>
      Object.values(world.state.work.problems).filter(
        (p): p is ProblemOfKind<"reserveLow"> =>
          p.kind === "reserveLow" && p.payload.itemDefId === GALLEY.provisions,
      );
    runUntil(fixture, 5, () => reserve().length > 0);
    // A crate is a meal and the fixture's day is two watches: four days is eight crates.
    expect(reserve()[0]?.payload.count).toBe(8);
    const events = runUntil(fixture, 120, () => reserve().every((p) => p.status !== "open"));
    const bought = ofType(events, "partsBought");
    expect(bought.map((e) => e.payload.itemDefId)).toEqual([GALLEY.provisions]);
    const crates = Object.values(world.state.items)
      .filter((i) => i.defId === GALLEY.provisions && i.location.kind === "onDeck")
      .reduce((n, i) => n + (i.stacking === "stack" ? i.count : 1), 0);
    expect(crates).toBe(8);
    expect(reserve().map((p) => p.status)).toEqual(["resolved"]);
  });
});

describe("a ship with no stove (the crew deck)", () => {
  it("raises no meal, and the hungry eat rations from the galley counter with ateRationPack", () => {
    const fixture = crewWorld({ extra: registerGalley });
    const { world, kernel } = fixture;
    const mara = world.state.actors[CREW_MARA];
    if (mara === undefined) throw new Error("no Mara");
    mara.needs.hunger = 0.6;
    const events: SimEvent[] = [];
    for (let i = 0; i < secondsOf(world, 600); i++) events.push(...kernel.advance(world, 1).events);
    expect(Object.values(world.state.work.problems).filter((p) => p.owner === "galley")).toEqual(
      [],
    );
    const ate = ofType(events, "ateMeal").filter((e) => e.subjectIds[0] === CREW_MARA);
    expect(ate.length).toBeGreaterThan(0);
    expect(ate.every((e) => e.payload.ration)).toBe(true);
    expect(ofType(events, "thoughtAdded").some((e) => e.payload.key === "ateRationPack")).toBe(
      true,
    );
  });
});
