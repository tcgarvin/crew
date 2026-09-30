/**
 * Navigation geometry cache shapes (W3). Built from `DeckDef` + machine placements by
 * `systems/spatial/geometry.ts`; lives in `DerivedCaches.nav`, never serialized.
 *
 * Tile arrays are row-major (`index = y * width + x`). Edge bitmasks use n=1, e=2, s=4, w=8.
 */
import type { TileCoord, TileEdge } from "./common";
import type { DoorPlacementDef } from "./content";
import type { CompartmentId, DeckDefId, DoorId, LocalKey, MachineId } from "./ids";

/** One door as navigation sees it. */
export interface NavDoor {
  readonly id: DoorId;
  readonly placement: DoorPlacementDef;
  /** The authored edge. */
  readonly edge: TileEdge;
  /** The two tiles the door joins (either may be off-grid or void for a ramp). */
  readonly tiles: readonly [TileCoord, TileCoord];
}

/** An absolute interaction position (SD §6.4). */
export interface NavInteractionPosition {
  readonly machineId: MachineId;
  readonly key: LocalKey;
  readonly tile: TileCoord;
  readonly purposes: readonly ("operate" | "repair" | "use")[];
  readonly capacity: number;
}

export interface DeckGeometry {
  readonly deckId: DeckDefId;
  readonly width: number;
  readonly height: number;
  /** 1 = authored floor (a compartment symbol), 0 = void. */
  readonly floor: Uint8Array;
  /** 1 = covered by a machine footprint (static obstruction). */
  readonly footprint: Uint8Array;
  /** 1 = dynamically obstructed (`DeckState.tiles[..].obstructed`); refreshed in phase 2. */
  readonly obstructed: Uint8Array;
  /** Index into `compartmentIds` per tile, -1 for void. */
  readonly compartment: Int16Array;
  readonly compartmentIds: readonly CompartmentId[];
  /** Static wall bits per tile: implicit compartment/hull walls and listed walls, minus openings and doors. */
  readonly walls: Uint8Array;
  /** Door bits per tile (the edge holds a door). */
  readonly doorSides: Uint8Array;
  /** Door by canonical edge key (see `systems/spatial/geometry.ts` `edgeKey`). */
  readonly doorByEdge: ReadonlyMap<string, DoorId>;
  readonly doors: ReadonlyMap<DoorId, NavDoor>;
  readonly interactionPositions: readonly NavInteractionPosition[];
  /** Interaction positions by tile index. */
  readonly interactionByTile: ReadonlyMap<number, readonly NavInteractionPosition[]>;
}
