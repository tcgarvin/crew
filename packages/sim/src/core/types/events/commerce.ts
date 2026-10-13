/** Commerce and custody events (W6). */
import type { PhysicalLocation } from "../common";
import type {
  ActorId,
  CompartmentId,
  EntityId,
  ItemDefId,
  ItemId,
  JobId,
  LocalId,
  PortDefId,
  TransactionId,
} from "../ids";
import type { ErrandOutcome, PassageEndReason } from "../travel";
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
  /** §fragile-cargo: `brokenCount` of the job's crates arrived smashed (0 for most jobs). */
  contractCompleted: { readonly jobId: JobId; readonly brokenCount: number };
  /** §fragile-cargo: a rock smashed one fragile crate of a live freight job. */
  cargoBroken: {
    readonly jobId: JobId;
    readonly itemId: ItemId;
    readonly compartmentId: CompartmentId;
  };
  paymentMade: {
    readonly transactionId: TransactionId;
    readonly amount: number;
    readonly jobId?: JobId;
  };
  /**
   * §money-levers: the narrator's `transact` moved `amount` signed credits (positive in, negative
   * out) with `counterparty`, for `memo`.
   */
  transacted: {
    readonly transactionId: TransactionId;
    readonly amount: number;
    readonly memo: string;
    readonly counterparty: string;
  };
  /**
   * §offered-freight: an offer's crates were set out on the staging area of its origin's dock (on
   * offer, or when the dock came alongside). Nobody's until the job is accepted.
   */
  freightStaged: { readonly jobId: JobId; readonly portId: PortDefId; readonly count: number };
  /** §offered-freight: a declined, expired or departed-from offer's staged crates went back in. */
  freightWithdrawn: { readonly jobId: JobId; readonly portId: PortDefId };
  /**
   * §dock-hand-errands: a dock hand's carting errand could not be walked (no route, or it ran past
   * `travel.dockHandGiveUpSeconds`, or the dock was cast off first), so the instant
   * behaviour did it: crates set out, withdrawn or taken in at once.
   */
  dockHandGaveUp: {
    readonly localId: LocalId;
    readonly jobId: JobId;
    readonly errand: "stageOffer" | "withdrawOffer" | "takeDelivery";
    readonly reason: "noRoute" | "timeout" | "castOff";
  };
  /** Anything created by a spawn command (boundary or scenario). */
  entitySpawned: { readonly entityId: EntityId; readonly defId: string };
  /**
   * §buying-parts: the crew bought `count` of `itemDefId` from the market at `portId` for `cost`
   * credits in all. Subjects: the buyer, then the item(s) that landed aboard.
   */
  partsBought: {
    readonly portId: PortDefId;
    readonly itemDefId: ItemDefId;
    readonly count: number;
    readonly cost: number;
  };
  /**
   * §market-lever: a `stockMarket` command set a port's stock of one item (count 0 = withdrawn).
   */
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
  /**
   * Expeditions A2 (§6): a job ended unpaid: an errand that failed at the site (`failed`), or its
   * captive put off or left behind (the passage's ending).
   */
  jobFailed: { readonly jobId: JobId; readonly outcome: ErrandOutcome | PassageEndReason };
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
  // §fragile-cargo: the ticker and the digest tell it; the delivery that pays less is the hook.
  cargoBroken: "notable",
  paymentMade: "notable",
  transacted: "narrative",
  entitySpawned: "trace",
  // §offered-freight: the offer and its card already carry the story; the crates appearing is
  // scenery.
  freightStaged: "trace",
  freightWithdrawn: "trace",
  dockHandGaveUp: "trace",
  // §buying-parts: a purchase is a story beat the narrator may react to; stocking is the narrator's
  // own quiet hand and never reaches the ticker.
  partsBought: "narrative",
  marketStocked: "trace",
  // Passengers §3.5: boarding follows the offer card by seconds and going ashore is already
  // covered by the arrival, so neither is hook-worthy; the return and the ending are.
  passengerBoarded: "notable",
  passengerAshore: "notable",
  passengerReturned: "narrative",
  passageEnded: "narrative",
  jobFailed: "narrative",
} as const satisfies SignificanceCatalog<CommerceEventPayloads>;
