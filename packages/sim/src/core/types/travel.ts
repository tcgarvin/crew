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

export type TravelState =
  | {
      stage: "docked";
      portId: PortDefId;
      /** Set by `setCourse`; departure prep begins when cleared to go. */
      plannedDestinationId?: PortDefId;
    }
  | {
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
  issuer: string;
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
   * Integration 2 addition: tick the offer was declined or expired. Drives the job source's
   * re-offer cooldown (`config.commerce.reofferSeconds`).
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
