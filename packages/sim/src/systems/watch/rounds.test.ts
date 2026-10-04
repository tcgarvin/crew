import { describe, expect, it } from "vitest";
import { dayTicks } from "../../core/clock";
import { isTickerEvent } from "../../core/render";
import type { TileCoord } from "../../core/types/common";
import type { ActorId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import { requestMove } from "../spatial/movement";
import { currentStep } from "../work/activity";
import { JON, MARA, addPumpSymptom, crewWorld, place } from "../work/fixtures/crew-deck";
import { eventsOf, run } from "../work/fixtures/run";
import { ROUNDS_TILES, roundsWorld } from "./fixtures/rounds-deck";
import { ROUNDS_REF } from "./rounds";

const at = (x: number, y: number): TileCoord => ({ x, y });

function actorOf(world: World, id: ActorId) {
  const actor = world.state.actors[id];
  if (actor === undefined) throw new Error(`no actor ${id}`);
  return actor;
}

function tileOf(world: World, id: ActorId): TileCoord {
  const location = world.state.actors[id]?.location;
  if (location?.kind !== "onDeck") throw new Error(`${id} is not on deck`);
  return { x: Math.floor(location.x), y: Math.floor(location.y) };
}

/** Where `id` stood each time a round's stop began, as `{ tick, tile }`. */
function stopRecorder(id: ActorId) {
  const stops: { tick: number; tile: TileCoord }[] = [];
  const watch = (world: World): void => {
    const actor = world.state.actors[id];
    const step = actor === undefined ? undefined : currentStep(actor.activity);
    if (step?.kind === "work" && step.stage === "rounds" && step.ticksDone === 1) {
      stops.push({ tick: world.state.tick, tile: tileOf(world, id) });
    }
  };
  return { stops, watch };
}

const roundStarts = (log: ReturnType<typeof run>, id: ActorId) =>
  eventsOf(log, "personalActivityStarted").filter(
    (e) => e.subjectIds[0] === id && e.payload.activity === "rounds",
  );

describe("the officer of the watch's rounds (D77)", () => {
  it("Mara walks engineering → hold → mess → the helm's standby, ends at the chair, and goes again after the cadence", () => {
    const tw = roundsWorld();
    const { world } = tw;
    actorOf(world, JON).availability = "incapacitated";
    const mara = stopRecorder(MARA);
    const atChairIdle: number[] = [];
    const log = run(tw, 20 * 120, (w) => {
      mara.watch(w);
      const actor = w.state.actors[MARA];
      const t = tileOf(w, MARA);
      if (actor?.activity.kind === "idle" && t.x === 12 && t.y === 2)
        atChairIdle.push(w.state.tick);
      return false;
    });

    // Room centres on this deck: engineering (9,2), the corridor/hold (7,5), the mess (5,2).
    const route = [at(9, 2), at(7, 5), at(5, 2), ROUNDS_TILES.helmStandby];
    expect(mara.stops.slice(0, 4).map((s) => s.tile)).toEqual(route);
    expect(mara.stops.slice(4, 8).map((s) => s.tile)).toEqual(route);
    expect(log.labels[MARA]).toContain("doing rounds");

    // Between the rounds she stands idle on the chair's seat: not a hold, not a task.
    const firstRoundEnd = mara.stops[3]?.tick ?? Number.POSITIVE_INFINITY;
    const secondRound = mara.stops[4]?.tick ?? 0;
    expect(atChairIdle.some((t) => t > firstRoundEnd && t < secondRound)).toBe(true);
    expect(log.labels[MARA]).toContain("walking to bridge");

    // The cadence runs from the start of one round to the start of the next.
    const starts = roundStarts(log, MARA).map((e) => e.tick);
    expect(starts.length).toBeGreaterThanOrEqual(2);
    const cadence = dayTicks(world.config.values, world.config.values.watches.roundsEveryDays);
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(cadence);
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeLessThan(cadence + 40);
  });

  it("spends roundsStopSeconds at each stop", () => {
    const tw = roundsWorld();
    actorOf(tw.world, JON).availability = "incapacitated";
    // Ticks spent on each stop's `rounds` step, keyed by the step's index in the plan.
    const spent = new Map<number, number>();
    run(tw, 20 * 40, (w) => {
      const activity = actorOf(w, MARA).activity;
      const step = currentStep(activity);
      if (activity.kind !== "idle" && step?.kind === "work" && step.stage === "rounds") {
        const index = activity.plan?.stepIndex ?? -1;
        spent.set(index, (spent.get(index) ?? 0) + 1);
      }
      return false;
    });
    // Four stops of 4 s (80 ticks): the 80th finishes the stop and moves the plan on within the
    // tick, so 79 end-of-tick states show it.
    expect([...spent.values()]).toEqual([79, 79, 79, 79]);
  });

  it("notices a machine symptom by walking through engineering", () => {
    const tw = roundsWorld();
    const { world, kernel } = tw;
    actorOf(world, JON).availability = "incapacitated";
    const { problemId } = addPumpSymptom(world);
    const start = run(tw, 40);
    // Her round has begun, but she is not in engineering yet: she does not know.
    expect(roundStarts(start, MARA)).toHaveLength(1);
    expect(
      kernel
        .getAgentView(world, MARA)
        .knownProblems()
        .map((p) => p.id),
    ).not.toContain(problemId);
    const log = run(tw, 20 * 30);
    const observed = eventsOf(log, "problemObserved").find((e) => e.subjectIds[0] === MARA);
    expect(observed?.payload.problemId).toBe(problemId);
  });

  it("shows the officer's rounds on the crew deck (no bridge: the post stands in for the chair)", () => {
    const tw = crewWorld();
    const log = run(tw, 20 * 60);
    expect(log.labels[MARA]).toContain("doing rounds");
  });
});

describe("an engineer's machine round (D77)", () => {
  it("Jon, on duty with nothing to do, visits each engineering machine, and the ticker shows none of it", () => {
    const tw = roundsWorld();
    const { world } = tw;
    actorOf(world, MARA).availability = "incapacitated";
    const jon = stopRecorder(JON);
    const log = run(tw, 20 * 90, (w) => {
      jon.watch(w);
      return false;
    });
    const route = [ROUNDS_TILES.pumpRepair, ROUNDS_TILES.engineService];
    expect(jon.stops.slice(0, 2).map((s) => s.tile)).toEqual(route);
    expect(jon.stops.slice(2, 4).map((s) => s.tile)).toEqual(route);
    expect(log.labels[JON]).toContain("doing rounds");
    const jonsTicker = log.events.filter((e) => e.subjectIds.includes(JON) && isTickerEvent(e));
    expect(jonsTicker).toEqual([]);
    // The cadence is his `rounds` backoff, written as the round was planned.
    expect(world.state.actors[JON]?.workBackoff?.[ROUNDS_REF]).toBeGreaterThan(world.state.tick);
  });

  it("skips a machine whose position someone else holds", () => {
    const tw = roundsWorld();
    const { world } = tw;
    // Mara takes the pump's repair position and stays put (no round, no walk to the chair).
    const mara = actorOf(world, MARA);
    mara.workBackoff = { [ROUNDS_REF]: 1e9, wander: 1e9 };
    place(world, MARA, at(8, 1));
    expect(
      requestMove(world.state, MARA, ROUNDS_TILES.pumpRepair, world.caches, world.config.values),
    ).toBe(true);
    const jon = stopRecorder(JON);
    run(tw, 20 * 30, (w) => {
      jon.watch(w);
      return false;
    });
    expect(tileOf(world, MARA)).toEqual(ROUNDS_TILES.pumpRepair);
    expect(jon.stops.map((s) => s.tile)).toEqual([ROUNDS_TILES.engineService]);
  });

  it("does no rounds off duty", () => {
    const tw = roundsWorld();
    const { world } = tw;
    // The second watch of the 600 s day: alpha (Mara, Jon) is off.
    world.state.tick = 300 * 20;
    const log = run(tw, 20 * 30);
    expect(roundStarts(log, JON)).toEqual([]);
    expect(roundStarts(log, MARA)).toEqual([]);
  });
});
