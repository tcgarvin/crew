/**
 * Hardcoded deck geometry for the W7 mock kernel.
 *
 * The real protocol has no message that ships static ship geometry (`DeckDef`/`SchematicView`)
 * to the main thread: `RenderFrame` carries only dynamic per-entity state (door/machine state by
 * id, actor positions) and `AgentViewSnapshot` (the structured-clone-safe copy of `AgentView`
 * shipped over `requestAgentView`) deliberately drops `schematic` (see `view.ts`). See the W7
 * report for this gap. Until a real deck/content lookup exists (W3 spatial + W10 content), both
 * the mock kernel's simulation and the renderer (`render/draw.ts`) import this module directly so
 * they agree on the same static layout — this is a placeholder, not the intended long-term path.
 */
import type { DeckDefId, DoorId, MachineId } from "@crew/sim";

export const MOCK_DECK_ID = "deck.mock.freighter" as DeckDefId;

export const DECK_WIDTH = 30;
export const DECK_HEIGHT = 18;

export interface MockRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface MockCompartment {
  readonly id: string;
  readonly name: string;
  readonly rect: MockRect;
}

/** Five rectangular compartments tiling the whole deck, no gaps. */
export const MOCK_COMPARTMENTS: readonly MockCompartment[] = [
  { id: "bridge", name: "Bridge", rect: { x: 0, y: 0, w: 10, h: 9 } },
  { id: "quarters", name: "Quarters", rect: { x: 0, y: 9, w: 10, h: 9 } },
  { id: "galley", name: "Galley", rect: { x: 10, y: 0, w: 10, h: 9 } },
  { id: "cargo", name: "Cargo Hold", rect: { x: 10, y: 9, w: 10, h: 9 } },
  { id: "engineering", name: "Engineering", rect: { x: 20, y: 0, w: 10, h: 18 } },
];

export type MockDoorOrientation = "vertical" | "horizontal";

export interface MockDoorPlacement {
  readonly id: DoorId;
  /** Tile the door sits between (its edge midpoint, in tile-corner coordinates). */
  readonly x: number;
  readonly y: number;
  readonly orientation: MockDoorOrientation;
}

export const MOCK_DOORS: readonly MockDoorPlacement[] = [
  { id: "d1" as DoorId, x: 10, y: 4, orientation: "vertical" }, // bridge <-> galley
  { id: "d2" as DoorId, x: 4, y: 9, orientation: "horizontal" }, // bridge <-> quarters
  { id: "d3" as DoorId, x: 14, y: 9, orientation: "horizontal" }, // galley <-> cargo
  { id: "d4" as DoorId, x: 20, y: 4, orientation: "vertical" }, // galley <-> engineering
  { id: "d5" as DoorId, x: 20, y: 13, orientation: "vertical" }, // cargo <-> engineering
];

export interface MockMachinePlacement {
  readonly id: MachineId;
  readonly x: number;
  readonly y: number;
}

export const MOCK_MACHINES: readonly MockMachinePlacement[] = [
  { id: "m1" as MachineId, x: 24.5, y: 4.5 },
];

/** Waypoints actors wander between: room centres plus a couple of points of interest. */
export const MOCK_WAYPOINTS: readonly { readonly x: number; readonly y: number }[] = [
  { x: 5, y: 4.5 }, // bridge centre
  { x: 5, y: 13.5 }, // quarters centre
  { x: 15, y: 4.5 }, // galley centre
  { x: 15, y: 13.5 }, // cargo centre
  { x: 25, y: 9 }, // engineering centre
  { x: 24.5, y: 4.5 }, // machine
  { x: 3, y: 12 }, // a bunk
];

export const MOCK_ACTION_LABELS = [
  "hauling crate",
  "fixing coolant pump",
  "eating",
  "asleep",
  "walking",
  "chatting",
  "checking manifest",
] as const;
