/**
 * D72 test fixture: one hand-built dock whose M berth box takes two footprints, a 36×20 deck
 * (the box exactly, Freighter Mk2's size) and a 32×18 deck (Mk1's). Both decks are a room over a
 * two-row corridor, with the ramps in the corridor's south hull at Mk2's and Mk1's ramp columns:
 *
 *   big   36×20: cargo ramp under (13,19), personnel under (34,19)
 *   small 32×18: cargo ramp under (13,17), personnel under (29,17)
 *
 * Dock, 40×25, in its own frame. The M box (36×20) sits at (2,1), all void; a two-column floor
 * margin runs up each side, and four quay rows run under the box:
 *
 *   dx 0  2                                 37 39
 *    0 ########################################   bay wall
 *    1 ..                                    ..   the box: rows 1–20, columns 2–37
 *    …
 *   20 ..                                    ..
 *   21 ........................................   quay, under the box's bottom row
 *   …
 *   24 ........................................
 *
 * `berthPlacement` puts the big deck on the box, at dock (2,1), and the small one centred and
 * flush south, at dock (4,3): its hull meets the quay but not the side margins.
 */
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
import type { ContentBundle, DeckDef, DockDef } from "../../../core/types/content";
import type { ActorId, DeckDefId, DockDefId, ScenarioDefId } from "../../../core/types/ids";
import { registerSpatial } from "../index";

export const BERTH_BOX = {
  dock: "dock.test.berth_box" as DockDefId,
  origin: { x: 2, y: 1 },
  /** The first quay row, dock frame: the box's bottom row + 1. */
  quayRow: 21,
} as const;

/** A footprint docked in the box: its deck, its scenario and where it lands, deck frame. */
export interface Footprint {
  readonly name: "big" | "small";
  readonly deckId: DeckDefId;
  readonly scenario: ScenarioDefId;
  readonly width: number;
  readonly height: number;
  /** Dock tile under deck (0,0). */
  readonly shipAt: TileCoord;
  readonly cargoLanding: TileCoord;
  readonly personnelLanding: TileCoord;
  /** A side-margin tile beside the box, west, deck frame. */
  readonly westMargin: TileCoord;
  /** Edges between ship floor and dock floor that are hull wall (the ramp edges are doors). */
  readonly hullEdges: number;
}

export const BIG: Footprint = {
  name: "big",
  deckId: "deck.test.big" as DeckDefId,
  scenario: "scenario.test.big" as ScenarioDefId,
  width: 36,
  height: 20,
  shipAt: { x: 2, y: 1 },
  cargoLanding: { x: 13, y: 20 },
  personnelLanding: { x: 34, y: 20 },
  westMargin: { x: -2, y: 9 },
  // West and east sides (20 rows each) against the margins, and the 36-tile bottom row against
  // the quay, less its two ramps.
  hullEdges: 20 + 20 + 36 - 2,
};

export const SMALL: Footprint = {
  name: "small",
  deckId: "deck.test.small" as DeckDefId,
  scenario: "scenario.test.small" as ScenarioDefId,
  width: 32,
  height: 18,
  shipAt: { x: 4, y: 3 },
  cargoLanding: { x: 13, y: 18 },
  personnelLanding: { x: 29, y: 18 },
  westMargin: { x: -4, y: 7 },
  // Void box columns separate it from the margins: only the bottom row meets dock floor.
  hullEdges: 32 - 2,
};

export const FOOTPRINTS = [BIG, SMALL] as const;

export const MARA = "a1" as ActorId;

function rampDoor(key: string, x: number, y: number): DeckDef["doors"][number] {
  return {
    key,
    edge: { x, y, side: "s" },
    kind: "ramp",
    powerDomain: "main",
    manualOperationSupported: true,
    initialState: "closed",
  };
}

