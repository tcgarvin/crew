import { raiseHookIfIdle } from "./hooks";
import { allocateId } from "./ids";
/**
 * Kernel-raised ("policy") decisions and their narration (D37, 2026-10-01).
 *
 * Systems that put a card in front of the captain on their own (the departure gate, any future
 * repair or safety card) queue it through `queuePolicyDecision`. Before such a decision is
 * announced, phase 8 (`decisionPendingSystem`) raises a `policyDecision` hook for it, so the
 * host calls the narrator and has the card's prose in hand before the decision halt shows it;
 * `world.ts` keeps a decision that still needs narration from halting the world on its own.
 *
 * Job offers are excluded: the offer card already carries the issuer's pitch in their own voice
 * (D25), and a narrator call per offer would spend the hourly budget on cards that are dressed
 * already.
 */
import type { TextRef } from "./types/common";
import type { Decision, DecisionOption } from "./types/decisions";
import type { DecisionId, MachineId } from "./types/ids";
import type { StepCtx } from "./types/pipeline";
import type { WorldState } from "./types/state";

/** What a policy decision needs from its system; the kernel fills in the rest. */
export interface PolicyDecisionDraft {
  readonly perspectiveActorId: Decision["perspectiveActorId"];
  readonly prompt: TextRef;
  readonly left: DecisionOption;
  readonly right: DecisionOption;
  /** The machine the card is about, if any; also the `policyDecisionNeeded` event's location. */
  readonly machineId?: MachineId;
}

/** Create and queue a policy decision, emitting `policyDecisionNeeded`. Returns its id. */
export function queuePolicyDecision(ctx: StepCtx, draft: PolicyDecisionDraft): DecisionId {
  const decisionId: DecisionId = allocateId(ctx.state, "decision");
  ctx.state.decisions.records[decisionId] = {
    id: decisionId,
    origin: "policy",
    perspectiveActorId: draft.perspectiveActorId,
    prompt: draft.prompt,
    left: draft.left,
    right: draft.right,
    status: "pending",
    createdTick: ctx.tick,
  };
  ctx.state.decisions.queue.push(decisionId);
  ctx.emit({
    type: "policyDecisionNeeded",
    subjectIds: draft.machineId === undefined ? [decisionId] : [decisionId, draft.machineId],
    causeIds: [],
    source: "sim",
    ...(draft.machineId === undefined
      ? {}
      : { locationRef: { kind: "machine", machineId: draft.machineId } }),
    payload: { decisionId },
  });
  return decisionId;
}

/** A kernel-raised decision whose `policyDecision` hook has not been raised yet. */
export function needsNarration(decision: Decision | undefined): boolean {
  return (
    decision !== undefined &&
    decision.origin === "policy" &&
    decision.jobId === undefined &&
    decision.narratorHookId === undefined
  );
}

/** The head of the decision queue, when it still needs its `policyDecision` hook. */
export function headNeedingNarration(state: WorldState): Decision | undefined {
  const head = state.decisions.queue[0];
  if (head === undefined) return undefined;
  const decision = state.decisions.records[head];
  return needsNarration(decision) ? decision : undefined;
}

/**
 * Raise the `policyDecision` hook for the queue head if it needs one and no hook is pending.
 * The hook context names the machine when the prompt does (`params.machineId`), so the digest
 * can say which one.
 */
export function raisePolicyDecisionHookIfDue(ctx: StepCtx): boolean {
  const decision = headNeedingNarration(ctx.state);
  if (decision === undefined) return false;
  const machineId = decision.prompt.params.machineId;
  const context =
    typeof machineId === "string"
      ? { decisionId: decision.id, machineId: machineId as MachineId }
      : { decisionId: decision.id };
  if (!raiseHookIfIdle(ctx, "policyDecision", context)) return false;
  const hook = ctx.state.narrator.pendingHook;
  if (hook !== undefined) decision.narratorHookId = hook.id;
  return true;
}
