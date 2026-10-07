/**
 * The reporting reflex end to end (D94, slice 5 call 12) on the intercom fixture: whoever sees
 * damage on alert walks to the nearest working panel and reports it; the whole crew then hold it
 * as `report` evidence with the witness's observation tick, the problem is public, and nobody
 * reports it again. A dead panel sends the reporter on to the next; off alert nobody reports.
 */
import { describe, expect, it } from "vitest";
import type { SimEvent } from "../../core/types/events";
import type { ActorId } from "../../core/types/ids";
import {
  BETTINA,
  JAX,
  NOOR,
  TOMAS,
  ofType,
  placeOnGalleyDeck,
  runToSecond,
  runUntil,
} from "../galley/fixtures/galley-deck";
import {
  compartmentOf,
  damageMachineByHand,
  intercomWorld,
  knockOut,
  machineByKey,
  panelIn,
  scarByHand,
  soundAlert,
} from "./fixtures";

const SLOW = { timeout: 30_000 };

type Fixture = ReturnType<typeof intercomWorld>;

/** Everyone well away from the galley, the cook at her stove's side. */
function stage(fixture: Fixture): void {
  const { world } = fixture;
  placeOnGalleyDeck(world, BETTINA, { x: 4, y: 2 });
  placeOnGalleyDeck(world, NOOR, { x: 15, y: 0 });
  placeOnGalleyDeck(world, "a3" as ActorId, { x: 14, y: 3 });
  placeOnGalleyDeck(world, JAX, { x: 12, y: 1 });
  placeOnGalleyDeck(world, TOMAS, { x: 16, y: 3 });
}

const reports = (events: readonly SimEvent[]) => ofType(events, "intercomReport");

function startedReporting(events: readonly SimEvent[], actorId: ActorId): boolean {
  return ofType(events, "personalActivityStarted").some(
    (e) => e.subjectIds[0] === actorId && e.payload.activity === "report",
  );
}

/** Run until the first intercom report, returning every event up to it. */
function untilReport(fixture: Fixture, seconds: number): SimEvent[] {
  const seen: SimEvent[] = [];
  runUntil(
    fixture,
    seconds,
    () => reports(seen).length > 0,
    (_world, events) => {
      seen.push(...events);
    },
  );
  return seen;
}