/** A room over a two-row corridor, ramps in the corridor's south hull. */
function footprintDeck(footprint: Footprint): DeckDef {
  const { deckId, width, height, cargoLanding, personnelLanding } = footprint;
  const bottom = height - 1;
  return {
    id: deckId,
    name: `Test ${footprint.name}`,
    width,
    height,
    tiles: Array.from({ length: height }, (_, y) => (y < height - 2 ? "A" : "H").repeat(width)),
    compartments: [
      { key: "room", symbol: "A", name: "Room", tags: [] },
      { key: "hall", symbol: "H", name: "Corridor", tags: [] },
    ],
    doors: [
      {
        key: "roomDoor",
        edge: { x: 1, y: height - 3, side: "s" },
        kind: "interior",
        manualOperationSupported: true,
        initialState: "open",
      },
      rampDoor("cargoRamp", cargoLanding.x, bottom),
      rampDoor("personnelRamp", personnelLanding.x, bottom),
    ],
    openings: [],
    walls: [],
    machines: [],
    powerDomains: [{ key: "main", name: "Main bus" }],
    zones: [{ key: "stores", name: "Stores", tags: ["cargoStowage"], tiles: [{ x: 0, y: 0 }] }],
    docking: {
      cargoRampDoorKey: "cargoRamp",
      personnelRampDoorKey: "personnelRamp",
      cargoTransferTiles: [{ x: cargoLanding.x, y: bottom }],
      personnelTransferTiles: [{ x: personnelLanding.x, y: bottom }],
    },
    hull: { class: "test_hull", sizeClass: "M" },
    spawnPoints: [{ key: "hallWest", tile: { x: 0, y: bottom }, tags: ["crew"] }],
  };
}

export const BERTH_BOX_DOCK: DockDef = {
  id: BERTH_BOX.dock,
  portId: TINY.port,
  name: "Berth box quay",
  palette: { floor: "#444444", wall: "#222222", accent: "#ffaa00" },
  width: 40,
  height: 25,
  berth: { origin: BERTH_BOX.origin, sizeClass: "M" },
  legend: { ".": "floor", "#": "wall", " ": "void" },
  posts: [],
  areas: [],
  props: [],
  foreground: [],
  ambience: "A test quay with room for two footprints.",
  grime: 0,
  airborneDust: 0,
  rows: [
    "#".repeat(40),
    ...Array.from({ length: 20 }, () => `..${" ".repeat(36)}..`),
    ...Array.from({ length: 4 }, () => ".".repeat(40)),
  ],
};

/** Both decks, the dock, and a one-crew scenario per deck (Mara). */
export function berthBoxContent(): ContentBundle {
  const config = tinyConfig();
  const base = tinyContent(config);
  const scenarioFor = (footprint: Footprint) => ({
    id: footprint.scenario,
    name: `Test ${footprint.name}`,
    deckId: footprint.deckId,
    startPortId: TINY.port,
    crew: [TINY.mara],
    startingMoney: 0,
    startingItems: [],
    initialFaults: [],
  });
  return {
    ...base,
    decks: Object.fromEntries(FOOTPRINTS.map((f) => [f.deckId, footprintDeck(f)])),
    docks: { [BERTH_BOX.dock]: BERTH_BOX_DOCK },
    scenarios: Object.fromEntries(FOOTPRINTS.map((f) => [f.scenario, scenarioFor(f)])),
    hash: "berth-box-v1",
  };
}

/**
 * A world on `footprint`'s deck with spatial registered, docked at the start port (world creation
 * attaches the port's dock), ramps closed.
 */
export function berthBoxWorld(footprint: Footprint): TestWorld {
  const registry = createRegistry();
  registerSpatial(registry);
  const kernel = createKernel(registry);
  const config = tinyConfig();
  const world = kernel.createWorld(
    footprint.scenario,
    7,
    berthBoxContent(),
    tinyEffectiveConfig(config),
  );
  const presence = world.state.deck.dock;
  if (presence?.dockId !== BERTH_BOX.dock || presence.deckId !== footprint.deckId) {
    throw new Error(`world on ${footprint.deckId} did not start docked at ${BERTH_BOX.dock}`);
  }
  return { registry, kernel, world };
}

/** Teleport a stationary actor to a tile centre on `footprint`'s deck (test setup only). */
export function placeOn(
  world: TestWorld["world"],
  footprint: Footprint,
  actorId: ActorId,
  tile: TileCoord,
): void {
  const actor = world.state.actors[actorId];
  if (actor === undefined) throw new Error(`no actor ${actorId}`);
  actor.movement = { kind: "stationary" };
  actor.location = { kind: "onDeck", deckId: footprint.deckId, x: tile.x + 0.5, y: tile.y + 0.5 };
}
