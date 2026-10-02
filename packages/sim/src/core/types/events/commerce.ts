/** Commerce and custody events (W6). */
import type { PhysicalLocation } from "../common";
import type { EntityId, ItemDefId, ItemId, JobId, PortDefId, TransactionId } from "../ids";
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
  // D47: a purchase is a story beat the narrator may react to; stocking is the narrator's own
  // quiet hand and never reaches the ticker.
  partsBought: "narrative",
  marketStocked: "trace",
} as const satisfies SignificanceCatalog<CommerceEventPayloads>;
