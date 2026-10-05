/**
 * The `recreate` step (slice 4, call 4). On its first tick a `host` opens a session (or joins
 * one already open for the activity at the venue), a `join` joins `sessionId` (full, gone, or
 * running past `recreation.lateJoinSeconds`: fail `occupiedPosition`, which backs off), a `solo`
 * starts counting. Waiting while the session is open; counting while solo or started; done when
 * the session is gone after starting, or at `ticksNeeded` solo. A collapse to solo rewrites the
 * step (`role: "solo"`, the def's `solo.durationDays`). The step's labels are `labels.ts`
 * `recreateLabel`'s.
 *
 * Owner: W1 of ship life slice 4. Gate stub: throws (no plan contains the step yet).
 */
import { NotImplementedError } from "../../core/registry";
import type { Actor } from "../../core/types/actor";
import type { StepCtx } from "../../core/types/pipeline";
import type { ActivityStep } from "../../core/types/work";
import type { StepResult } from "../work/steps";

export function runRecreate(
  _ctx: StepCtx,
  _actor: Actor,
  _step: Extract<ActivityStep, { kind: "recreate" }>,
): StepResult {
  throw new NotImplementedError("runRecreate (slice 4 W1)");
}
