/**
 * Small shared primitives: time, space, JSON safety, randomness state.
 */
import type {
  ActorId,
  CompartmentId,
  DeckDefId,
  ItemId,
  LocalKey,
  MachineId,
  PortDefId,
} from "./ids";

// ---------------------------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------------------------

/**
 * Integer simulation tick. `config.time.tickRate` ticks per sim-second (default 20, SD §5.1).
 * State always stores ticks; content and config author durations in seconds and the kernel
 * converts with `Math.ceil(seconds * tickRate)` (SD §5.1: actions take at least their duration).
 */
export type Tick = number;

/** A duration authored in (fractional) sim-seconds. Only appears in content/config, never state. */
export type Seconds = number;

/**
 * D76: a duration authored in (fractional) ship's days, `config.time.daySeconds` long. Only in
 * config; converted where read by `core/clock.ts` (`daysToSeconds`, `dayTicks`), never at load,
 * because the config is embedded in every save as authored.
 */
export type Days = number;

// ---------------------------------------------------------------------------------------------
// Space
// ---------------------------------------------------------------------------------------------

/**
 * Integer tile coordinate in ship-local deck space; x grows east, y grows south.
 * W0 decision: tile (x, y) covers the continuous square [x, x+1) × [y, y+1); its centre is
 * (x + 0.5, y + 0.5). Continuous positions (`DeckPoint`) use the same axes in tile units.
 */
export interface TileCoord {
  readonly x: number;
  readonly y: number;
}

/** Continuous position in tile units on one deck. */
export interface DeckPoint {
  readonly deckId: DeckDefId;
  readonly x: number;
  readonly y: number;
}

/** A tile edge: the boundary on `side` of tile (x, y). Doors, walls and openings live on edges. */
export interface TileEdge {
  readonly x: number;
  readonly y: number;
  readonly side: EdgeSide;
}

export type EdgeSide = "n" | "e" | "s" | "w";

/** Sparse per-tile key: `${x},${y}`. Used for dynamic per-tile state tables. */
export type TileKey = `${number},${number}`;

/** Placement rotation for multi-tile footprints, clockwise. */
export type Rotation = 0 | 90 | 180 | 270;

/**
 * A place something happened or a fact is about, for events and knowledge. Not a physical
 * location (see `PhysicalLocation` for custody).
 */
export type LocationRef =
  | { readonly kind: "tile"; readonly deckId: DeckDefId; readonly x: number; readonly y: number }
  | { readonly kind: "compartment"; readonly compartmentId: CompartmentId }
  | { readonly kind: "machine"; readonly machineId: MachineId }
  | { readonly kind: "port"; readonly portId: PortDefId };

// ---------------------------------------------------------------------------------------------
// Custody
// ---------------------------------------------------------------------------------------------

/**
 * Where a physical thing is (SD §6.1). Every persistent physical object has exactly one.
 * Containment must be acyclic. A carried object's effective position is its carrier's; an
 * installed component's is its machine's footprint.
 *
 * W0 decision: single ship, so `onDeck` carries `deckId` but no `shipId`; adding ships is a
 * schema migration.
 */
export type PhysicalLocation =
  | OnDeckLocation
  | {
      readonly kind: "inContainer";
      readonly containerId: ItemId;
    }
  | {
      readonly kind: "carriedBy";
      readonly actorId: ActorId;
    }
  | {
      readonly kind: "equippedBy";
      readonly actorId: ActorId;
      readonly slot: EquipSlot;
    }
  | {
      readonly kind: "installedIn";
      readonly machineId: MachineId;
      readonly componentSlot: LocalKey;
    }
  | {
      /**
       * Off-ship custody at a port: a warehouse, market or passenger lounge. `storeKey` names a
       * `PortDef.externalStores[].key`. W0 decision: NPC passengers waiting to board also live
       * here (store kind `lounge`), so no seventh location variant is needed.
       */
      readonly kind: "inExternalStore";
      readonly portId: PortDefId;
      readonly storeKey: LocalKey;
    };

/** On the deck floor at a continuous position. `x`/`y` are in tile units (see `TileCoord`). */
export interface OnDeckLocation {
  readonly kind: "onDeck";
  readonly deckId: DeckDefId;
  readonly x: number;
  readonly y: number;
}

export type EquipSlot = "hands" | "body" | "back" | "belt";

// ---------------------------------------------------------------------------------------------
// Randomness
// ---------------------------------------------------------------------------------------------

/** sfc32 state: four uint32 words (review §C.5). Stored verbatim in state. */
export type Sfc32State = readonly [number, number, number, number];

/**
 * Named, independently seeded streams (SD §5.4). Adding a stream is a schema bump.
 * `setup`: world creation and trait sampling. `failures`: fault hazards and narrator fault-window
 * sampling. `perception`: observation rolls. `social`: chat/mood rolls. `commerce`: job source.
 * `narrator`: kernel-side sampling inside narrator commands other than faults.
 */
export const RNG_STREAMS = [
  "setup",
  "failures",
  "perception",
  "social",
  "commerce",
  "narrator",
] as const;

export type RngStreamName = (typeof RNG_STREAMS)[number];

// ---------------------------------------------------------------------------------------------
// JSON safety
// ---------------------------------------------------------------------------------------------

/**
 * Values that survive `JSON.parse(JSON.stringify(v))` unchanged. State must be built from these:
 * no `undefined` values (omit the key instead), no `NaN`/`±Infinity`/`-0`, no Map/Set/class
 * instances/typed arrays/functions.
 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * A reference into a text template catalog plus parameters. Used for decision prompts and
 * option labels so the UI can render something immediately and prose can arrive later.
 */
export interface TextRef {
  /** Template key, e.g. `decision.job.offer.prompt`. */
  readonly key: string;
  /** Template parameters; values are display strings or numbers, never entity objects. */
  readonly params: Readonly<Record<string, string | number>>;
  /** Optional ready-made prose (narrator card text). Shown instead of the template when present. */
  readonly prose?: string;
}

/**
 * Recursive read-only view. Systems mutate `WorldState` in place inside the pipeline (review
 * §C.1); every other reader (planner, view builders, render projection, narrator digest, tests)
 * receives `DeepReadonly<WorldState>` so it cannot write by accident.
 */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : // Primitives first: a branded ID (`string & { [brand] }`) is an object type to `extends object`.
    T extends string | number | boolean | bigint | symbol | null | undefined
    ? T
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;
