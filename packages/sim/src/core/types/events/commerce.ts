/** Commerce and custody events (W6). */
import type { PhysicalLocation } from "../common";
import type { ActorId, EntityId, ItemDefId, ItemId, JobId, PortDefId, TransactionId } from "../ids";
import type { PassageEndReason } from "../travel";
import type { SignificanceCatalog } from "./significance";

export interface CommerceEventPayloads {
  jobOffered: { readonly jobId: JobId };
  jobAccepted: { readonly jobId: JobId };
  jobDeclined: { readonly jobId: JobId };
  jobExpired: { readonly jobId: JobId };
  /** An item changed custody across the ship/port boundary or between holders. */
  cargoTransferred: {
    readonly itemId: ItemId;
    readonly from: PhysicalLocation;
    readonly to: PhysicalLocation;
  };
  contractCompleted: { readonly jobId: JobId };
  paymentMade: {
    readonly transactionId: TransactionId;
    readonly amount: number;
    readonly jobId?: JobId;
  };
  /**
   * D63: an offer's crates were set out on the staging area of its origin's dock (on offer, or
   * when the dock came alongside). Nobody's until the job is accepted.
   */
  freightStaged: { readonly jobId: JobId; readonly portId: PortDefId; readonly count: number };
  /** D63: a declined, expired or departed-from offer's staged crates went back in. */
  freightWithdrawn: { readonly jobId: JobId; readonly portId: PortDefId };
  /** Anything created by a spawn command (boundary or scenario). */
  entitySpawned: { readonly entityId: EntityId; readonly defId: string };
  /**
   * D47: the crew bought `count` of `itemDefId` from the market at `portId` for `cost` credits in
   * all. Subjects: the buyer, then the item(s) that landed aboard.
   */
  partsBought: {
    readonly portId: PortDefId;
    readonly itemDefId: ItemDefId;
    readonly count: number;
    readonly cost: number;
  };
  /** D47: a `stockMarket` command set a port's stock of one item (count 0 = withdrawn). */
  marketStocked: {
    readonly portId: PortDefId;
    readonly itemDefId: ItemDefId;
    readonly count: number;
    readonly price: number;
  };
  /** Passengers-and-galaxy §3.5: the passenger of `jobId` came aboard at the personnel ramp. */
  passengerBoarded: PassengerEvent;
  /** The passenger went ashore at the job's destination (round trip); they are off ship now. */
  passengerAshore: PassengerEvent & { readonly portId: PortDefId };
  /** The passenger walked back aboard; the voyage home may leave. The turn of the episode. */
  passengerReturned: PassengerEvent;
  /** The passage ended, for any reason; `completed` is the only one that pays. */
  passageEnded: PassengerEvent & { readonly reason: PassageEndReason; readonly portId: PortDefId };
}

/** What every passenger event carries: the job, the actor, and their name (for ticker and digest). */
export interface PassengerEvent {
  readonly jobId: JobId;
  readonly actorId: ActorId;
  readonly name: string;
}

export const COMMERCE_EVENT_SIGNIFICANCE = {
  jobOffered: "notable",
  jobAccepted: "narrative",
  jobDeclined: "notable",
  jobExpired: "trace",
  cargoTransferred: "trace",
  contractCompleted: "narrative",
  paymentMade: "notable",
  entitySpawned: "trace",
  // D63: the offer and its card already carry the story; the crates appearing is scenery.
  freightStaged: "trace",
  freightWithdrawn: "trace",
  // D47: a purchase is a story beat the narrator may react to; stocking is the narrator's own
  // quiet hand and never reaches the ticker.
  partsBought: "narrative",
  marketStocked: "trace",
  // Passengers §3.5: boarding follows the offer card by seconds and going ashore is already
  // covered by `approachingPort`, so neither is hook-worthy; the return and the ending are.
  passengerBoarded: "notable",
  passengerAshore: "notable",
  passengerReturned: "narrative",
  passageEnded: "narrative",
} as const satisfies SignificanceCatalog<CommerceEventPayloads>;
