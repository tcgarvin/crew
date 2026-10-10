/**
 * `WorldState`: the whole authoritative, serialized game (review §C.1).
 *
 * Rules (checked by invariants and tests, see docs/CONTRACTS.md):
 * - Plain JSON-compatible objects only. It must survive `JSON.parse(JSON.stringify(state))`
 *   deep-equal. No `undefined` values (omit optional keys), no NaN/±Infinity/-0, no Map/Set/class
 *   instances/typed arrays.
 * - Kind tables `Record<Id, T>`, one owned slice per system. A system writes only its own slice
 *   (and the fields documented as its own on shared entities); everything else is read-only to it.
 * - Instance IDs come from `nextId` and are never reused.
 * - Anything derivable lives in `DerivedCaches`, not here.
 * - Events are not stored; `advance()` returns them.
 *
 * W0 decision: entity and table types are mutable (systems mutate in place, review §C.1); value
 * objects (locations, coords, text refs) and immutable data (content, commands, events, frames)
 * are `readonly`. Non-system readers get `ReadonlyWorldState` (`DeepReadonly<WorldState>`).
 */
import type { Actor } from "./actor";
import type { CommandsState } from "./commands";
import type { RngStreamName, Sfc32State, Tick, TileCoord } from "./common";
import type {
  CrewDef,
  DirtTier,
  FieldDetection,
  FieldSeverity,
  HazardKind,
  ItemDef,
  MachineEffect,
  MemoryKey,
  RockSize,
} from "./content";
import type { DecisionsState, NarratorState } from "./decisions";
import type { DocksideState } from "./dockside";
import type {
  ActivityDefId,
  ActorId,
  ClaimId,
  CommandId,
  CompartmentId,
  CrewDefId,
  DeckDefId,
  DoorId,
  FieldId,
  HazardId,
  ItemDefId,
  ItemId,
  JobId,
  LocalKey,
  MachineId,
  NextIdCounters,
  PortDefId,
  ProblemId,
  ScarId,
  ScenarioDefId,
  SessionId,
  TaskId,
  TopicDefId,
} from "./ids";
import type { Compartment, DeckState, Door, Item, Machine, PowerState } from "./ship";
import type { Job, MoneyState, TravelState } from "./travel";
import type { Claim, Problem, Task } from "./work";

/**
 * Bumped on any breaking change to this shape. Each bump ships a `Migration` from the previous
 * version (see save.ts). 2 (2026-09-30): jobs gained `issuerPerson`, `pitch` and `urgency`
 * (§issuers-and-pitches). 3 (2026-10-01): `markets` (§port-markets), seeded lazily from content for
 * a port a save never visited. 4 (2026-10-03): `deck.dock` is set from the start of `docking` to
 * the end of `undocking` at a port with a dock map (§dock-alongside), so a save docked at one gets
 * it on load. 5 (2026-10-03): `dockside` (locals and props on the dock alongside),
 * `narrator.staging` and the `stageDock` hook, which replaces `approachingPort`
 * (§staging-hook-and-the-hold). 6 (2026-10-03): `captainAshore` replaces `jobBoard` (and
 * `captainAshoreLastAsk` the board's last ask), `decisions.held` holds cards waiting to be
 * delivered in person, and `Job.surfaceWhenDocked` is gone (§holding-a-card).
 * 7 (2026-10-04): ship life slice 1 (§ship-placement, §berth-assignment): Freighter Mk1 is mirrored
 * bow-east, dock maps declare a berth box, `berths` assigns beds and items may have an `ownerId`.
 * Older saves are refused rather than migrated (their tile coordinates are in the old frames).
 * 8 (2026-10-04): ship life slice 2: watches replace shifts (`Actor.schedule.section`
 * from the scenario's watch bill), `Actor.thoughts`, `watch`, `hazards` and `nextId.hazard`, the
 * narrator budget's hazard line and refill tick, `post` on `stationToStaff`. Migrated.
 * 9 (2026-10-04): ship life slice 3: `dirt` (a cell grid per deck and room tiers),
 * `galley` (the meal's bookkeeping), `Actor.boots`, `Item.meal`. Migrated; an old save also gets
 * the scenario's provisions and mop spawned so it cooks tonight.
 * 10 (2026-10-05): ship life slice 4: `needs.recreation`, `Actor.interests` and
 * `values`, `social` (relationships, rivalries, group sessions, the captain's table, a private
 * talk) and `nextId.session`. Migrated; an old save also gets the scenario's books on the shelf.
 * 11 (2026-10-05): affinity from memories (§memories): `Relationship.affinity` is gone and
 * `Relationship.memories` holds what one remembers of the other. Migrated: affinities are dropped
 * (everyone starts at their compatibility), chat timing kept.
 * 12 (2026-10-06): ship life slice 5: `hull` (integrity, max and scars), `field` and
 * `alert`, `nextId.field` and `scar`; the `asteroidBelt` hazard kind is gone. Migrated: the hull
 * starts whole, a waiting `asteroidBelt` hazard becomes a `debrisField`, and an old save gets the
 * scenario's patch kits in the lockers.
 */
