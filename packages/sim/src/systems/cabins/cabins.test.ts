/**
 * The cabins system (slice 4, call 14): waking thoughts and the no-bunk thought, on the berth
 * deck with the systems a sleeping crew needs.
 */
import { describe, expect, it } from "vitest";
import { newActor } from "../../core/command-handlers";
import { BERTH, BUNKS, CAPTAIN_BED, bedUseTile } from "../../core/fixtures/berth-deck";
import { allocateId } from "../../core/ids";
import type { TileCoord } from "../../core/types/common";
import type { ActorId, CrewDefId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import { isAsleep } from "../work/activity";
import {
  actorNamed,
  actorOf,
  cabinsWorld,
  hasThought,
  place,
  runTicks,
  seconds,
  tileOf,
} from "./fixtures";

const asleep = (world: World, id: ActorId) => isAsleep(actorOf(world, id).activity);

/** Keep `id` tired (so the shift does not wake them) until `release`, then let them wake. */
function holdTired(world: World, id: ActorId, release: () => boolean): () => void {
  return () => {
    actorOf(world, id).needs.fatigue = release() ? 0 : 0.8;
  };
}

/** A passenger standing still where put: awake company nobody plans work for. */
function addPassenger(world: World, tile: TileCoord): ActorId {
  const def = world.content.crew[BERTH.firstOfficer as CrewDefId];
  if (def === undefined) throw new Error("no crew def");
  const id = allocateId(world.state, "actor");
  const actor = newActor(id, def, { kind: "onDeck", deckId: BERTH.deck, x: 0, y: 0 });
  world.state.actors[id] = { ...actor, name: "Pax Ingram", roleTags: [], passenger: true };
  place(world, id, tile);
  world.caches.dirty.inventory = true;
  return id;
}

/** Put `id` to bed from beside it, sleep `sleepSeconds` under `each`, and run until they wake. */
function sleepThrough(
  tw: ReturnType<typeof cabinsWorld>,
  id: ActorId,
  sleepSeconds: number,
  each: (sleptTicks: number) => void = () => {},
): void {
  const { world } = tw;
  actorOf(world, id).needs.fatigue = 0.8;
  runTicks(tw, seconds(world, 60), () => asleep(world, id));
  expect(asleep(world, id)).toBe(true);
  const fellAsleep = world.state.tick;
  const slept = () => world.state.tick - fellAsleep >= seconds(world, sleepSeconds);
  const tired = holdTired(world, id, slept);
  runTicks(
    tw,
    seconds(world, sleepSeconds + 60),
    () => !asleep(world, id),
    () => {
      tired();
      each(world.state.tick - fellAsleep);
    },
  );
  expect(asleep(world, id)).toBe(false);
}

describe("waking thoughts (slice 4, call 14)", () => {
  it("the captain wakes in her own cabin with ownCabin", () => {
    const tw = cabinsWorld();
    const captain = actorNamed(tw.world, "Mara Voss");
    place(tw.world, captain, bedUseTile(CAPTAIN_BED));
    sleepThrough(tw, captain, 70);
    expect(hasThought(tw.world, captain, "ownCabin")).toBe(true);
    expect(hasThought(tw.world, captain, "noisyBunkroom")).toBe(false);
  });

  it("a bunkroom sleeper with someone awake in the room for a minute wakes with noisyBunkroom", () => {
    const tw = cabinsWorld();
    const cook = actorNamed(tw.world, "Bettina Solheim");
    place(tw.world, cook, bedUseTile(BUNKS[0] as string));
    const company = addPassenger(tw.world, { x: 5, y: 3 });
    sleepThrough(tw, cook, 75, () => place(tw.world, company, { x: 5, y: 3 }));
    expect(hasThought(tw.world, cook, "noisyBunkroom")).toBe(true);
    expect(hasThought(tw.world, cook, "ownCabin")).toBe(false);
  });

  it("a passer-by for five seconds does not make the bunkroom noisy", () => {
    const tw = cabinsWorld();
    const cook = actorNamed(tw.world, "Bettina Solheim");
    place(tw.world, cook, bedUseTile(BUNKS[0] as string));
    const passerBy = addPassenger(tw.world, { x: 12, y: 6 });
    const { world } = tw;
    sleepThrough(tw, cook, 75, (slept) => {
      const inRoom = slept >= seconds(world, 10) && slept < seconds(world, 15);
      place(world, passerBy, inRoom ? { x: 5, y: 3 } : { x: 12, y: 6 });
    });
    expect(hasThought(world, cook, "noisyBunkroom")).toBe(false);
  });

  it("gives nothing when the sleep is interrupted rather than slept out", () => {
    const tw = cabinsWorld();
    const { world } = tw;
    const captain = actorNamed(world, "Mara Voss");
    place(world, captain, bedUseTile(CAPTAIN_BED));
    actorOf(world, captain).needs.fatigue = 0.8;
    runTicks(tw, seconds(world, 60), () => asleep(world, captain));
    actorOf(world, captain).needs.hunger = 0.99;
    runTicks(
      tw,
      seconds(world, 30),
      () => !asleep(world, captain),
      holdTired(world, captain, () => false),
    );
    expect(asleep(world, captain)).toBe(false);
    expect(hasThought(world, captain, "ownCabin")).toBe(false);
  });
});

describe("no bunk of my own (slice 4, call 14)", () => {
  it("the crew member left without a bunk gets noBunkOfMyOwn, refreshed, and loses it when a bunk frees", () => {
    const tw = cabinsWorld(BERTH.eleven);
    const { world } = tw;
    const unberthed = actorNamed(world, "Hana Ruiz");
    expect(world.state.berths[unberthed]).toBeUndefined();
    const check = seconds(world, world.config.values.cabins.checkEverySeconds);

    runTicks(tw, check);
    const thought = () => actorOf(world, unberthed).thoughts.find((t) => t.key === "noBunkOfMyOwn");
    expect(thought()).toBeDefined();
    const firstExpiry = thought()?.expiresAtTick ?? 0;
    expect(
      Object.values(world.state.actors).filter((a) => hasThought(world, a.id, "noBunkOfMyOwn")),
    ).toHaveLength(1);

    runTicks(tw, check);
    expect(
      actorOf(world, unberthed).thoughts.filter((t) => t.key === "noBunkOfMyOwn"),
    ).toHaveLength(1);
    expect(thought()?.expiresAtTick).toBe(firstExpiry + check);

    // A bunk frees: Ada leaves the ship for good, and Hana is berthed on the next tick.
    delete world.state.actors[actorNamed(world, "Ada Kim")];
    runTicks(tw, check);
    expect(world.state.berths[unberthed]).toBeDefined();
    expect(thought()).toBeUndefined();
    expect(actorOf(world, unberthed).mood).toBe(0);
  });

  it("spares a passenger with no bed: the thought is the crew's", () => {
    const tw = cabinsWorld(BERTH.eleven);
    const { world } = tw;
    // Two passenger beds and every other bed taken: the third passenger has none.
    const passengers = [13, 14, 15].map((x) => addPassenger(world, { x, y: 6 }));
    runTicks(tw, seconds(world, world.config.values.cabins.checkEverySeconds));
    const third = passengers[2] as ActorId;
    expect(world.state.berths[third]).toBeUndefined();
    expect(passengers.some((id) => hasThought(world, id, "noBunkOfMyOwn"))).toBe(false);
    expect(tileOf(world, third)).toBeDefined();
  });
});
