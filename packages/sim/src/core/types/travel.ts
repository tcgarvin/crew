/**
 * Travel, jobs and money (SD §17). Ownership: `travel` by the travel system (W6); `jobs` and
 * `money` by commerce (W6).
 */
import type { TextRef, Tick } from "./common";
import type { CargoClass } from "./content";
import type { StagingPlan } from "./dockside";
import type {
  ActorId,
  CommandId,
  HookId,
  ItemDefId,
  ItemId,
  JobId,
  PortDefId,
  TransactionId,
} from "./ids";

/** SD §17.1 exterior state machine, in order. */
export const TRAVEL_STAGES = [
  "docked",
  "preparingDeparture",
  "undocking",
  "departing",
  "transit",
  "approaching",
  "docking",
] as const;
export type TravelStage = (typeof TRAVEL_STAGES)[number];

/**
 * D36 departure-gate flags, meaningful while a departure is planned (`docked` with a
 * `plannedDestinationId`, or `preparingDeparture`). `holdForRepairs` is dropped by the fresh
 * state object every later stage builds, so a hold never outlives the departure it held.
 * `departureRiskAccepted` is asked once per *voyage* (passengers-and-galaxy §2.3): it rides
 * through every stage and every intermediate docking, and is dropped when the ship docks with no
 * voyage left to run, or the moment the impaired set changes (a new fault, or a repair: see
 * `acceptedImpairmentKey` and `departureCleared`).
 */
export interface DepartureGateFlags {
  /** "Hold for repairs": wait docked until no engine/generator is impaired, then go. */
  holdForRepairs?: boolean;
  /** "Leave anyway": the gate does not ask again for this voyage (or docking, with no voyage). */
  departureRiskAccepted?: boolean;
  /**
   * The impairment set "leave anyway" was answered for (`impairmentKey`, departure-gate.ts).
   * The gate re-asks when the live set differs. Absent on saves from before voyages, which
   * are treated as accepted for whatever is impaired now.
   */
  acceptedImpairmentKey?: string;
}

/**
 * Passengers-and-galaxy §2.3: a destination beyond one hop. Set on every stage while a voyage
 * runs; `plannedDestinationId`/`toPortId` is always the next hop on `shortestPath(here, voyage)`
 * (or a detour a card chose), and the field is cleared when the ship docks at the voyage
 * destination. Optional, so saves from before voyages load unchanged.
 */
export interface VoyageFields {
  voyageDestinationId?: PortDefId;
}

export type TravelState =
  | ({
      stage: "docked";
      portId: PortDefId;
      /** Set by `setCourse`; departure prep begins when cleared to go. */
      plannedDestinationId?: PortDefId;
      /**
       * D78: the course to `plannedDestinationId` is plotted (the nav terminal's `plotCourse`
       * commit). Departure prep waits for it; `setCourse` and a voyage's next hop clear it, and
       * the `preparingDeparture` object is built without it, so it never carries.
       */
      coursePlotted?: true;
    } & DepartureGateFlags &
      VoyageFields)
  | ({
      stage: Exclude<TravelStage, "docked">;
      fromPortId: PortDefId;
      toPortId: PortDefId;
      /** Progress in [0, 1] through timed stages (prep, undock, depart, approach, dock). */
      stageProgress: number;
      /** Route distance covered in transit, same units as `PortDef.routes.distance`. Never resets. */
      routeProgress: number;
      routeDistance: number;
      /** Propulsion lost: progress halted until repaired (SD §17.1: stranded ≠ destroyed). */
      drifting: boolean;
      stageStartedTick: Tick;
      /**
       * D61, `preparingDeparture` only: the tick prep first called someone on the dock aboard.
       * `travel.recallAboardSeconds` later, whoever is still there is brought aboard. Every
       * later stage builds a fresh object without it.
       */
      recallSinceTick?: Tick;
      /**
       * D66, `transit` and `approaching` only: the staging call for `toPortId`'s dock, from the
       * transit lead point until the dock comes alongside at the start of `docking`, where the
       * plan is spent (the `docking` object is built without it). Absent before the lead point,
       * and always at a port with no dock map.
       */
      staging?: DockStaging;
    } & DepartureGateFlags &
      VoyageFields);

/**
 * D66: where the guaranteed `stageDock` hook stands. `due`: the lead point has passed while
 * another hook was pending, so travel raises it the first tick none is. `raised`: the hook was
 * raised as `hookId`; while it is still `narrator.pendingHook` a `stageDock` command may set
 * `plan`, and once it is not (acknowledged) the call is answered and transit may end.
 */
export type DockStaging =
  | { status: "due" }
  | {
      status: "raised";
      hookId: HookId;
      /** The narrator's staging plan; absent when it staged nothing (the floor set only). */
      plan?: StagingPlan;
    };

// ---------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------

export type JobStatus =
  | "offered"
  | "accepted"
  | "declined"
  | "expired"
  | "inTransit"
  | "delivered"
  | "paid"
  | "failed";

