import type { ProblemId, TaskId } from "../ids";
/** Work events (W4): problems, tasks, claims, actions. */
import type {
  ActionKind,
  BlockageReason,
  PersonalActivity,
  ProblemKind,
  TaskType,
  UrgencyClass,
} from "../work";
import type { SignificanceCatalog } from "./significance";

export interface WorkEventPayloads {
  problemRaised: { readonly problemId: ProblemId; readonly kind: ProblemKind };
  problemResolved: { readonly problemId: ProblemId; readonly kind: ProblemKind };
  taskCreated: { readonly taskId: TaskId; readonly type: TaskType; readonly problemId: ProblemId };
  /** SD §19.3 "task selected": subject is the actor. */
  taskSelected: { readonly taskId: TaskId; readonly urgency: UrgencyClass };
  personalActivityStarted: { readonly activity: PersonalActivity; readonly urgency: UrgencyClass };
  taskBlocked: { readonly taskId: TaskId; readonly reason: BlockageReason };
  taskCompleted: { readonly taskId: TaskId };
  claimExpired: { readonly taskId: TaskId };
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
  actionStarted: "trace",
  actionCompleted: "trace",
  actionFailed: "trace",
} as const satisfies SignificanceCatalog<WorkEventPayloads>;