export const SCHEMA_VERSION = 12;

/**
 * §memories: one thing `from` remembers about `to`; its opinion is config's (`social.memories`).
 */
export interface SocialMemory {
  key: MemoryKey;
  /** First tick the memory no longer counts; the social system drops it then. */
  expiresAtTick: Tick;
}

/**
 * Slice 4: what one person holds about another (directed). An entry exists once a chat or a
 * memory names the pair. §affinity: affinity is not stored; it is compatibility plus the live
 * memories (`affinityOf`).
 */
export interface Relationship {
  memories: SocialMemory[];
  /** Last ambient chat between the pair that left a memory (`social.chatMemoryEveryDays`). */
  lastChatTick?: Tick;
}

/** Slice 4: `"<a>|<b>|<activityId>"` with the two actor ids in ascending order (`rivalryKey`). */
export type RivalryKey = string;

/**
 * Slice 4: the tally between two people at one activity, from `a`'s side (the key's first id):
 * `a`'s wins and losses, and the current run, positive for `a`'s, negative for `b`'s.
 */
export interface Rivalry {
  wins: number;
  losses: number;
  streak: number;
}

/**
 * Slice 4: where a session happens: a compartment, and in it a machine (the games table) or a
 * zone (the sparring mat), or neither (the lounge floor).
 */
export type SessionVenue = { compartmentId: CompartmentId } & (
  | { machineId: MachineId }
  | { zoneKey: LocalKey }
  | Record<never, never>
);

/**
 * Slice 4: a group activity, open (gathering) or running. The row is the venue's; each member's
 * part is their `recreate` step. Members are the people at the venue; nobody en route counts.
 * Common knowledge (`AgentView.sessions()`), like the roster.
 */
export interface GroupSession {
  id: SessionId;
  activityId: ActivityDefId;
  venue: SessionVenue;
  hostId: ActorId;
  members: ActorId[];
  openedTick: Tick;
  /** Set when it starts (at `participants.max`, or the gather timer with at least `min`). */
  startedTick?: Tick;
  /** When it resolves; set with `startedTick`. */
  endsAtTick?: Tick;
  /** A debate's topic, picked when it starts. */
  topicId?: TopicDefId;
}

/**
 * Slice 4: the captain (or the first officer standing in) has called someone in for a word in
 * their cabin (`privateTalk`). Owner: cabins.
 */
export interface PrivateTalk {
  captainId: ActorId;
  actorId: ActorId;
  tone: "warm" | "stern";
  requestedTick: Tick;
}

/**
 * Slice 4: social life. Owners: recreation for `sessions`, cabins for `privateTalk`, social for
 * the rest (relationships, rivalries, the captain's table). Sparse: under 4 KB at nine people.
 */
export interface SocialState {
  /** `relationships[from][to]`: what `from` feels about `to`. */
  relationships: Record<ActorId, Record<ActorId, Relationship>>;
  rivalries: Record<RivalryKey, Rivalry>;
  sessions: Record<SessionId, GroupSession>;
  /** The ship's day (`dayIndexAt`) of the last captain's table; -1 before the first. */
  captainsTableDay: number;
  privateTalk?: PrivateTalk;
}

/**
 * §dirt-grid: dirt. Owner: dirt (`systems/dirt/`). `cells[deckId]` is one row-major integer per
 * authored deck tile (`y × width + x`, `core/dirt-grid.ts`), 0..255 with 255 = 1.0 of dirt; dock
 * floor has no cell. `tiers` is the last tier written per room (`CompartmentDef.key`), so a
 * transition is seen once; `dustThisVisit` is the airborne dust settled since the ship last docked.
 */
export interface DirtState {
  cells: Record<DeckDefId, number[]>;
  tiers: Record<LocalKey, DirtTier>;
  dustThisVisit: number;
}

/**
 * §meal-problem: the galley's bookkeeping. Owner: galley (`systems/galley/`). `lastMealWatch` is
 * the `watchIndexAt` of the last watch a `mealToCook` was raised for; `helmMeal` is the stander's
 * plate being eaten in the seat (a meal run on the spot rather than planned).
 */
export interface GalleyState {
  lastMealWatch: number;
  helmMeal?: { actorId: ActorId; itemId: ItemId; startedTick: Tick };
}

/**
 * §the-bell: the watch's bookkeeping. Owner: watch (`systems/watch/`).
 */
