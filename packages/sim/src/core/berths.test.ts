import { describe, expect, it } from "vitest";
import { needsViolations } from "../systems/needs/invariants";
import { assignBerths } from "./berths";
import { newActor } from "./command-handlers";
import {
  BERTH,
  BUNKROOM_CREW,
  BUNKS,
  CAPTAIN_BED,
  FO_BED,
  PASSENGER_BEDS,
  berthContent,
} from "./fixtures/berth-deck";
import { TINY, tinyEffectiveConfig } from "./fixtures/tiny-content";
import { allocateId } from "./ids";
import { checkInvariants } from "./invariants";
import { createKernel } from "./kernel";
import { createRegistry } from "./registry";
import type { ContentBundle, CrewDef, DeckDef } from "./types/content";
import type { ActorId, CrewDefId, ScenarioDefId } from "./types/ids";
import type { World } from "./types/kernel";
import type { Job, JobPassage } from "./types/travel";

function berthWorld(scenario: ScenarioDefId = BERTH.nine, content = berthContent()): World {
  return createKernel(createRegistry()).createWorld(scenario, 3, content, tinyEffectiveConfig());
}

const deckOf = (world: World): DeckDef => {
  const deck = world.content.decks[BERTH.deck];
  if (deck === undefined) throw new Error("no berth deck");
  return deck;
};

const actorNamed = (world: World, name: string): ActorId => {
  const actor = Object.values(world.state.actors).find((a) => a.name === name);
  if (actor === undefined) throw new Error(`no actor ${name}`);
  return actor.id;
};

const crewDef = (world: World, id: CrewDefId): CrewDef => {
  const def = world.content.crew[id];
  if (def === undefined) throw new Error(`no crew def ${id}`);
  return def;
};

/** Put a new actor aboard as a narrator spawn or a boarding passenger would (no berth yet). */
function addAboard(world: World, defId: CrewDefId, passenger = false): ActorId {
  const id = allocateId(world.state, "actor");
  const actor = newActor(id, crewDef(world, defId), {
    kind: "onDeck",
    deckId: BERTH.deck,
    x: 15.5,
    y: 6.5,
  });
  world.state.actors[id] = passenger ? { ...actor, passenger: true } : actor;
  return id;
}

/** Mara's def carries the captain's role tag: a passenger is ranked as a passenger regardless. */
const PASSENGER_DEF = TINY.mara;

const violations = (world: World) => [...checkInvariants(world.state), ...needsViolations(world)];

