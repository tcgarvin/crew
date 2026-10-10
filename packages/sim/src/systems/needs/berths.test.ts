import { describe, expect, it } from "vitest";
import { newActor } from "../../core/command-handlers";
import {
  BERTH,
  BUNKROOM_CREW,
  BUNKS,
  CAPTAIN_BED,
  MED_BED,
  PASSENGER_BEDS,
  bedUseTile,
  berthContent,
} from "../../core/fixtures/berth-deck";
import type { TestWorld } from "../../core/fixtures/test-world";
import { tinyConfig, tinyEffectiveConfig } from "../../core/fixtures/tiny-content";
import { allocateId } from "../../core/ids";
import { checkInvariants } from "../../core/invariants";
import { createKernel } from "../../core/kernel";
import { createRegistry } from "../../core/registry";
import { actionLabel } from "../../core/render";
import type { TileCoord } from "../../core/types/common";
import type { ActorId, CrewDefId, ScenarioDefId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import { enumerateCandidates, registerPlannerDefaults } from "../../planner/index";
import { registerSpatial } from "../spatial/index";
import { spatialViolations } from "../spatial/invariants";
import { registerWork } from "../work/index";
import { registerNeeds } from "./index";
import { needsViolations } from "./invariants";

/** Spatial, needs, work and the planner over the berth deck; everyone starts rested. */
function berthWorld(scenario: ScenarioDefId = BERTH.nine): TestWorld {
  const config = tinyConfig();
  const registry = createRegistry();
  registerSpatial(registry);
  registerNeeds(registry);
  registerWork(registry, { derivations: {} });
  registerPlannerDefaults(registry);
  const kernel = createKernel(registry);
  const world = kernel.createWorld(scenario, 5, berthContent(config), tinyEffectiveConfig(config));
  return { registry, kernel, world };
}

/** Step tick by tick with every invariant checked, until `done` or `ticks` run out. */
function runUntil({ kernel, world }: TestWorld, ticks: number, done: () => boolean): void {
  for (let i = 0; i < ticks && !done(); i++) {
    kernel.advance(world, 1);
    const problems = [
      ...checkInvariants(world.state),
      ...spatialViolations(world),
      ...needsViolations(world),
    ];
    if (problems.length > 0) throw new Error(`tick ${world.state.tick}: ${problems.join("; ")}`);
  }
}

const actorNamed = (world: World, name: string): ActorId => {
  const actor = Object.values(world.state.actors).find((a) => a.name === name);
  if (actor === undefined) throw new Error(`no actor ${name}`);
  return actor.id;
};

function actorOf(world: World, id: ActorId) {
  const actor = world.state.actors[id];
  if (actor === undefined) throw new Error(`no actor ${id}`);
  return actor;
}

function place(world: World, id: ActorId, tile: TileCoord): void {
  const actor = actorOf(world, id);
  actor.movement = { kind: "stationary" };
  actor.location = { kind: "onDeck", deckId: BERTH.deck, x: tile.x + 0.5, y: tile.y + 0.5 };
}

function tileOf(world: World, id: ActorId): TileCoord | undefined {
  const location = actorOf(world, id).location;
  if (location.kind !== "onDeck") return undefined;
  return { x: Math.floor(location.x), y: Math.floor(location.y) };
}

const label = (world: World, id: ActorId) =>
  actionLabel(actorOf(world, id), world.state, world.content);

const asleep = (world: World, id: ActorId) => label(world, id).startsWith("asleep");

function addAboard(world: World, defId: CrewDefId, tile: TileCoord, passenger = false): ActorId {
  const def = world.content.crew[defId];
  if (def === undefined) throw new Error(`no crew def ${defId}`);
  const id = allocateId(world.state, "actor");
  const actor = newActor(id, def, {
    kind: "onDeck",
    deckId: BERTH.deck,
    x: tile.x + 0.5,
    y: tile.y + 0.5,
  });
  world.state.actors[id] = passenger ? { ...actor, passenger: true } : actor;
  world.caches.dirty.inventory = true;
  return id;
}

describe("berths as a standing rule (§berth-assignment)", () => {
  it("berths a crew member who joins mid-voyage on the next tick, and frees a leaver's", () => {
    const tw = berthWorld();
    const { world } = tw;
    runUntil(tw, 5, () => false);
    const joiner = addAboard(world, BUNKROOM_CREW[6] as CrewDefId, { x: 14, y: 6 });
    const passenger = addAboard(world, BUNKROOM_CREW[7] as CrewDefId, { x: 15, y: 6 }, true);
    runUntil(tw, 1, () => false);
    expect(world.state.berths[joiner]).toBe(BUNKS[7]);
    expect(world.state.berths[passenger]).toBe(PASSENGER_BEDS[0]);

    delete world.state.actors[passenger];
    runUntil(tw, 1, () => false);
    expect(world.state.berths[passenger]).toBeUndefined();
  });
});

describe("sleeping in one's own berth (§sleeping-in-a-berth)", () => {
  it("walks to her own bunk past a nearer free one", () => {
    const tw = berthWorld();
    const { world } = tw;
    const cook = actorNamed(world, "Bettina Solheim");
    const own = world.state.berths[cook];
    expect(own).toBe(BUNKS[0]);
    // Beside the spare bunk's berth, the far end of the bunkroom from her own.
    place(world, cook, { x: 6, y: 2 });
    actorOf(world, cook).needs.fatigue = 0.8;

    runUntil(tw, 20 * 60, () => asleep(world, cook));
    expect(label(world, cook)).toBe("asleep");
    expect(tileOf(world, cook)).toEqual(bedUseTile(BUNKS[0] as string));
  });

  it("sleeps in the captain's cabin, and the label names it", () => {
    const tw = berthWorld();
    const { world } = tw;
    const captain = actorNamed(world, "Mara Voss");
    place(world, captain, { x: 4, y: 2 });
    actorOf(world, captain).needs.fatigue = 0.8;

    runUntil(tw, 20 * 60, () => asleep(world, captain));
    expect(tileOf(world, captain)).toEqual(bedUseTile(CAPTAIN_BED));
    expect(label(world, captain)).toBe("asleep in the captain's cabin");
  });

  it("puts all nine tired crew to sleep, each in their own berth", () => {
    const tw = berthWorld();
    const { world } = tw;
    const crew = Object.keys(world.state.actors) as ActorId[];
    expect(crew).toHaveLength(9);
    for (const id of crew) actorOf(world, id).needs.fatigue = 0.8;

    runUntil(tw, 20 * 120, () => crew.every((id) => asleep(world, id)));
    for (const id of crew) {
      const berth = world.state.berths[id];
      if (berth === undefined) throw new Error(`${id} has no berth`);
      expect({ id, tile: tileOf(world, id) }).toEqual({ id, tile: bedUseTile(berth) });
    }
  });
});

describe("without a berth (§unberthed-crew)", () => {
  it("sleeps in the unassigned pool, never the nearer medbay bed", () => {
    const tw = berthWorld(BERTH.eleven);
    const { world } = tw;
    const unberthed = actorNamed(world, "Hana Ruiz");
    expect(world.state.berths[unberthed]).toBeUndefined();
    place(world, unberthed, { x: 2, y: 4 });
    actorOf(world, unberthed).needs.fatigue = 0.8;

    runUntil(tw, 20 * 90, () => asleep(world, unberthed));
    expect(label(world, unberthed)).toBe("asleep in the passenger cabin");
    const pool = PASSENGER_BEDS.map((bed) => bedUseTile(bed));
    expect(pool).toContainEqual(tileOf(world, unberthed));
  });

  it("does not sleep at all when every bed is someone's: not theirs, not the medbay's", () => {
    const tw = berthWorld(BERTH.eleven);
    const { world } = tw;
    const unberthed = actorNamed(world, "Hana Ruiz");
    addAboard(world, BUNKROOM_CREW[0] as CrewDefId, { x: 14, y: 6 }, true);
    addAboard(world, BUNKROOM_CREW[1] as CrewDefId, { x: 15, y: 6 }, true);
    place(world, unberthed, { x: 2, y: 4 });
    actorOf(world, unberthed).needs.fatigue = 0.8;
    runUntil(tw, 1, () => false);
    const view = tw.registry.buildAgentView(world, unberthed);
    expect(enumerateCandidates(view, world.config.values).rejected).toContainEqual({
      ref: "sleep",
      reason: "noFreeBed",
    });

    runUntil(tw, 20 * 60, () => asleep(world, unberthed));
    expect(world.state.berths[unberthed]).toBeUndefined();
    expect(asleep(world, unberthed)).toBe(false);
    expect(tileOf(world, unberthed)).not.toEqual(bedUseTile(MED_BED));
  });
});
