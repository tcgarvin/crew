/**
 * Actor state (SD §11.1) and actor knowledge (SD §13.1). Captain and first officer use the same
 * model; a role tag exempts nobody from needs, movement or work.
 *
 * Ownership: identity/roles set at spawn (kernel); `location`/`movement` by spatial (W3);
 * `needs` by needs (W4a); `activity` by work (W4); `knowledge` by perception (whoever builds
 * observation in W4/W5); `skills` by work (experience gain); `availability` by needs/bodies.
 */
import type { PhysicalLocation, Tick, TileCoord } from "./common";
import type {
  BodyPart,
  CastPart,
  DamageType,
  InterestTag,
  RoleTag,
  SkillLevels,
  ThoughtKey,
  WantsTier,
  WoundSeverity,
} from "./content";
import type {
  ActorId,
  CompartmentId,
  CrewDefId,
  DoorId,
  EntityId,
  FieldId,
  LocalKey,
  MachineId,
  ProblemId,
  TaskId,
  TraitDefId,
  WoundId,
} from "./ids";
import type { Activity, Intent } from "./work";

/**
 * Need deficits in [0, 1] (0 = satisfied, 1 = critical). W0 decision (see ConfigDef.needs).
 */
export interface Needs {
  hunger: number;
  fatigue: number;
  comfort: number;
  social: number;
  /** Slice 4: boredom; restored by off-watch activities, never above routine class. */
  recreation: number;
}

export type NeedKey = keyof Needs;

/**
 * Slice 4: what someone likes doing off watch. `strong` is one of `likes` (a keen one); likes and
 * dislikes never share a tag.
 */
export interface Interests {
  likes: InterestTag[];
  strong?: InterestTag;
  dislikes: InterestTag[];
}

/**
 * Slice 4: where someone stands on three value axes, integers in [-2, 2]; the positive end is the
 * second word (`orderFreedom` +2 is all for freedom). A debate's stance is their dot product with
 * a topic's weights.
 */
export interface Values {
  orderFreedom: number;
  faithReason: number;
  loyaltyAmbition: number;
}

/**
 * Body capacities in [0, 1]. Expeditions A1 (call 5): one formula, `core/body.ts`
 * `applyCapacities`: movement and manipulation are fatigue's curve times the body's, consciousness
 * the body's. A whole, rested body gives 1 across.
 */
export interface Capacities {
  movement: number;
  manipulation: number;
  consciousness: number;
}

/**
 * Expeditions A1 (§7.1, SD §12.2): one wound. Severity sets its damage and pain
 * (`config.bodies`); `bleeding` until it stops on its own (`bleedStopsAfterSeconds`) or is
 * treated; a `stun` wound carries no damage and never bleeds. `causeActorId` names who made it,
 * when someone did. `treatedTick` is when it was treated at the medbay bed
 * (§treatment-at-the-medbay-bed); absent while untreated.
 */
export interface Wound {
  id: WoundId;
  part: BodyPart;
  severity: WoundSeverity;
  type: DamageType;
  bleeding: boolean;
  tick: Tick;
  causeActorId?: ActorId;
  treatedTick?: Tick;
}

/**
 * Expeditions A1 (§7.1, SD §12's minimum): the body. `parts[p].damage` is the sum of the part's
 * open wounds' damage; `blood`, `pain` and `stun` (consciousness debt) are in [0, 1]. Whole is
 * `core/body.ts` `wholeBody()`. Owner: bodies (`systems/bodies/`), through `applyDamage` and the
 * bodies system.
 */
export interface Body {
  parts: Record<BodyPart, { damage: number }>;
  blood: number;
  pain: number;
  stun: number;
  wounds: Wound[];
}

/** Expeditions A1 (§8.2): where a combatant stands in the morale ladder. */
export const COMBATANT_STATES = [
  "steady",
  "wavering",
  "breaking",
  "fled",
  "surrendered",
  "down",
  "dead",
] as const;
export type CombatantState = (typeof COMBATANT_STATES)[number];

/**
 * Expeditions A1 (§5.2): a combatant's disposition, the cast entry's tiers mapped to numbers
 * (`resolveBase` from `config.expedition.resolveTiers` and `tie`, `loyalty` from `tie`). For the
 * party, `part` is `ally` and `wants` `nothing`.
 */
export interface Disposition {
  part: CastPart;
  resolveBase: number;
  loyalty: number;
  wants: WantsTier;
}

/**
 * Expeditions A1 (§8.1, call 6): someone in the fight, on either side. Owner: the combat system
 * (`systems/expedition/`). `resolve` in [0, 1] moves at each decision; `lastDecidedTick` drives the
 * staggered cadence; `cover` the cover tile they crouch by; `aim` a shot being lined up.
 */
export interface Combatant {
  side: "us" | "them";
  disposition: Disposition;
  state: CombatantState;
  resolve: number;
  lastDecidedTick: Tick;
  cover?: TileCoord;
  aim?: { targetId: ActorId; sinceTick: Tick };
  /** Expeditions A1 (W2): already took `morale.outflanked` this fight (it lands once). */
  outflanked?: true;
}