export type JobOrigin = "portBoard" | "narrator" | "scenario";

/**
 * D25: the person offering a job. `org` is who they work for, when they work for anyone.
 * Added 2026-09-30 (schema 2); saves from schema 1 are migrated from the old `issuer` string.
 */
export interface JobIssuer {
  name: string;
  /** What they do, lower case: "dock foreman", "assay clerk". */
  role: string;
  org?: string;
}

/**
 * How pressing an offer sounds (presentation only: nothing in the sim enforces a deadline).
 * Added 2026-09-30.
 */
export const JOB_URGENCIES = ["relaxed", "soon", "urgent"] as const;
export type JobUrgency = (typeof JOB_URGENCIES)[number];

export interface CargoLine {
  itemDefId: ItemDefId;
  count: number;
}

/** Where a passage can end (passengers-and-galaxy §3). */
export type PassageEndReason = "completed" | "leftBehind" | "putOff";

/** Which stretch of the passage the passenger is on: outbound, ashore at `toPortId`, or homeward. */
export type PassageLeg = "out" | "ashore" | "back";

/**
 * Passengers-and-galaxy §3.1: a passage is a job with a person in it. The issuer is the
 * passenger; accepting the job spawns them aboard (`crew.passenger` template, issuer's name) and
 * `actorId` points at that actor. One-way (`roundTrip: false`) ends at `toPortId`; there-and-back
 * goes ashore at `toPortId` (`availability: offShip`, in the port's lounge store) and ends back at
 * `fromPortId`. `returnsAtTick` is drawn by the sim while ashore. `endReason` is set exactly once;
 * `completed` is the only ending that pays the fare. Optional on `Job`, so older saves load.
 */
export interface JobPassage {
  actorId: ActorId;
  roundTrip: boolean;
  leg: PassageLeg;
  returnsAtTick?: Tick;
  /** While ashore: the tick they went ashore; the overdue card is timed from it. */
  ashoreSinceTick?: Tick;
  endReason?: PassageEndReason;
}

/**
 * A commercial job (SD §17.3). Its cargo is real items: staged on the origin's dock while on
 * offer there (D63), or spawned in the origin's warehouse store on acceptance at a port without
 * a dock. Accepting raises `cargoToLoad` problems; delivery checks actual custody (the
 * destination's delivery bay, or its store), then pays exactly once (`paymentTransactionId`).
 */
export interface Job {
  id: JobId;
  origin: JobOrigin;
  /**
   * Display label of the issuer ("Ysolde Maren, Meridian Growers"), always
   * `issuerLabel(issuerPerson)` (systems/commerce) for jobs created since schema 2. Kept a string so existing readers
   * (the ticker, old saves) are unchanged; the structured person is `issuerPerson`.
   */
  issuer: string;
  /** D25 (schema 2): the person offering the job. */
  issuerPerson: JobIssuer;
  /** D25 (schema 2): one line of dialogue in the issuer's voice. Never mentions pay (D24). */
  pitch: TextRef;
  /** Schema 2: presentation-only urgency, shown as a word on the offer card. */
  urgency: JobUrgency;
  description: TextRef;
  fromPortId: PortDefId;
  toPortId: PortDefId;
  cargo: CargoLine[];
  cargoClass: CargoClass;
  /** Integer credits, validated against `config.commerce.priceBands`. */
  pay: number;
  status: JobStatus;
  offeredTick: Tick;
  expiresAtTick: Tick;
  /**
   * The job's freight items. D63: while `offered`, the crates staged on the origin's dock (owned
   * by nobody: no work exists for them; empty whenever the offer is not staged); once accepted,
   * the manifest. Empty for a closed offer and for a passage without luggage.
   */
  cargoItemIds: ItemId[];
  paymentTransactionId?: TransactionId;
  /**
   * Integration 2 addition: tick the offer was declined or expired. Drives the `captainAshore`
   * re-ask cooldown (`config.commerce.reofferDays`, D40).
   */
  closedTick?: Tick;
  /** Command that created it (narrator audit). */
  causeCommandId?: CommandId;
  /**
   * Passengers-and-galaxy §3: present when the issuer travels with the job. Its `cargo` is then
   * zero or one line of luggage, and `cargoClass` is the luggage's class (or `general`); pay is
   * banded by `config.commerce.priceBands.passenger` instead.
   */
  passage?: JobPassage;
}

// ---------------------------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------------------------

export interface Transaction {
  id: TransactionId;
  tick: Tick;
  /** Signed integer credits. */
  amount: number;
  reason: "jobPayment" | "purchase" | "fee" | "scenario";
  jobId?: JobId;
}

/**
 * W0 decision: money is an integer balance plus a full transaction table (small in V1); a job's
 * `paymentTransactionId` is the double-pay guard (SD §19.4).
 */
export interface MoneyState {
  balance: number;
  transactions: Record<TransactionId, Transaction>;
}
