/**
 * Dockside spike fixture: the 12×8 deck with two ramps in the corridor's south hull, and a
 * hand-built 16×12 dock that wraps the ship's berth and reaches fore of it (negative deck x).
 *
 * Deck (see deck-12x8.ts), with ramps r (cargo, under (2,6)) and p (personnel, under (9,6)):
 *
 *   x 0123456789AB
 *   5 HHHHHHHHHHHH
 *   6 HHrHHHHHHpHH
 *   7 (void: the quay runs under it once docked)
 *
 * Dock, in its own frame. Its berth is an S box (24×14) at (−4,−5): the 12×8 deck lies flush to
 * its south edge and centred, at dock (2,1) (`berthPlacement`), so dock (dx, dy) = deck
 * (dx − 2, dy − 1). The box overhangs this tight map, which the sim allows (content validation
 * would not; this map only has to graft):
 *
 *   dx 0123456789ABCDEF
 *    0 ################   bay wall
 *    1 ..            ##   void under the ship, not walkable
 *    …  (rows 2–6 alike)
 *    7 ..            ##
 *    8 ................   quay, under deck row 7; the ramps land at deck (2,7) and (9,7)
 *    9 ................
 *   10 ......ccc.......   a stack of crates: floor under a blocking prop
 *   11 ................
 *
 * Deck-frame bounds once grafted: x −2..13, y −1..10 (origin (−2, −1), 16×12).
 */
import type { TestWorld } from "../../../core/fixtures/test-world";
import { tinyConfig, tinyEffectiveConfig } from "../../../core/fixtures/tiny-content";
import { createKernel } from "../../../core/kernel";
import { createRegistry } from "../../../core/registry";
import type { TileCoord } from "../../../core/types/common";
import type { ContentBundle, DeckDef, DockDef } from "../../../core/types/content";
import type { DockDefId, DoorId, PortDefId } from "../../../core/types/ids";
import { attachDock } from "../dock";
import { registerSpatial } from "../index";
import { DECK12, deck12Content, doorByKey } from "./deck-12x8";
import { stepChecked } from "./helpers";

export const DOCK = {
  id: "dock.test.quay" as DockDefId,
  /** Deck-frame landing tiles. */
  cargoLanding: { x: 2, y: 7 },
  personnelLanding: { x: 9, y: 7 },
  /** Fore of the ship: negative deck x. */
  foreQuay: { x: -2, y: 3 },
  /** Far side of the crate stack. */
  farQuay: { x: 5, y: 10 },
} as const;

export const QUAY: DockDef = {
  id: DOCK.id,
  portId: "port.test.quayside" as PortDefId,
  name: "Test quay",
  palette: { floor: "#444444", wall: "#222222", accent: "#ffaa00" },
  width: 16,
  height: 12,
  berth: { origin: { x: -4, y: -5 }, sizeClass: "S" },
  legend: { ".": "floor", "#": "wall", " ": "void" },
  posts: [],
  areas: [],
  props: [
    { key: "crates", kind: "crates", rect: { x: 6, y: 10, w: 3, h: 1 }, rot: 0, blocking: true },
  ],
  foreground: [],
  ambience: "A test quay.",
  rows: [
    "################",
    "..            ##",
    "..            ##",
    "..            ##",
    "..            ##",
    "..            ##",
    "..            ##",
    "..            ##",
    "................",
    "................",
    "................",
    "................",
  ],
};

/** The deck with the cargo ramp under (2,6) and the personnel ramp under (9,6). */
export function withRamps(deck: DeckDef): DeckDef {
  const ramp = (key: string, x: number) => ({
    key,
    edge: { x, y: 6, side: "s" as const },
    kind: "ramp" as const,
    powerDomain: "main",
    manualOperationSupported: true,
    initialState: "closed" as const,
  });
  return {
    ...deck,
    doors: [...deck.doors, ramp("cargoRamp", 2), ramp("personnelRamp", 9)],
    docking: {
      cargoRampDoorKey: "cargoRamp",
      personnelRampDoorKey: "personnelRamp",
      cargoTransferTiles: [{ x: 2, y: 6 }],
      personnelTransferTiles: [{ x: 9, y: 6 }],
    },
  };
}

function dockContent(): ContentBundle {
  const base = deck12Content();
  const deck = base.decks[DECK12.deck];
  if (deck === undefined) throw new Error("deck12 content lost its deck");
  return {
    ...base,
    decks: { [DECK12.deck]: withRamps(deck) },
    docks: { [DOCK.id]: QUAY },
    hash: "dock-content-v1",
  };
}

/** The 12×8 deck with ramps, spatial registered, no dock attached yet. Mara = a1, Jon = a2. */
export function rampDeckWorld(): TestWorld {
  const registry = createRegistry();
  registerSpatial(registry);
  const kernel = createKernel(registry);
  const config = tinyConfig();
  const world = kernel.createWorld(DECK12.scenario, 7, dockContent(), tinyEffectiveConfig(config));
  return { registry, kernel, world };
}

/** As `rampDeckWorld`, with the quay attached (ramps still closed). */
export function dockedWorld(): TestWorld {
  const test = rampDeckWorld();
  attachDock(test.world, { dockId: DOCK.id, deckId: DECK12.deck });
  return test;
}

export function rampIds(world: TestWorld["world"]): { cargo: DoorId; personnel: DoorId } {
  return { cargo: doorByKey(world, "cargoRamp"), personnel: doorByKey(world, "personnelRamp") };
}

/** Ask for the ramps as travel does, and step (checked) until they are fully in that state. */
export function setRamps(test: TestWorld, state: "open" | "closed"): void {
  const ids = Object.values(rampIds(test.world));
  for (const id of ids) {
    const door = test.world.state.doors[id];
    if (door === undefined) throw new Error(`no ramp ${id}`);
    door.requestedState = state;
  }
  for (let i = 0; i < 200; i++) {
    if (ids.every((id) => test.world.state.doors[id]?.physicalState === state)) return;
    stepChecked(test, 1);
  }
  throw new Error(`ramps never reached ${state}`);
}

export const tileKey = (t: TileCoord) => `${t.x},${t.y}`;
