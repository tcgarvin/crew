/** Commerce and custody events (W6). */
import type { PhysicalLocation } from "../common";
import type { EntityId, ItemId, JobId, TransactionId } from "../ids";
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
} as const satisfies SignificanceCatalog<CommerceEventPayloads>;
