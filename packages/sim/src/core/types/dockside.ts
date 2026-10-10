/**
 * Dockside phase 3 (§staging-plan-dressing): the people and set dressing on the dock alongside, and
 * the staging plan that dresses it.
 *
 * Locals are not crew. They live in their own table (`WorldState.dockside.locals`), never in
 * `actors`, so needs, work, the planner, perception, the roster, the departure call and the
 * dock's last-guard sweep never see them: nothing has to remember to skip them. They exist only
 * while a dock is alongside, stand only on its floor, and walk on the same nav grid as the crew
 * (A* through the grafted dock, never through a door, so never up a ramp).
 *
 * Ownership: the travel system (dock lifetime, the floor set, walking) and commerce (dock-hand
 * errands with freight). The staging plan itself is narrator bookkeeping (`NarratorState.staging`).
 */
import type { Tick, TileCoord } from "./common";
import type {
  ActorId,
  DeckDefId,
  DockDefId,
  ItemDefId,
  ItemId,
  JobId,
  LocalId,
  LocalKey,
} from "./ids";

// ---------------------------------------------------------------------------------------------
// The staging plan (the `stageDock` command's payload)
// ---------------------------------------------------------------------------------------------

/**
 * Who the narrator puts on the dock. A port seed is looked up in the port's `castSeed` by name
 * (its role comes from content); a cast member is someone the narrator's own notes know (the
 * translator vouches for that: the kernel cannot see notes); a new face is invented on the spot
 * and, like a seed, is not cast until the story narrator writes about them.
 */
export type StagedPersonSpec =
  | { readonly kind: "seed"; readonly name: string }
  | { readonly kind: "cast"; readonly name: string; readonly role: string }
  | {
      readonly kind: "newFace";
      readonly name: string;
      readonly role: string;
      /** One line on how they look, for the inspector and the digest. */
      readonly look: string;
    };

export interface StagedPlacement {
  readonly who: StagedPersonSpec;
  /** A post key on the arriving port's dock map. */
  readonly postKey: LocalKey;
  /** Short present-tense activity: "arguing with the queue board". Absent = none. */
  readonly label?: string;
}

/** Where a prop goes: anywhere on the staging area, or beside a post. */
export type StagedPropSpot =
  | { readonly kind: "staging" }
  | { readonly kind: "post"; readonly postKey: LocalKey };

export interface StagedProp {
  /** An item def from the catalogue; drawn like that item, owned by nobody, usable by nobody. */
  readonly itemDefId: ItemDefId;
  readonly count: number;
  readonly at: StagedPropSpot;
}

/** The `stageDock` command payload: what the narrator adds to the floor set. */
export interface StagingPlan {
  readonly place: readonly StagedPlacement[];
  readonly props: readonly StagedProp[];
  /** One sentence for the log as the dock comes alongside. Absent = none. */
  readonly ambience?: string;
}

/** Caps the kernel enforces on a `stageDock` plan (Dockside §6.1). */
export const STAGING_LIMITS = {
  people: 3,
  props: 3,
  propUnits: 4,
  nameChars: 60,
  roleChars: 60,
  lookChars: 120,
  labelChars: 48,
  ambienceChars: 200,
} as const;

// ---------------------------------------------------------------------------------------------
// The floor set (Dockside §5.2)
// ---------------------------------------------------------------------------------------------

/** Why someone is on the dock without the narrator putting them there. */
export type FloorSetReason =
  /** A `castSeed` regular with a `post`: Hal Petrosyan at the queue kiosk every time. */
  | { readonly kind: "regular" }
  /** The receiver for freight bound here: a generic dock hand from the name table. */
  | { readonly kind: "receiver"; readonly jobId: JobId }
  /** A passenger left behind or put off here earlier (§ending-a-passage-early), on the bench. */
  | { readonly kind: "passenger"; readonly actorId: ActorId };

/** One person the sim places on its own. Pure function of state and content (`core/floor-set.ts`). */
export interface FloorSetEntry {
  readonly name: string;
  readonly role: string;
  readonly postKey: LocalKey;
  readonly reason: FloorSetReason;
  readonly label?: string;
}

// ---------------------------------------------------------------------------------------------
// Locals
// ---------------------------------------------------------------------------------------------

