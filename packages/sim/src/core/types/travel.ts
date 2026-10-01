/**
 * Travel, jobs and money (SD §17). Ownership: `travel` by the travel system (W6); `jobs` and
 * `money` by commerce (W6).
 */
import type { TextRef, Tick } from "./common";
import type { CargoClass } from "./content";
import type { CommandId, ItemDefId, ItemId, JobId, PortDefId, TransactionId } from "./ids";

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
 * `plannedDestinationId`, or `preparingDeparture`). Both are dropped by the fresh state object
 * every later stage builds, so "leave anyway" is forgotten by the next docking and a hold never
 * outlives the departure it held.
 */
export interface DepartureGateFlags {
  /** "Hold for repairs": wait docked until no engine/generator is impaired, then go. */
  holdForRepairs?: boolean;
  /** "Leave anyway": the gate does not ask again for this docking. */
  departureRiskAccepted?: boolean;
}

export type TravelState =
  | ({
      stage: "docked";
      portId: PortDefId;
      /** Set by `setCourse`; departure prep begins when cleared to go. */
      plannedDestinationId?: PortDefId;
    } & DepartureGateFlags)
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
    } & DepartureGateFlags);

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

/**
 * A commercial job (SD §17.3). Accepting spawns the cargo as real items in the origin port's
 * warehouse store (boundary custody) and raises `cargoToLoad` problems; delivery checks actual
 * custody in the destination store, then pays exactly once (`paymentTransactionId`).
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
  /** Spawned freight, once accepted. */
  cargoItemIds: ItemId[];
  paymentTransactionId?: TransactionId;
  /**
   * Integration 2 addition: tick the offer was declined or expired. Drives the `jobBoard`
   * re-ask cooldown (`config.commerce.reofferSeconds`, D40).
   */
  closedTick?: Tick;
  /** Command that created it (narrator audit). */
  causeCommandId?: CommandId;
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
