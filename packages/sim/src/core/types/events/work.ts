/** Work events (W4): problems, tasks, claims, actions. */
import type { ClaimId, ItemId, ProblemId, TaskId } from "../ids";
import type {
  ActionKind,
  BlockageReason,
  PersonalActivity,
  ProblemKind,
  TaskType,
  UrgencyClass,
} from "../work";
import type { SignificanceCatalog } from "./significance";

/** W4a addition: why a claim was released. */
export type TaskReleaseReason = "interrupted" | "failed" | "incapacitated" | "cancelled";

export interface WorkEventPayloads {
  problemRaised: { readonly problemId: ProblemId; readonly kind: ProblemKind };
  problemResolved: { readonly problemId: ProblemId; readonly kind: ProblemKind };
  taskCreated: { readonly taskId: TaskId; readonly type: TaskType; readonly problemId: ProblemId };
  /** SD §19.3 "task selected": subject is the actor. */
  taskSelected: { readonly taskId: TaskId; readonly urgency: UrgencyClass };
  personalActivityStarted: { readonly activity: PersonalActivity; readonly urgency: UrgencyClass };
  taskBlocked: { readonly taskId: TaskId; readonly reason: BlockageReason };
  /**
   * Subjects: task, problem, then the actors who held it (Integration 2). `haul` (Integration 2
   * addition) names the item moved and which way, so the ticker can say who carried what.
   */
  taskCompleted: {
    readonly taskId: TaskId;
    readonly haul?: { readonly itemId: ItemId; readonly to: "ship" | "port" };
  };
  claimExpired: { readonly taskId: TaskId };
  /** W4a addition: an actor took a lease on a task. Subjects: actor, task. */
  taskClaimed: { readonly taskId: TaskId; readonly claimId: ClaimId };
  /** W4a addition: a claim ended without completion (interrupt, failure, incapacity, cancel). */
  taskReleased: { readonly taskId: TaskId; readonly reason: TaskReleaseReason };
  /** W4a addition: minimal perception noticed a `discovered` problem. Subjects: actor, problem. */
  problemObserved: { readonly problemId: ProblemId; readonly kind: ProblemKind };
  actionStarted: { readonly action: ActionKind };
  actionCompleted: { readonly action: ActionKind };
  actionFailed: { readonly action: ActionKind; readonly reason: BlockageReason };
}

export const WORK_EVENT_SIGNIFICANCE = {
  problemRaised: "notable",
  problemResolved: "notable",
  taskCreated: "trace",
  taskSelected: "trace",
  personalActivityStarted: "trace",
  taskBlocked: "trace",
  taskCompleted: "trace",
  claimExpired: "trace",
  taskClaimed: "trace",
  taskReleased: "trace",
  problemObserved: "trace",
  actionStarted: "trace",
  actionCompleted: "trace",
  actionFailed: "trace",
} as const satisfies SignificanceCatalog<WorkEventPayloads>;
