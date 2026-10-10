/** Kernel-core events (W2): command lifecycle and invariant checks. */
import type { CommandKind, CommandRejection } from "../commands";
import type { CallBackWhen } from "../decisions";
import type { EntityId, TempRef } from "../ids";
import type { SignificanceCatalog } from "./significance";

export interface KernelEventPayloads {
  /** A command applied. `tempRefs` maps each `$ref` in the command to the ID it created. */
  commandApplied: {
    readonly kind: CommandKind;
    readonly tempRefs: Readonly<Record<TempRef, EntityId>>;
  };
  /** A queued command failed revalidation at apply time. */
  commandRejected: { readonly kind: CommandKind; readonly rejection: CommandRejection };
  /** An enabled invariant check failed (diagnostics; the tick still completes). */
  invariantViolated: { readonly invariant: string; readonly detail: string };
  /** §requested-call-back: the narrator's call-back request was replaced (`requestCall`). */
  callBackRequested: { readonly when: CallBackWhen };
}

export const KERNEL_EVENT_SIGNIFICANCE = {
  commandApplied: "trace",
  commandRejected: "notable",
  invariantViolated: "notable",
  callBackRequested: "trace",
} as const satisfies SignificanceCatalog<KernelEventPayloads>;