/** Where a local's identity lives (dockside §5.1: a presence, not a new entity). */
export type LocalOrigin =
  | FloorSetReason
  | { readonly kind: "staged"; readonly source: StagedPersonSpec["kind"] }
  /** Spawned at the warehouse door for one carting errand, gone when it is done. */
  | { readonly kind: "dockHand" }
  /**
   * §meetings-and-visitors: someone from the port beyond the gate who walked in to the foot of the
   * ramp with word for the captain (a held card's speaker); they go back out through the gate once
   * it is given.
   */
  | { readonly kind: "visitor" };

/** A local's walk, as `MovementState` for the crew (tile centres, continuous position). */
export type LocalMovement =
  | { kind: "stationary" }
  | {
      kind: "moving";
      path: TileCoord[];
      segmentIndex: number;
      segmentDistanceTravelled: number;
    };

/**
 * What a local is doing (dockside §5.1). `atPost`: standing at `home` (the post or a tile beside
 * it), stepping to a neighbouring tile and back now and then. `walkTo`: walking to `tile` (a dock
 * hand's errand, or a placed person crossing to their post); a local who arrives with no errand
 * stands there. `leave`: walking to `exit` (the gate or the warehouse door), gone on arrival.
 */
export type LocalBehaviour =
  | { kind: "atPost"; home: TileCoord; nextShuffleTick: Tick }
  | { kind: "walkTo"; tile: TileCoord; sinceTick: Tick }
  | { kind: "leave"; exit: TileCoord; sinceTick: Tick };

/**
 * A dock hand's carting job (§dock-hand-errands: the appear/vanish/move points, done on foot):
 * - `stageOffer`: out of the warehouse door with an offer's crates (`carrying`), set down on the
 *   staging area on arrival;
 * - `withdrawOffer`: out to the staging area for a closed or departed-from offer's crates, back
 *   through the warehouse door with them;
 * - `takeDelivery`: out to the delivery bay for delivered crates (already paid on the bay), back
 *   through the warehouse door with them.
 * `sinceTick` starts the give-up clock (`travel.dockHandGiveUpSeconds`): past it, or with no
 * route, the old instant behaviour runs and a `dockHandGaveUp` event says so.
 */
export type DockHandErrand =
  | { kind: "stageOffer"; jobId: JobId; sinceTick: Tick }
  | {
      kind: "withdrawOffer" | "takeDelivery";
      jobId: JobId;
      itemIds: ItemId[];
      /** `fetch`: walking out to the crates; `return`: carrying them back to the door. */
      phase: "fetch" | "return";
      sinceTick: Tick;
    };

export interface Local {
  id: LocalId;
  name: string;
  /** Lower case: "queue clerk", "dock hand". */
  role: string;
  /** A uint32 palette seed for the dot, from the name. */
  lookSeed: number;
  /** A new face's one-line look (`StagedPersonSpec.look`). */
  look?: string;
  origin: LocalOrigin;
  /** The post they belong to on this dock (a dock hand's is the warehouse door). */
  postKey: LocalKey;
  /** Short activity label for the renderer and the digest. */
  label?: string;
  /** Deck-frame position on the dock floor, tile units (tile centre = x + 0.5). */
  location: { readonly deckId: DeckDefId; readonly x: number; readonly y: number };
  /** Radians, 0 = east; presentation only. */
  facing: number;
  movement: LocalMovement;
  behaviour: LocalBehaviour;
  errand?: DockHandErrand;
  /** Crates on a dock hand's trolley, by def (presentation: not items, see `DockHandErrand`). */
  carrying: ItemDefId[];
}

/** A staged prop: set dressing drawn like an item, never an `Item` (nobody can pick it up). */
export interface DockProp {
  readonly itemDefId: ItemDefId;
  readonly count: number;
  readonly tile: TileCoord;
}

/**
 * The dockside slice. Empty with no dock alongside (`dockViolations`): locals, props and the
 * narrator's ambience line all come with the dock at the start of `docking` and go with it at
 * the end of `undocking`.
 */
export interface DocksideState {
  /**
   * The dock these locals and props belong to: set when the dock alongside is dressed (at the
   * start of `docking`, at world creation, or the first tick a restored save has a dock alongside
   * that is not), absent with no dock. Dressing is idempotent on it.
   */
  dockId?: DockDefId;
  locals: Record<LocalId, Local>;
  props: DockProp[];
  /** The staging plan's ambience line for this docking, if it had one. */
  ambience?: string;
}