export interface WatchState {
  /** `watchIndexAt` of the last bell rung; the bell rings when the live index differs. */
  lastBellWatch: number;
  helm: {
    /**
     * The tick the helm fell empty while its watch is wanted (course plotted, or underway);
     * absent while manned or not wanted.
     */
    unattendedSinceTick?: Tick;
    /** The last handover: who took the seat, and when (ends the off-going's hold). */
    relievedAt?: { tick: Tick; byActorId: ActorId };
  };
}

/**
 * §debris-fields-and-ion-storms: a navigation hazard placed by the narrator's `scheduleHazard`. It
 * fires at the first `transit` tick at or after `fireAtTick`. Owner: travel
 * (`systems/travel/hazards.ts`).
 */
export interface ScheduledHazard {
  id: HazardId;
  kind: HazardKind;
  /** Piloting-check difficulty, an integer in [1, 10]. */
  difficulty: number;
  fireAtTick: Tick;
  causeCommandId?: CommandId;
}

/**
 * §scheduling-a-field: what a scripted impact is aimed at. A compartment is hit on one of its
 * tiles, uniformly; a machine on one of its footprint tiles. `actor` waits for bodies (slice 6):
 * the command shape carries it and the kernel rejects it.
 */
export type ImpactTarget =
  | { readonly kind: "machine"; readonly machineId: MachineId }
  | { readonly kind: "compartment"; readonly compartmentId: CompartmentId }
  | { readonly kind: "tile"; readonly x: number; readonly y: number }
  | { readonly kind: "actor"; readonly actorId: ActorId };

/**
 * §scheduling-a-field: one impact the narrator chose (`scheduleField.scripted`). `atSeconds` counts
 * sim seconds from the field's start; an absent `rock` is drawn by the severity's large share, an
 * absent `effect` rolled. It replaces the random impact due at that moment, so the rate holds.
 */
export interface ScriptedImpactDraft {
  readonly atSeconds: number;
  readonly target: ImpactTarget;
  readonly rock?: RockSize;
  readonly effect?: MachineEffect;
}

/** §rock-impacts: a scripted impact on the field, with the tick it landed once it has. */
export interface ScriptedImpact extends ScriptedImpactDraft {
  firedTick?: Tick;
}

/**
 * §field-lifecycle: where a field is in its life. `scheduled` until the first transit tick at or
 * after its start; `active` while the ship is in it (it spans route progress up to
 * `endsAtProgress`; `stuckSinceTick` while the engines are out); `ended` once crossed or drifted
 * clear, kept until the leg ends so a leg holds one field.
 */
export type FieldPhase =
  | { kind: "scheduled" }
  | { kind: "active"; enteredTick: Tick; endsAtProgress: number; stuckSinceTick?: Tick }
  | { kind: "ended"; enteredTick: Tick; endedTick: Tick; how: "crossed" | "drifted" };

/**
 * §the-asteroid-field: the leg's asteroid field, from `scheduleField` to the leg's end. Owner:
 * field (`systems/field/`).
 */
export interface ActiveField {
  id: FieldId;
  severity: FieldSeverity;
  detection: FieldDetection;
  /** Impacts may fall from here; the helm's check falls `field.warningSeconds` before it. */
  startsAtTick: Tick;
  phase: FieldPhase;
  /** When the crew first knew: the helm sighted it, or the first impact. */
  noticedAtTick?: Tick;
  impacts: number;
  /** Impacts taken while stuck (call 9's clock). */
  stuckImpacts: number;
  lastImpactTick?: Tick;
  /** Hull points this field has cost so far. */
  hullLost: number;
  scripted: ScriptedImpact[];
  causeCommandId?: CommandId;
}

/**
 * §sighting-and-the-alert, §reporting-damage: the ship is on alert. Raised and cleared by the field
 * (`clearsAtTick` is set when the field ends); `reports` is the last tick an intercom report
 * covered each compartment (written by the intercom, read by damage response for its scouts).
 * Common knowledge.
 */
export interface AlertState {
  sinceTick: Tick;
  cause: "field";
  clearsAtTick?: Tick;
  reports: Record<CompartmentId, Tick>;
}

/**
 * §hull-scars-and-ship-loss: one impact's mark on the hull, on its centre tile (ship deck frame).
 * `damage` is the hull points the impact actually cost; `recovered` what patching has given back
 * (`patched` once a kit is welded on). Plating clears the scar and the rest of its damage.
 */
export interface HullScar {
  id: ScarId;
  fieldId: FieldId;
  tile: TileCoord;
  compartmentId: CompartmentId;
  rock: RockSize;
  damage: number;
  recovered: number;
  patched: boolean;
  tick: Tick;
}

/**
 * §the-hull-bar: the hull bar. `integrity` is `max` less every scar's damage not yet recovered
 * (`core/hull.ts`); at 0 the ship is lost (`lostAtTick`) and the kernel halts for good. Owners:
 * field (charges, loss), damage (patching, plating).
 */
