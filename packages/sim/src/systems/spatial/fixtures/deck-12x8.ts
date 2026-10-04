/**
 * Spatial test fixture: a 12×8 deck with three rooms (A, B, C) above a two-row corridor (H),
 * one door from each room into the corridor, and the tiny pump in room C with one interaction
 * position. Built on the kernel's tiny content bundle.
 *
 *   x 0123456789AB
 *   0 AAAABBBBCCCC
 *   1 AAAABBBBC.PC   P = pump footprint (10,1); . = its interaction position (9,1)
 *   2 AAAABBBBCCCC
 *   3 AAAABBBBCCCC
 *   4 AdAABbBBCCcC   d/b/c = door on the south edge of (1,4), (5,4), (10,4)
 *   5 HHHHHHHHHHHH
 *   6 HHHHHHHHHHHH
 *   7 (void)
 *
 * Doors: `doorA` manual only, closed. `doorB` powered by `main`, not manual, closed. `doorC`
 * powered and manual, authored open.
 */
import { tinyTestWorld } from "../../../core/fixtures/test-world";
import type { TestWorld } from "../../../core/fixtures/test-world";
import {
  TINY,
  tinyConfig,
  tinyContent,
  tinyEffectiveConfig,
} from "../../../core/fixtures/tiny-content";
import { createKernel } from "../../../core/kernel";
import { createRegistry } from "../../../core/registry";
import type { TileCoord } from "../../../core/types/common";
import type { ConfigDef, ContentBundle } from "../../../core/types/content";
import type { ActorId, CrewDefId, DeckDefId, DoorId, ScenarioDefId } from "../../../core/types/ids";
import { registerSpatial } from "../index";

export const DECK12 = {
  deck: "deck.test.twelve" as DeckDefId,
  scenario: "scenario.test.twelve" as ScenarioDefId,
  jon: "crew.test.jon" as CrewDefId,
} as const;

export function deck12Content(config: ConfigDef = tinyConfig()): ContentBundle {
  const base = tinyContent(config);
  const mara = base.crew[TINY.mara];
  if (mara === undefined) throw new Error("tiny content lost Mara");
  return {
    ...base,
    decks: {
      [DECK12.deck]: {
        id: DECK12.deck,
        name: "Twelve by eight",
        width: 12,
        height: 8,
        tiles: [
          "AAAABBBBCCCC",
          "AAAABBBBCCCC",
          "AAAABBBBCCCC",
          "AAAABBBBCCCC",
          "AAAABBBBCCCC",
          "HHHHHHHHHHHH",
          "HHHHHHHHHHHH",
          "            ",
        ],
        compartments: [
          { key: "roomA", symbol: "A", name: "Room A", tags: [] },
          { key: "roomB", symbol: "B", name: "Room B", tags: [] },
          { key: "roomC", symbol: "C", name: "Room C", tags: ["engineering"] },
          { key: "hall", symbol: "H", name: "Corridor", tags: [] },
        ],
        doors: [
          {
            key: "doorA",
            edge: { x: 1, y: 4, side: "s" },
            kind: "interior",
            manualOperationSupported: true,
            initialState: "closed",
          },
          {
            key: "doorB",
            edge: { x: 5, y: 4, side: "s" },
            kind: "interior",
            powerDomain: "main",
            manualOperationSupported: false,
            initialState: "closed",
          },
          {
            key: "doorC",
            edge: { x: 10, y: 4, side: "s" },
            kind: "interior",
            powerDomain: "main",
            manualOperationSupported: true,
            initialState: "open",
          },
        ],
        openings: [],
        walls: [],
        machines: [{ key: "pump1", machineDefId: TINY.pump, origin: { x: 10, y: 1 }, rotation: 0 }],
        powerDomains: [{ key: "main", name: "Main bus" }],
        zones: [{ key: "stores", name: "Stores", tags: ["cargoStowage"], tiles: [{ x: 0, y: 0 }] }],
        docking: {
          cargoRampDoorKey: "doorA",
          personnelRampDoorKey: "doorA",
          cargoTransferTiles: [{ x: 0, y: 0 }],
          personnelTransferTiles: [{ x: 0, y: 0 }],
        },
        hull: { class: "test_hull", sizeClass: "S" },
        spawnPoints: [
          { key: "hallWest", tile: { x: 0, y: 5 }, tags: ["crew"] },
          { key: "hallWest2", tile: { x: 0, y: 6 }, tags: ["crew"] },
        ],
      },
    },
    crew: {
      ...base.crew,
      [DECK12.jon]: { ...mara, id: DECK12.jon, name: "Jon Reyes", startingInventory: [] },
    },
    scenarios: {
      [DECK12.scenario]: {
        id: DECK12.scenario,
        name: "Twelve",
        deckId: DECK12.deck,
        startPortId: TINY.port,
        crew: [TINY.mara, DECK12.jon],
        startingMoney: 0,
        startingItems: [],
        initialFaults: [],
      },
    },
    hash: "deck12-content-v1",
  };
}

/** Isolated registry with spatial registered, over the 12×8 deck. Mara = a1, Jon = a2. */
export function deck12World(config: ConfigDef = tinyConfig()): TestWorld {
  const registry = createRegistry();
  registerSpatial(registry);
  const kernel = createKernel(registry);
  const world = kernel.createWorld(
    DECK12.scenario,
    7,
    deck12Content(config),
    tinyEffectiveConfig(config),
  );
  return { registry, kernel, world };
}

/** Tiny-content world (6×4 deck) with spatial registered. */
export function tinySpatialWorld(): TestWorld {
  const registry = createRegistry();
  registerSpatial(registry);
  return tinyTestWorld({ registry });
}

export const MARA = "a1" as ActorId;
export const JON = "a2" as ActorId;

export function doorByKey(world: TestWorld["world"], key: string): DoorId {
  const door = Object.values(world.state.doors).find((d) => d.placementKey === key);
  if (door === undefined) throw new Error(`no door ${key}`);
  return door.id;
}

/** Teleport a stationary actor to a tile centre (test setup only) and refresh indexes. */
export function place(world: TestWorld["world"], actorId: ActorId, tile: TileCoord): void {
  const actor = world.state.actors[actorId];
  if (actor === undefined) throw new Error(`no actor ${actorId}`);
  actor.movement = { kind: "stationary" };
  actor.location = { kind: "onDeck", deckId: DECK12.deck, x: tile.x + 0.5, y: tile.y + 0.5 };
}
