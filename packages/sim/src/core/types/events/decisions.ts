import type { NarratorHookKind } from "../decisions";
/** Decision and narrator-hook events. */
import type { DecisionId, HookId } from "../ids";
import type { SignificanceCatalog } from "./significance";

export interface DecisionEventPayloads {
  /** SD §16: crew will not act without authority; a policy decision was queued. */
  policyDecisionNeeded: { readonly decisionId: DecisionId };
  decisionPending: { readonly decisionId: DecisionId };
  decisionResolved: { readonly decisionId: DecisionId; readonly side: "left" | "right" };
  /** A queued decision failed revalidation on presentation. */
  decisionDropped: { readonly decisionId: DecisionId; readonly reason: string };
  narratorHookRaised: { readonly hookId: HookId; readonly kind: NarratorHookKind };
  narratorHookResolved: { readonly hookId: HookId };
}

export const DECISION_EVENT_SIGNIFICANCE = {
  policyDecisionNeeded: "narrative",
  decisionPending: "notable",
  decisionResolved: "narrative",
  decisionDropped: "notable",
  narratorHookRaised: "trace",
  narratorHookResolved: "trace",
} as const satisfies SignificanceCatalog<DecisionEventPayloads>;
