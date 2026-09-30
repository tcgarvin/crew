/** Perception and communication events. */
import type { FactType } from "../actor";
import type { SignificanceCatalog } from "./significance";

export interface PerceptionEventPayloads {
  /** A report reached its recipient (SD §13.3). Subjects: sender, recipient, fact subject. */
  reportDelivered: { readonly factType: FactType };
  /** Deferred with atmosphere (PLAN §7); reserved to match SD §19.3. */
  breachChanged: { readonly open: boolean };
}

export const PERCEPTION_EVENT_SIGNIFICANCE = {
  reportDelivered: "trace",
  breachChanged: "narrative",
} as const satisfies SignificanceCatalog<PerceptionEventPayloads>;