/** SD §11.1 availability. Sleeping is an activity, not an availability state. */
export type Availability = "available" | "incapacitated" | "dead" | "offShip";

/**
 * Authoritative route state (SD §7.1), enough to resume exactly after save/load.
 * `path` is the sequence of tile centres; segment i runs from path[i] to path[i+1].
 */
export type MovementState =
  | {
      kind: "stationary";
      /**
       * W3 addition: why the last route ended without arriving. Set by spatial; the work system
       * (W4) treats it as "replan now" and it is cleared by the next `requestMove`.
       */
      routeFailure?: RouteFailure;
    }
  | {
      kind: "moving";
      path: TileCoord[];
      segmentIndex: number;
      /** Distance in tiles travelled along the current segment. */
      segmentDistanceTravelled: number;
      /** Tiles/second after all modifiers (SD §7.3), recomputed when a modifier changes. */
      effectiveSpeed: number;
      /** Knowledge revision the route was planned against; mismatch triggers a replan. */
      navigationKnowledgeRevision: number;
      /** Set while waiting on a blocked tile or door; cleared when moving again. */
      blockedSinceTick?: Tick;
      /** Door the actor is waiting on or currently crossing, if any. */
      doorId?: DoorId;
    };

/** W3 addition: a route that ended early, for the planner to react to. */
export interface RouteFailure {
  readonly tick: Tick;
  /**
   * `blocked`: an obstruction or a door that would not open. `positionTaken`: the destination
   * interaction position stayed occupied past the bounded wait. `unreachable`: a knowledge
   * change left no route.
   */
  readonly reason: "blocked" | "positionTaken" | "unreachable";
  /** Tile the actor could not enter. */
  readonly tile: TileCoord;
}

/**
 * Schedule (SD §11.4, §sections-and-dayworkers). The watch section this person stands, from the
 * scenario's watch bill at spawn; absent for a dayworker (anyone not in a section, a
 * narrator-spawned hand included). On/off duty is derived from the tick (`systems/watch/duty.ts`),
 * never stored. The bill itself is not stored either: it is these sections, read off the actors
 * (`watchBillOf`).
 */
export interface Schedule {
  section?: WatchSection;
}

/**
 * §sections-and-dayworkers: a section of the watch bill. `index` is the section's place in the
 * bill, which is the watch of the day it stands (`watchOfDay(tick) === index`); stored beside the
 * key because a generated bill (`core/watch-bill.ts`) exists nowhere else to look it up.
 */
export interface WatchSection {
  readonly key: LocalKey;
  readonly index: number;
}

/**
 * §mood-and-work-speed: something on a person's mind. Mood is the clamped sum of live thoughts'
 * `value`s; the value is copied from the def when the thought is had, so a content retune never
 * rewrites one already held. `refId` names who or what it is about, when that matters.
 */
export interface Thought {
  key: ThoughtKey;
  value: number;
  /** First tick the thought no longer counts. */
  expiresAtTick: Tick;
  refId?: EntityId;
}

// ---------------------------------------------------------------------------------------------
// Knowledge (SD §13.1)
// ---------------------------------------------------------------------------------------------

/** Small typed fact catalog. Add a type by adding a key to `FactValues`. */
export interface FactValues {
  /** The actor knows this problem exists (makes `discovered` problems visible). */
  problem: { problemId: ProblemId; revision: number };
  /** Last seen operating status of a machine. */
  machineStatus: { status: "ok" | "degraded" | "failed" | "off"; temperatureNorm: number };
  /** Symptom noticed on a machine. */
  machineSymptom: { symptomKey: LocalKey };
  doorState: { physicalState: "closed" | "opening" | "open" | "closing" | "jammed" };
  /**
   * Last known location of an item (tool, spare, food).
   * W4a addition: `absent` marks a discrepancy: the actor looked at `location` and the item was
   * not there. The planner ignores absent items until the fact is replaced by a sighting.
   */
  itemLocation: { location: PhysicalLocation; absent?: true };
  /** Someone is known to have claimed a task. */
  taskClaim: { taskId: TaskId; claimantId: ActorId };
  /** Unexpected obstruction on a tile. */
  obstruction: { tile: TileCoord; blocked: boolean };
  /** Coarse status of another person, from sight or report. */
  actorStatus: {
    availability: Availability;
    asleep: boolean;
    /** W4a addition: tile the person was seen on (bed occupancy, chat partners). */
    tile?: TileCoord;
    /** W4a addition: seen doing nothing in particular (activity `idle`). */
    idle?: boolean;
  };
  /**
   * §felt-and-seen: a rock hit the ship (the subject is the field). Everyone aboard feels it; only
   * those in the hit compartment see where, and only for them is `compartmentId` present.
   * `observedTick` is the impact's tick, so the latest belief is the latest impact.
   */
  hullImpact: { fieldId: FieldId; compartmentId?: CompartmentId };
  /**
   * Expeditions (A2's intercom reflex): word of a fight at the site, at `expeditionTick` (the
   * expedition's start). Declared in A1; nobody writes it yet.
   */
  fightSeen: { expeditionTick: Tick };
}