describe("assignBerths (D74)", () => {
  it("berths a crew of nine by rank at world creation: cabins for officers, one bunk spare", () => {
    const world = berthWorld();
    const berths = world.state.berths;
    expect(berths[actorNamed(world, "Mara Voss")]).toBe(CAPTAIN_BED);
    expect(berths[actorNamed(world, "Ines Ward")]).toBe(FO_BED);
    const bunks = Object.values(berths).filter((key) => BUNKS.includes(key));
    expect(bunks.sort()).toEqual(BUNKS.slice(0, 7).sort());
    expect(Object.values(berths)).not.toContain(BUNKS[7]);
    for (const bed of PASSENGER_BEDS) expect(Object.values(berths)).not.toContain(bed);
    expect(Object.keys(berths)).toHaveLength(9);
    expect(violations(world)).toEqual([]);
  });

  it("gives a tenth crew member the spare bunk and an eleventh none, never a passenger bed", () => {
    const world = berthWorld();
    const deck = deckOf(world);
    const tenth = addAboard(world, BUNKROOM_CREW[6] as CrewDefId);
    const eleventh = addAboard(world, BUNKROOM_CREW[7] as CrewDefId);
    assignBerths(world.state, deck, world.content);
    expect(world.state.berths[tenth]).toBe(BUNKS[7]);
    expect(world.state.berths[eleventh]).toBeUndefined();
    expect(violations(world)).toEqual([]);
  });

  it("leaves the eleventh of a scenario crew unberthed and the passenger cabin empty", () => {
    const world = berthWorld(BERTH.eleven);
    const unberthed = Object.keys(world.state.actors).filter(
      (id) => world.state.berths[id as ActorId] === undefined,
    );
    expect(unberthed).toEqual([actorNamed(world, "Hana Ruiz")]);
    for (const bed of PASSENGER_BEDS) expect(Object.values(world.state.berths)).not.toContain(bed);
  });

  it("gives a passenger the passenger cabin and frees it when they leave the ship", () => {
    const world = berthWorld();
    const deck = deckOf(world);
    const passenger = addAboard(world, PASSENGER_DEF, true);
    assignBerths(world.state, deck, world.content);
    expect(world.state.berths[passenger]).toBe(PASSENGER_BEDS[0]);

    // Walking off the ship deletes the passenger (commerce `despawn`).
    delete world.state.actors[passenger];
    assignBerths(world.state, deck, world.content);
    expect(world.state.berths[passenger]).toBeUndefined();
    expect(violations(world)).toEqual([]);
  });

  it("frees the cabin of a passenger left behind ashore, and does not berth them again", () => {
    const world = berthWorld();
    const deck = deckOf(world);
    const passenger = addAboard(world, PASSENGER_DEF, true);
    assignBerths(world.state, deck, world.content);
    expect(world.state.berths[passenger]).toBe(PASSENGER_BEDS[0]);

    const ashore = world.state.actors[passenger];
    if (ashore === undefined) throw new Error("passenger missing");
    ashore.availability = "offShip";
    const jobId = allocateId(world.state, "job");
    // Only the passage matters to the berth rule; the rest of the job is beside the point here.
    const passage: JobPassage = {
      actorId: passenger,
      roundTrip: true,
      leg: "ashore",
      endReason: "leftBehind",
    };
    world.state.jobs[jobId] = { id: jobId, passage } as unknown as Job;
    assignBerths(world.state, deck, world.content);
    assignBerths(world.state, deck, world.content);
    expect(world.state.berths[passenger]).toBeUndefined();
  });

  it("puts a third passenger in the spare bunk once the passenger cabin is full", () => {
    const world = berthWorld();
    const deck = deckOf(world);
    const passengers = [0, 1, 2].map(() => addAboard(world, PASSENGER_DEF, true));
    assignBerths(world.state, deck, world.content);
    expect(passengers.map((id) => world.state.berths[id])).toEqual([
      PASSENGER_BEDS[0],
      PASSENGER_BEDS[1],
      BUNKS[7],
    ]);
  });

  it("releases the berth of someone who dies, and keeps the berth of someone ashore", () => {
    const world = berthWorld();
    const deck = deckOf(world);
    const cook = actorNamed(world, "Bettina Solheim");
    const ines = actorNamed(world, "Ines Ward");
    const ashore = world.state.actors[ines];
    const dead = world.state.actors[cook];
    if (ashore === undefined || dead === undefined) throw new Error("crew missing");
    ashore.availability = "offShip";
    dead.availability = "dead";
    assignBerths(world.state, deck, world.content);
    expect(world.state.berths[cook]).toBeUndefined();
    expect(world.state.berths[ines]).toBe(FO_BED);
  });

  it("is idempotent: a second pass changes nothing", () => {
    const world = berthWorld(BERTH.eleven);
    const before = structuredClone(world.state.berths);
    assignBerths(world.state, deckOf(world), world.content);
    expect(world.state.berths).toEqual(before);
  });

  it("puts the captain in the first free bunk on a ship with no captain's cabin", () => {
    const content = berthContent();
    const deck = content.decks[BERTH.deck] as DeckDef;
    const plain: ContentBundle = {
      ...content,
      decks: {
        [BERTH.deck]: {
          ...deck,
          compartments: deck.compartments.map((c) =>
            c.key === "captainsCabin" ? { ...c, tags: ["cabin"] } : c,
          ),
        },
      },
    };
    const world = berthWorld(BERTH.nine, plain);
    expect(world.state.berths[actorNamed(world, "Mara Voss")]).toBe(BUNKS[0]);
  });

  it("never berths anyone in the medbay bed, even with every other bed taken", () => {
    const world = berthWorld(BERTH.eleven);
    const deck = deckOf(world);
    addAboard(world, PASSENGER_DEF, true);
    addAboard(world, PASSENGER_DEF, true);
    addAboard(world, PASSENGER_DEF, true);
    assignBerths(world.state, deck, world.content);
    expect(Object.values(world.state.berths)).not.toContain("medbay_bed");
    expect(violations(world)).toEqual([]);
  });
});

describe("personal belongings (D74)", () => {
  it("sets the harmonica down in Bettina's locker at tick 0, hers", () => {
    const world = berthWorld();
    const cook = actorNamed(world, "Bettina Solheim");
    const bunk = world.state.berths[cook];
    const locker = deckOf(world).zones.find((z) => z.machineKey === bunk);
    const harmonica = Object.values(world.state.items).find((i) => i.defId === BERTH.harmonica);
    expect(world.state.tick).toBe(0);
    expect(locker).toBeDefined();
    expect(harmonica).toMatchObject({
      ownerId: cook,
      location: {
        kind: "onDeck",
        deckId: BERTH.deck,
        x: (locker?.tiles[0]?.x ?? -1) + 0.5,
        y: (locker?.tiles[0]?.y ?? -1) + 0.5,
      },
    });
  });

  it("puts the captain's photograph in the cabin locker and leaves her rations in hand", () => {
    const world = berthWorld();
    const captain = actorNamed(world, "Mara Voss");
    const photo = Object.values(world.state.items).find((i) => i.defId === BERTH.photograph);
    const rations = Object.values(world.state.items).find((i) => i.defId === TINY.rations);
    expect(photo).toMatchObject({ ownerId: captain, location: { kind: "onDeck", x: 9.5, y: 1.5 } });
    expect(rations?.location).toEqual({ kind: "carriedBy", actorId: captain });
    expect(rations).not.toHaveProperty("ownerId");
  });
});

describe("needsViolations (D74)", () => {
  it("reports a berth that is not a bed placement, and one that is the medbay bed", () => {
    const world = berthWorld();
    const [first, second] = Object.keys(world.state.berths) as ActorId[];
    if (first === undefined || second === undefined) throw new Error("no berths");
    world.state.berths[first] = "nowhere";
    world.state.berths[second] = "medbay_bed";
    expect(needsViolations(world)).toEqual([
      `berths.${first} "nowhere" is no placement on ${BERTH.deck}`,
      `berths.${second} "medbay_bed" is not a bed`,
    ]);
  });
});