describe("the reporting reflex (D94)", () => {
  it(
    "sends the cook who sees the stove go out to the galley panel, and tells the ship",
    SLOW,
    () => {
      const fixture = intercomWorld();
      const { world } = fixture;
      stage(fixture);
      soundAlert(world);
      const stove = machineByKey(world, "stove");
      const problem = damageMachineByHand(world, stove);
      const startTick = world.state.tick;
      const [report] = reports(untilReport(fixture, 30));
      expect(report?.payload).toEqual({
        actorId: BETTINA,
        panelId: panelIn(world, "galley"),
        compartmentId: compartmentOf(world, "galley"),
        damage: [{ kind: "machine", machineId: stove, out: true }],
      });
      expect((report?.tick ?? Number.POSITIVE_INFINITY) - startTick).toBeLessThan(
        30 * world.config.values.time.tickRate,
      );
      // The engineer on the bridge now knows the stove's problem, as the cook saw it.
      const seen = world.state.actors[BETTINA]?.knowledge[`${problem.id}/problem`];
      const heard = world.state.actors[TOMAS]?.knowledge[`${problem.id}/problem`];
      expect(seen?.evidence).toBe("direct");
      expect(heard).toMatchObject({
        evidence: "report",
        certainty: "reported",
        sourceId: BETTINA,
        observedTick: seen?.observedTick,
        learnedTick: report?.tick,
      });
      expect(world.state.actors[TOMAS]?.knowledge[`${stove}/machineStatus`]).toMatchObject({
        evidence: "report",
        value: { status: "failed" },
      });
      expect(world.state.work.problems[problem.id]?.visibility).toBe("public");
      expect(world.state.alert?.reports).toEqual({
        [compartmentOf(world, "galley")]: report?.tick,
      });
    },
  );

  it("is not repeated by a second witness, nor by the reporter", SLOW, () => {
    const fixture = intercomWorld();
    const { world } = fixture;
    stage(fixture);
    soundAlert(world);
    damageMachineByHand(world, machineByKey(world, "stove"));
    untilReport(fixture, 30);
    placeOnGalleyDeck(world, JAX, { x: 3, y: 2 });
    const after = runToSecond(fixture, world.state.tick / world.config.values.time.tickRate + 40);
    expect(reports(after)).toEqual([]);
    expect(startedReporting(after, JAX)).toBe(false);
    expect(startedReporting(after, BETTINA)).toBe(false);
  });

  it("makes one report of two witnesses who saw the same damage together", SLOW, () => {
    const fixture = intercomWorld();
    const { world } = fixture;
    stage(fixture);
    placeOnGalleyDeck(world, NOOR, { x: 3, y: 3 });
    soundAlert(world);
    damageMachineByHand(world, machineByKey(world, "stove"));
    const events = runToSecond(fixture, 40);
    expect(reports(events)).toHaveLength(1);
  });

  it("names a scar by its room and covers that room for the bridge", SLOW, () => {
    const fixture = intercomWorld();
    const { world } = fixture;
    stage(fixture);
    placeOnGalleyDeck(world, JAX, { x: 9, y: 1 });
    soundAlert(world);
    const problem = scarByHand(world, "mess", { x: 6, y: 1 });
    const [report] = reports(untilReport(fixture, 30));
    expect(report?.payload.actorId).toBe(JAX);
    expect(report?.payload.panelId).toBe(panelIn(world, "mess"));
    expect(report?.payload.damage).toEqual([
      { kind: "scar", compartmentId: compartmentOf(world, "mess") },
    ]);
    expect(world.state.alert?.reports[compartmentOf(world, "mess")]).toBe(report?.tick);
    expect(world.state.work.problems[problem.id]?.visibility).toBe("public");
  });

  it("sends the reporter on to the next panel when the nearest is dead", SLOW, () => {
    const fixture = intercomWorld();
    const { world } = fixture;
    stage(fixture);
    soundAlert(world);
    damageMachineByHand(world, machineByKey(world, "stove"));
    const galleyPanel = panelIn(world, "galley");
    // The panel dies as she sets off for it, so she finds it dead when she gets there.
    runUntil(fixture, 30, (w) => {
      const activity = w.state.actors[BETTINA]?.activity;
      return activity?.kind === "personal" && activity.activity === "report";
    });
    knockOut(world, galleyPanel);
    const events = untilReport(fixture, 40);
    expect(ofType(events, "actionFailed").map((e) => e.subjectIds[0])).toContain(BETTINA);
    const [report] = reports(events);
    expect(report?.payload.actorId).toBe(BETTINA);
    // The airlock's is the nearest of the rest.
    expect(report?.payload.panelId).toBe(panelIn(world, "airlock"));
    expect(world.state.actors[BETTINA]?.knowledge[`${galleyPanel}/machineStatus`]).toMatchObject({
      evidence: "direct",
      value: { status: "failed" },
    });
  });

  it(
    "takes the whole line as dead when a panel has no power, and stops walking to panels",
    SLOW,
    () => {
      const fixture = intercomWorld();
      const { world } = fixture;
      stage(fixture);
      soundAlert(world);
      damageMachineByHand(world, machineByKey(world, "stove"));
      runUntil(fixture, 30, (w) => {
        const activity = w.state.actors[BETTINA]?.activity;
        return activity?.kind === "personal" && activity.activity === "report";
      });
      // The bus goes dark as she sets off: every panel shed, wanted on but with no power.
      const panels = Object.values(world.state.machines).filter((m) =>
        world.content.machines[m.defId]?.tags.includes("comm"),
      );
      for (const panel of panels) {
        panel.actualMode = "off";
        panel.output = 0;
      }
      const events = runToSecond(
        fixture,
        world.state.tick / world.config.values.time.tickRate + 40,
      );
      expect(reports(events)).toEqual([]);
      expect(
        ofType(events, "actionFailed").filter((e) => e.subjectIds[0] === BETTINA),
      ).toHaveLength(1);
      // Slice-5 integration: one dead handset told her the line was down, so she did not tour them.
      expect(startedReporting(events, BETTINA)).toBe(false);
      for (const panel of panels) {
        expect(
          world.state.actors[BETTINA]?.knowledge[`${panel.id}/machineStatus`]?.value,
        ).toMatchObject({ status: "off" });
      }
    },
  );

  it("does not happen off alert", SLOW, () => {
    const fixture = intercomWorld();
    const { world } = fixture;
    stage(fixture);
    const problem = damageMachineByHand(world, machineByKey(world, "stove"));
    const events = runToSecond(fixture, 30);
    expect(world.state.actors[BETTINA]?.knowledge[`${problem.id}/problem`]?.evidence).toBe(
      "direct",
    );
    expect(reports(events)).toEqual([]);
    expect(startedReporting(events, BETTINA)).toBe(false);
    expect(world.state.work.problems[problem.id]?.visibility).toBe("discovered");
  });

  it("leaves damage from before the alert to the crew who already know it", SLOW, () => {
    const fixture = intercomWorld();
    const { world } = fixture;
    stage(fixture);
    damageMachineByHand(world, machineByKey(world, "stove"));
    runToSecond(fixture, 2);
    soundAlert(world);
    const events = runToSecond(fixture, 30);
    expect(reports(events)).toEqual([]);
  });
});
