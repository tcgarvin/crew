/**
 * Navigation geometry cache shapes (W3). Built from `DeckDef` + machine placements by
 * `systems/spatial/geometry.ts`; lives in `DerivedCaches.nav`, never serialized.
 *
 * Tile arrays are row-major from the grid origin (`index = (y - originY) * width + (x - originX)`;
 * use `tileIndex`/`inBounds` in `systems/spatial/geometry.ts`, never raw arithmetic). Edge
 * bitmasks use n=1, e=2, s=4, w=8.
 */
import type { TileCoord, TileEdge } from "./common";
import type { DoorPlacementDef } from "./content";
import type { CompartmentId, DeckDefId, DockDefId, DoorId, LocalKey, MachineId } from "./ids";

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

/** Compartment index of a grafted dock floor tile: floor, but in no compartment. */
export const DOCK_FLOOR = -2;

/**
 * The dock grafted onto this deck's grid (Dockside spike). Everything is in the deck's frame.
 */
export interface NavDockGraft {
  readonly dockId: DockDefId;
  /** Deck coordinates of dock tile (0,0): `-shipAt`. */
  readonly offset: TileCoord;
  /** For each ramp door, the dock floor tile just outside it. */
  readonly landings: ReadonlyMap<DoorId, TileCoord>;
}

export interface DeckGeometry {
  readonly deckId: DeckDefId;
  /**
   * Deck coordinates of grid index 0. (0,0) for a bare deck; negative when a grafted dock extends
   * fore of or above the ship. Bounds are dynamic: they grow while a dock is attached.
   */
  readonly originX: number;
  readonly originY: number;
  readonly width: number;
  readonly height: number;
  /** 1 = authored floor (a compartment symbol, or dock floor), 0 = void. */
  readonly floor: Uint8Array;
  /** 1 = covered by a machine footprint (static obstruction). */
  readonly footprint: Uint8Array;
  /** 1 = dynamically obstructed (`DeckState.tiles[..].obstructed`); refreshed in phase 2. */
  readonly obstructed: Uint8Array;
  /** Index into `compartmentIds` per tile, -1 for void, `DOCK_FLOOR` for grafted dock floor. */
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
  /** The dock grafted onto this deck, if one is alongside. */
  readonly dock?: NavDockGraft;
  /**
   * Ramp doors that are fully open right now; refreshed with obstructions. A ramp is passable
   * for planning only while listed here (ramp state is public: the whole ship sees the ramps).
   */
  readonly openRamps: Set<DoorId>;
}
