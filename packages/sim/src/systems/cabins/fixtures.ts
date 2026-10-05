/**
 * Test fixture for the cabins (slice 4, W3): the D74 berth deck with a desk in the captain's
 * cabin (none in the first officer's, so both ways of placing a talk are exercised), and the
 * systems a sleeping, talking crew needs: spatial, needs, cabins, work and the planner.
 *
 *   x 0123456789AB
 *   0 llllllll.DFF    D = captain's desk (9,0); its seat is south of it, on the locker tile (9,1)
 *   1 bbbbbbbbBsFF    B = captain's bed (8,1); F = first officer's cabin (no desk)
 *   2 QQQQQQQQut      u = the bed's `use` tile (8,2); t = (9,2)
 *
 * The free captain's-cabin tile nearest the desk is (9,2), where the one called in stands: (8,0)
 * is nearer but boxed in by the bed and the desk, the seat and the bed's `use` tile are
 * interaction positions.
 */
import { BERTH, berthContent } from "../../core/fixtures/berth-deck";
import type { TestWorld } from "../../core/fixtures/test-world";
import { tinyConfig, tinyEffectiveConfig } from "../../core/fixtures/tiny-content";
import { checkInvariants } from "../../core/invariants";
import { createKernel } from "../../core/kernel";
import { createRegistry } from "../../core/registry";
import type { TileCoord } from "../../core/types/common";
import type { ContentBundle, MachineDef } from "../../core/types/content";
import type { SimEvent } from "../../core/types/events";
import type { ActorId, CommandId, MachineDefId, ScenarioDefId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import { registerPlannerDefaults } from "../../planner/index";
import { registerNeeds } from "../needs/index";
import { needsViolations } from "../needs/invariants";
import { registerSpatial } from "../spatial/index";
import { spatialViolations } from "../spatial/invariants";
import { registerWork } from "../work/index";
import { registerCabins } from "./index";

export const CABIN_DESK = {
  def: "machine.test.desk" as MachineDefId,
  tile: { x: 9, y: 0 } as TileCoord,
  seat: { x: 9, y: 1 } as TileCoord,
  /** The free captain's-cabin tile nearest the desk: where the one called in stands. */
  standing: { x: 9, y: 2 } as TileCoord,
};

const deskDef: MachineDef = {
  id: CABIN_DESK.def,
  name: "Desk",
  tags: ["desk"],
  footprint: [{ x: 0, y: 0 }],
  interactionPositions: [{ key: "seat", offset: { x: 0, y: 1 }, purposes: ["use"], capacity: 1 }],
  power: { role: "none" },
  heat: { risePerSecond: 0, coolPerSecond: 0, derateAbove: 1 },
  operation: { requiresOperator: false },
  failure: { baseHazardPerSecond: 0, heatFactor: 0, wearPerSecond: 0 },
  faults: [],
  components: [],
};

/** The berth deck with the captain's desk (and her locker zone left where it was). */
export function cabinsContent(): ContentBundle {
  const base = berthContent(tinyConfig());
  const deck = base.decks[BERTH.deck];
  if (deck === undefined) throw new Error("berth content lost its deck");
  return {
    ...base,
    decks: {
      [BERTH.deck]: {
        ...deck,
        machines: [
          ...deck.machines,
          {
            key: "captain_desk",
            machineDefId: CABIN_DESK.def,
            origin: CABIN_DESK.tile,
            rotation: 0,
          },
        ],
      },
    },
    machines: { ...base.machines, [CABIN_DESK.def]: deskDef },
    hash: "cabins-deck-v1",
  };
}

/** Spatial, needs, cabins, work and the planner over `content` (the cabins deck by default). */
export function cabinsWorld(
  scenario: ScenarioDefId = BERTH.nine,
  content: ContentBundle = cabinsContent(),
): TestWorld {
  const registry = createRegistry();
  registerSpatial(registry);
  registerNeeds(registry);
  registerCabins(registry);
  registerWork(registry, { derivations: {} });
  registerPlannerDefaults(registry);
  const kernel = createKernel(registry);
  const world = kernel.createWorld(scenario, 5, content, tinyEffectiveConfig(tinyConfig()));
  return { registry, kernel, world };
}

/**
 * Step tick by tick with every invariant checked (acknowledging any hook), calling `each` before
 * every tick, until `done` (given the events so far) or `ticks` run out. Returns the events.
 */
export function runTicks(
  { kernel, world }: TestWorld,
  ticks: number,
  done: (events: readonly SimEvent[]) => boolean = () => false,
  each: () => void = () => {},
): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < ticks && !done(events); i++) {
    each();
    const result = kernel.advance(world, 1);
    events.push(...result.events);
    const hookId = world.state.narrator.pendingHook?.id;
    if (result.halt.kind === "hook" && hookId !== undefined) {
      kernel.enqueueCommand(world, {
        id: `cmd:ack:${hookId}` as CommandId,
        source: "system",
        kind: "acknowledgeHook",
        payload: { hookId },
      });
    }
    const problems = [
      ...checkInvariants(world.state),
      ...spatialViolations(world),
      ...needsViolations(world),
    ];
    if (problems.length > 0) throw new Error(`tick ${world.state.tick}: ${problems.join("; ")}`);
  }
  return events;
}

export const seconds = (world: World, s: number): number =>
  Math.round(s * world.config.values.time.tickRate);

export function actorNamed(world: World, name: string): ActorId {
  const actor = Object.values(world.state.actors).find((a) => a.name === name);
  if (actor === undefined) throw new Error(`no actor ${name}`);
  return actor.id;
}

export function actorOf(world: World, id: ActorId) {
  const actor = world.state.actors[id];
  if (actor === undefined) throw new Error(`no actor ${id}`);
  return actor;
}

/** Teleport a stationary actor to a tile centre on the berth deck (setup only). */
export function place(world: World, id: ActorId, tile: TileCoord): void {
  const actor = actorOf(world, id);
  actor.movement = { kind: "stationary" };
  actor.location = { kind: "onDeck", deckId: BERTH.deck, x: tile.x + 0.5, y: tile.y + 0.5 };
}

export function tileOf(world: World, id: ActorId): TileCoord | undefined {
  const location = actorOf(world, id).location;
  if (location.kind !== "onDeck") return undefined;
  return { x: Math.floor(location.x), y: Math.floor(location.y) };
}

export const hasThought = (world: World, id: ActorId, key: string): boolean =>
  actorOf(world, id).thoughts.some((thought) => thought.key === key);