export interface HullState {
  integrity: number;
  max: number;
  scars: HullScar[];
  lostAtTick?: Tick;
}

/**
 * §port-markets: one item on a port's market: units in stock and the per-unit price in integer
 * credits.
 */
export interface MarketLine {
  count: number;
  price: number;
}

/** §port-markets: a port's live market, keyed by item def. Absent item = not sold here. */
export type MarketStock = Record<ItemDefId, MarketLine>;

/** Work slice (W4): problems are written by their owning systems, tasks/claims by work. */
export interface WorkState {
  problems: Record<ProblemId, Problem>;
  tasks: Record<TaskId, Task>;
  claims: Record<ClaimId, Claim>;
  /** SD §15.1 fairness: rotating start offset for actor planning order. */
  plannerRotation: number;
}

/** Per-game generated definitions (review §C.6), embedded so a save is self-sufficient. */
export interface DynamicDefs {
  items: Record<ItemDefId, ItemDef>;
  crew: Record<CrewDefId, CrewDef>;
}

export interface WorldState {
  schemaVersion: number;
  /** Scenario this game started from (informational; content is referenced by hash in the save). */
  scenarioId: ScenarioDefId;
  /** Master seed, kept for bug reports. */
  seed: number;
  /** Last completed tick. A fresh world is at 0. */
  tick: Tick;
  rng: Record<RngStreamName, Sfc32State>;
  nextId: NextIdCounters;

  // Kind tables -------------------------------------------------------------------------------
  /** Owner: kernel spawn + spatial/needs/work per `Actor` field docs. */
  actors: Record<ActorId, Actor>;
  /** Owner: spatial (W3). */
  compartments: Record<CompartmentId, Compartment>;
  /** Owner: spatial (W3). Sparse dynamic tile state; static geometry is in `DeckDef`. */
  deck: DeckState;
  /** Owner: spatial (W3). Includes ramps. */
  doors: Record<DoorId, Door>;
  /** Owner: equipment (W5). */
  machines: Record<MachineId, Machine>;
  /** Owner: power (W5). */
  power: PowerState;
  /** Owner: inventory transfers (unique items and stacks share the table). */
  items: Record<ItemId, Item>;
  /**
   * Owner: needs (§berth-assignment). Each berthed actor's bed: the `MachinePlacementDef.key` of a
   * `bed`-tagged machine on the ship's deck. No two actors share one; an actor without a berth has
   * no key.
   */
  berths: Record<ActorId, LocalKey>;
  /** Owner: work (W4), problems by their owning systems. */
  work: WorkState;
  /** Owner: travel (W6). */
  travel: TravelState;
  /** Owner: watch (§the-bell): the bell and the helm's bookkeeping. */
  watch: WatchState;
  /**
   * Owner: travel (§debris-fields-and-ion-storms). Navigation hazards waiting to fire, in
   * scheduling order.
   */
  hazards: ScheduledHazard[];
  /** Owner: dirt (§dirt-grid). */
  dirt: DirtState;
  /** §the-hull-bar: the hull bar. Owners per `HullState`. */
  hull: HullState;
  /**
   * §the-asteroid-field: the leg's asteroid field, from scheduling to the leg's end. Owner: field.
   */
  field?: ActiveField;
  /** §sighting-and-the-alert: the ship is on alert. Owners per `AlertState`. */
  alert?: AlertState;
  /** Owner: galley (§meal-problem). */
  galley: GalleyState;
  /** Slice 4: owners per `SocialState` (recreation, social, cabins). */
  social: SocialState;
  /** Owner: commerce (W6). */
  jobs: Record<JobId, Job>;
  /** Owner: commerce (W6). Integer credits. */
  money: MoneyState;
  /**
   * Owner: commerce (§port-markets). Per-port market stock, seeded from `PortDef.market` at world
   * creation and changed by purchases and the narrator's `stockMarket`. A port with no entry reads
   * as its content seed (`systems/commerce/market.ts` `effectiveMarket`), so an older save needs no
   * backfill beyond the empty table.
   */
  markets: Record<PortDefId, MarketStock>;
  /**
   * Owner: travel (the dock's people and props come and go with it) and commerce (dock-hand
   * errands; §locals-table). Empty whenever no dock is alongside.
   */
  dockside: DocksideState;
  /** Owner: decisions. */
  decisions: DecisionsState;
  /** Owner: kernel core (quiet timer, budget) and decisions (pending hook). */
  narrator: NarratorState;
  /** Owner: kernel core (W2). */
  commands: CommandsState;
  /** Owner: kernel core (spawn commands add, nothing removes). */
  defs: { dynamic: DynamicDefs };
}
