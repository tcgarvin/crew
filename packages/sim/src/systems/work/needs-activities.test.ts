import { describe, expect, it } from "vitest";
import { TINY } from "../../core/fixtures/tiny-content";
import type { JobId } from "../../core/types/ids";
import type { StackItem } from "../../core/types/ship";
import { GALLEY_TILE, JON, MARA, crewWorld, itemAt, place } from "./fixtures/crew-deck";
import { eventsOf, run } from "./fixtures/run";

describe("eating", () => {
  it("walks to the rations, eats for mealDays, hunger drops and the stack loses exactly one", () => {
    const tw = crewWorld();
    const { world } = tw;
    const mara = world.state.actors[MARA];
    if (mara === undefined) throw new Error("no mara");
    place(world, MARA, { x: 1, y: 5 });
    place(world, JON, { x: 11, y: 6 });
    mara.needs.hunger = 0.6;
    const stackId = itemAt(world, TINY.rations);
    const before = (world.state.items[stackId] as StackItem).count;

    const log = run(tw, 20 * 60, (w) => eventsOfWorld(w));
    const ate = eventsOf(log, "ateMeal");
    expect(ate).toHaveLength(1);
    expect(ate[0]?.subjectIds[0]).toBe(MARA);
    expect(mara.needs.hunger).toBeLessThan(0.35);
    expect((world.state.items[stackId] as StackItem).count).toBe(before - 1);
    // She took one ration off the counter stack and ate it in the galley (room B, x 4..7).
    const loc = mara.location;
    expect(loc.kind === "onDeck" && loc.x >= 4 && loc.x < 8 && loc.y < 5).toBe(true);
    expect(world.state.items[stackId]?.location).toMatchObject({
      x: GALLEY_TILE.x + 0.5,
      y: GALLEY_TILE.y + 0.5,
    });
    const labels = log.labels[MARA] ?? [];
    expect(labels).toContain("walking to galley");
    expect(labels).toContain("eating");
    // Meal took at least mealDays.
    const started = log.events.find(
      (e) => e.type === "actionStarted" && e.payload.action === "eat",
    );
    expect(started).toBeDefined();
    expect((ate[0]?.tick ?? 0) - (started?.tick ?? 0)).toBeGreaterThanOrEqual(10 * 20 - 1);
  });

  it("splitting one unit off a stack for hauling keeps the stack's jobId", () => {
    const tw = crewWorld();
    const { world } = tw;
    const mara = world.state.actors[MARA];
    if (mara === undefined) throw new Error("no mara");
    place(world, MARA, { x: 1, y: 5 });
    place(world, JON, { x: 11, y: 6 });
    mara.needs.hunger = 0.6;
    const stackId = itemAt(world, TINY.rations);
    const stack = world.state.items[stackId] as StackItem;
    stack.jobId = "job:test-split" as JobId;

    run(tw, 20 * 60, (w) =>
      Object.values(w.state.items).some(
        (i) => i.id !== stackId && i.location.kind === "carriedBy" && i.location.actorId === MARA,
      ),
    );
    const split = Object.values(world.state.items).find(
      (i) => i.id !== stackId && i.location.kind === "carriedBy" && i.location.actorId === MARA,
    );
    expect(split).toBeDefined();
    expect(split?.jobId).toBe("job:test-split");
  });
});

function eventsOfWorld(world: ReturnType<typeof crewWorld>["world"]): boolean {
  return Object.values(world.state.actors).some((a) => a.id === MARA && a.needs.hunger < 0.35);
}

describe("sleeping", () => {
  it("tired crew reserve different bunks, sleep with label 'asleep', and recover", () => {
    const tw = crewWorld();
    const { world } = tw;
    const mara = world.state.actors[MARA];
    const jon = world.state.actors[JON];
    if (mara === undefined || jon === undefined) throw new Error("no crew");
    place(world, MARA, { x: 1, y: 5 });
    place(world, JON, { x: 2, y: 5 });
    // D77: both are on watch, so only pressing tiredness sends them to bed now.
    mara.needs.fatigue = 0.75;
    jon.needs.fatigue = 0.75;

    const bothAsleep = () =>
      mara.activity.kind === "personal" &&
      jon.activity.kind === "personal" &&
      actionLabelOf(tw, MARA) === "asleep" &&
      actionLabelOf(tw, JON) === "asleep";
    const log = run(tw, 20 * 40, bothAsleep);
    expect(bothAsleep()).toBe(true);
    const tiles = [mara, jon].map((a) =>
      a.location.kind === "onDeck"
        ? `${Math.floor(a.location.x)},${Math.floor(a.location.y)}`
        : "off",
    );
    expect(new Set(tiles).size).toBe(2);
    expect(tiles.every((t) => ["1,1", "2,1", "3,1"].includes(t))).toBe(true);
    expect(eventsOf(log, "fellAsleep")).toHaveLength(2);

    const fatigueBefore = mara.needs.fatigue;
    const rest = run(tw, 20 * 20);
    expect(mara.needs.fatigue).toBeLessThan(fatigueBefore - 0.1);
    expect(rest.labels[MARA]).toEqual(["asleep"]);
  });

  it("wakes after sleepDays once fatigue is below wakeBelow", () => {
    const tw = crewWorld();
    const { world } = tw;
    const mara = world.state.actors[MARA];
    if (mara === undefined) throw new Error("no mara");
    place(world, MARA, { x: 2, y: 2 });
    // D77: off watch (her section stands [0, 300) s), so she turns in at routine tiredness and
    // nothing but `wakeBelow` wakes her.
    world.state.tick = 300 * world.config.values.time.tickRate;
    mara.needs.fatigue = 0.55;
    const log = run(tw, 20 * 120, () => eventsOfTypeSeen(tw, "wokeUp"));
    const slept = eventsOf(log, "fellAsleep")[0];
    const woke = eventsOf(log, "wokeUp")[0];
    expect(slept).toBeDefined();
    expect(woke).toBeDefined();
    expect((woke?.tick ?? 0) - (slept?.tick ?? 0)).toBeGreaterThanOrEqual(60 * 20);
    expect(mara.needs.fatigue).toBeLessThanOrEqual(0.1);
  });
});

function actionLabelOf(tw: ReturnType<typeof crewWorld>, id: typeof MARA): string {
  const actor = tw.world.state.actors[id];
  return actor !== undefined && actor.activity.kind !== "idle"
    ? (actor.activity.label ?? "")
    : "idle";
}

function eventsOfTypeSeen(tw: ReturnType<typeof crewWorld>, type: string): boolean {
  return tw.world.caches.diagnostics.traceEvents.some((e) => e.type === type);
}
