/**
 * Ship entity state: compartments, dynamic deck tiles, doors, machines, items, power.
 *
 * Static geometry (tile grid, walls, placements) lives in `DeckDef`; these tables hold only what
 * changes during play.
 *
 * Ownership: `deck`/`doors`/`compartments` by spatial (W3); `machines` and `power` by equipment
 * and power (W5); `items` by inventory transfers (whoever commits the transfer: work execution,
 * travel/commerce for boundary custody).
 */
import type { PhysicalLocation, Tick, TileKey } from "./common";
import type {
  ActorId,
  CommandId,
  CompartmentId,
  DeckDefId,
  DockDefId,
  DoorId,
  ItemDefId,
  ItemId,
  JobId,
  LocalKey,
  MachineDefId,
  MachineId,
} from "./ids";

// ---------------------------------------------------------------------------------------------
// Compartments and deck
// ---------------------------------------------------------------------------------------------

/**
 * A compartment instance. W0 decision: V1 has no atmosphere/thermal state (PLAN §7 defers it),
 * so this is identity only; `CompartmentDef.key` links back to geometry.
 */
export interface Compartment {
  id: CompartmentId;
  deckId: DeckDefId;
  key: LocalKey;
}

/** Sparse dynamic state for one tile; absent tiles are pristine. */
export interface TileState {
  /** Something (dropped crate, debris) blocks passage. */
  obstructed: boolean;
  /** Floor integrity in [0, 1]. */
  floorIntegrity: number;
}

export interface DeckState {
  /** Per deck, sparse per-tile overrides keyed `${x},${y}`. */
  tiles: Record<DeckDefId, Record<TileKey, TileState>>;
  /**
   * Bumped on any geometry-affecting change (door jam, obstruction, a ramp opening or closing, a
   * dock attaching or detaching); invalidates nav caches.
   */
  geometryRevision: number;
  /**
   * Dockside spike (see docs/design/dockside-spike.md): the dock currently alongside, if any. Its
   * walkable tiles are grafted into `deckId`'s nav grid in the deck's own coordinate frame, so dock
   * tiles are ordinary `onDeck` positions on that deck (possibly negative or past the deck's
   * authored bounds). Set and cleared through `systems/spatial/dock.ts`.
   */
  dock?: DockPresence;
}

/** Which dock layout is grafted onto which deck. Layout geometry comes from content. */
export interface DockPresence {
  readonly dockId: DockDefId;
  readonly deckId: DeckDefId;
}

// ---------------------------------------------------------------------------------------------
// Doors (SD §7.5)
// ---------------------------------------------------------------------------------------------

export type DoorPhysicalState = "closed" | "opening" | "open" | "closing" | "jammed";

export interface Door {
  id: DoorId;
  deckId: DeckDefId;
  /** `DoorPlacementDef.key`. */
  placementKey: LocalKey;
  kind: "interior" | "ramp";
  physicalState: DoorPhysicalState;
  requestedState: "open" | "closed";
  /** [0, 1] within the current opening/closing transition. */
  transitionProgress: number;
  integrity: number;
  sealQuality: number;
  /** Actuator failed: the door cannot move under power. Distinct from jammed and from a bad seal. */
  actuatorFault: boolean;
  manualOperationSupported: boolean;
  /** Actors currently in the aperture; powered closure waits for this to empty. */
  occupants: ActorId[];
  /** When an automatically opened door should start closing again. */
  closeAfterTick?: Tick;
}

// ---------------------------------------------------------------------------------------------
// Machines (SD §9.1–9.2)
// ---------------------------------------------------------------------------------------------

export type OperatingMode = "off" | "standby" | "on";

/**
 * A fault present on a machine. Existence is truth; diagnosis is knowledge. W0 decision: a fault
 * is identified by `(machineId, faultKey)` — a machine cannot hold two faults of the same key —
 * so faults have no instance ID.
 */
export interface MachineFault {
  faultKey: LocalKey;
  sinceTick: Tick;
  /** Set when a diagnosis completes; equipment then raises the `machineFault` problem. */
  diagnosed: boolean;
  /** Repair progress belongs here (SD §14.4): index into `RepairRecipe.steps` and [0,1] within it. */
  repairStepIndex: number;
  repairStepProgress: number;
  /** Command that caused it, for narrator audit (review §C.4 causeIds). */
  causeCommandId?: CommandId;
}

/** A narrator/scenario fault waiting for its kernel-sampled tick (D6). */
export interface ScheduledFault {
  faultKey: LocalKey;
  fireAtTick: Tick;
  causeCommandId: CommandId;
}

/** Role-specific dynamic state. Most machines are `none`. */
export type MachineRoleState = { role: "none" } | { role: "battery"; storedKj: number };

export interface Machine {
  id: MachineId;
  defId: MachineDefId;
  deckId: DeckDefId;
  /** `MachinePlacementDef.key`; footprint and interaction tiles are resolved from it. */
  placementKey: LocalKey;
  /** Physical damage in [0, 1]. */
  integrity: number;
  /** Wear in [0, 1]; 1 = freshly maintained. */
  condition: number;
  desiredMode: OperatingMode;
  actualMode: OperatingMode;
  /** Output fraction in [0, 1] after power, heat and fault derating. */
  output: number;
  /** kW allocated this tick by the power system (phase 2). */
  powerAllocatedKw: number;
  /** Normalised: 0 ambient, 1 failure point. */
  temperature: number;
  faults: MachineFault[];
  scheduledFaults: ScheduledFault[];
  /** SD §9.2: integrated hazard vs. a threshold sampled from the `failures` stream. */
  failure: { accumulatedHazard: number; threshold: number };
  /** Tick of the last completed inspection; drives `maintenanceDue`. */
  lastMaintainedTick: Tick;
  /**
   * W5 addition: progress in [0, 1] on the current `maintain` task's inspection step
   * (`MaintenanceDef.inspect`), so a second worker resumes it (SD §14.4). Reset to 0 on
   * completion.
   */
  maintenanceProgress: number;
  roleState: MachineRoleState;
}

// ---------------------------------------------------------------------------------------------
// Items (SD §8.1)
// ---------------------------------------------------------------------------------------------

interface ItemBase {
  id: ItemId;
  defId: ItemDefId;
  /** Single source of truth for custody. */
  location: PhysicalLocation;
  /** Present on freight belonging to a contract. */
  jobId?: JobId;
}

export interface UniqueItem extends ItemBase {
  stacking: "unique";
  /** Wear in [0, 1]. */
  condition: number;
  /** Actor holding an exclusive reservation for pickup (e.g. the one tool kit). */
  reservedBy?: ActorId;
}

export interface StackItem extends ItemBase {
  stacking: "stack";
  /** Never negative. Splits/merges are atomic transfers. */
  count: number;
  /** Units promised to claims; `reserved <= count`. */
  reserved: number;
}

export type Item = UniqueItem | StackItem;

// ---------------------------------------------------------------------------------------------
// Power (SD §9.3)
// ---------------------------------------------------------------------------------------------

/**
 * Per-domain summary written by the power system each tick it runs (phase 2). Allocation per
 * machine is on `Machine.powerAllocatedKw`; this is the domain ledger used by render/digest.
 */
export interface PowerDomainState {
  key: LocalKey;
  supplyKw: number;
  demandKw: number;
  batteryFlowKw: number;
  /** Protective trip (e.g. from an electrical short); a tripped breaker is not a repair. */
  tripped: boolean;
}

export interface PowerState {
  domains: Record<LocalKey, PowerDomainState>;
}