export type FactType = keyof FactValues;

export type EvidenceKind = "direct" | "sensor" | "report" | "inference";
export type Certainty = "confirmed" | "reported" | "suspected";

interface KnownFactBase<T extends FactType> {
  /** Entity the fact is about (machine, door, item, actor, problem, task). */
  subjectId: EntityId;
  factType: T;
  value: FactValues[T];
  /** When the observed state was true (preserved through relays, SD §13.3). */
  observedTick: Tick;
  /** When this actor learned it. */
  learnedTick: Tick;
  /** Who/what it came from: self, a sensor machine, or a reporting actor. */
  sourceId: ActorId | MachineId;
  evidence: EvidenceKind;
  certainty: Certainty;
}

export type KnownFact = { [T in FactType]: KnownFactBase<T> }[FactType];

/**
 * Key for the latest-belief table: `${subjectId}/${factType}`.
 * W0 decision: knowledge keeps only the latest belief per (subject, factType) — no history,
 * no `supersedesFactId`, no fact IDs.
 */
export type FactKey = `${string}/${FactType}`;

export type KnowledgeTable = Record<FactKey, KnownFact>;

// ---------------------------------------------------------------------------------------------
// Actor
// ---------------------------------------------------------------------------------------------

export interface Actor {
  id: ActorId;
  defId: CrewDefId;
  name: string;
  roleTags: RoleTag[];
  /**
   * Crew aboard are `onDeck`; a casualty being carried is `carriedBy`; NPCs at port are
   * `inExternalStore`. While moving, spatial rewrites `onDeck` x/y every tick so that it always
   * equals the position derived from `movement` (invariant); render and perception read x/y.
   */
  location: PhysicalLocation;
  movement: MovementState;
  /**
   * Facing in radians (0 = east, clockwise positive), updated by movement; presentation hint only.
   */
  facing: number;
  needs: Needs;
  capacities: Capacities;
  skills: SkillLevels;
  traits: TraitDefId[];
  /** Mood in [-1, 1]; bounded effects on work and willingness (SD §11.3). */
  mood: number;
  /** §thoughts: live thoughts, which mood sums (owner: `core/thoughts.ts` adds, needs prunes). */
  thoughts: Thought[];
  /** Slice 4: soft character state, from the crew def or generated at spawn. */
  interests: Interests;
  values: Values;
  /**
   * §footfall-and-boots: dirt on the boots in [0, 1], loaded on dock floor and dirty tiles, shed on
   * the deck as they walk (owner: dirt, written from movement through `trackFootfall`).
   */
  boots: number;
  schedule: Schedule;
  activity: Activity;
  /**
   * W2 addition: the planner's latest `Intent`, written by the planner stage (phase 7) and
   * consumed (deleted) by the work system when it turns it into a claim/action next tick.
   */
  pendingIntent?: Intent;
  /** Tick of the last planner run for this actor; drives switch cooldown and staggering. */
  lastPlannedTick: Tick;
  knowledge: KnowledgeTable;
  /** Bumped whenever navigation-relevant knowledge changes (doors, obstructions). */
  navigationKnowledgeRevision: number;
  availability: Availability;
  /**
   * W4a addition: per-candidate retry backoff, `ref` → first tick it may be retried (SD §14.7:
   * never retry a failed pickup every tick). Refs are `task:<id>`, `eat`, `sleep:<machineId>`,
   * etc. Written by work when an activity fails; expired entries are pruned by work.
   */
  workBackoff?: Record<string, Tick>;
  /** W4a addition: tick of this actor's last ambient conversation (chat cooldown). */
  lastConversationTick?: Tick;
  /**
   * Crew or NPC. W0 decision: NPC passengers are `Actor`s with `crew: false`; they never plan work.
   * Passengers-and-galaxy §3.2 revised that for paying passengers: they are `crew: true` (so
   * needs, movement, perception and ambient chat treat them as a person aboard) with
   * `passenger: true`, which is what keeps them out of work, posts and the helm.
   */
  crew: boolean;
  /** Expeditions A1 (§7.1): the body; whole for everyone until something hurts them. */
  body: Body;
  /**
   * Expeditions A1 (§5.1, §8.1): set on everyone in a fight at a site, the party and the cast;
   * absent otherwise. Owner: the combat system.
   */
  combatant?: Combatant;
  /** Passengers-and-galaxy §3: a paying passenger (`Job.passage.actorId`). Never `false`. */
  passenger?: true;
  /**
   * Set while the passenger is walking to the personnel ramp to leave the ship (commerce drives
   * the walk; the planner leaves them alone). Cleared when they are off. Never `false`.
   */
  disembarking?: true;
}

// Inventory is not stored on the actor. W0 decision: an item's `location` is the single source of
// truth for custody; "what is X carrying" is a derived index in `DerivedCaches`, so the two can
// never disagree.
