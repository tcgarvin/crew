/**
 * The V1 selector (SD §15.3, steps 1, 5 and 6 only; deadlines and scarce-skill cost are W4b).
 * A pure function of the `AgentView` and planner config: no state, no RNG, no clock.
 *
 * 1. Take the highest urgency class with an executable candidate (rejected candidates — claimed
 *    by someone else, backing off, blocked, missing skill/tool, unreachable — never compete).
 * 5. Within it prefer the lowest estimated time to useful intervention (travel + acquisition +
 *    work), quantised to `work.timeBucketSeconds` buckets.
 * 6. Then higher relevant skill, then older task, then stable id.
 *
 * Commitment (SD §14.6): a current activity is kept against same- or lower-class candidates. A
 * higher class interrupts, except that an activity younger than `work.switchCooldownSeconds` is
 * only interrupted by containment or above (W4a decision: the cooldown damps flip-flopping when
 * a need crosses its seek threshold right after the actor committed to something else).
 *
 * Output: `continue` (keep going), `idle` (nothing to do and not doing anything), or a `task` /
 * `personal` intent carrying an SD §15.7 compact trace (the pipeline stores it in the bounded
 * `caches.diagnostics.plannerTraces` ring; W4a decision: no separate trace sink on the view,
 * because `Intent.trace` already carries it and `continue` intents are deliberately not logged).
 */
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView } from "../core/types/view";
import type { Intent, PlannerTrace } from "../core/types/work";
import {
  type Candidate,
  type Rejection,
  enumerateCandidates,
  matchesActivity,
  urgencyIndex,
} from "./candidates";

const MAX_TRACE_REJECTIONS = 6;

function bucketTicks(config: PlannerConfig): number {
  return Math.max(1, Math.round(config.work.timeBucketSeconds * config.time.tickRate));
}

export function compareCandidates(a: Candidate, b: Candidate, config: PlannerConfig): number {
  const bucket = bucketTicks(config);
  return (
    urgencyIndex(a.urgency) - urgencyIndex(b.urgency) ||
    Math.floor(a.estimateTicks / bucket) - Math.floor(b.estimateTicks / bucket) ||
    b.skill - a.skill ||
    a.ageTick - b.ageTick ||
    (a.stableId < b.stableId ? -1 : a.stableId > b.stableId ? 1 : 0)
  );
}

function trace(
  best: Candidate,
  count: number,
  rejected: readonly Rejection[],
  config: PlannerConfig,
  note: string,
): PlannerTrace {
  const seconds = (best.estimateTicks / config.time.tickRate).toFixed(1);
  return {
    candidates: count,
    chosenReason: `${best.ref} ${best.urgency} est=${seconds}s skill=${best.skill}${note}`,
    rejected: rejected
      .slice(0, MAX_TRACE_REJECTIONS)
      .map((r) => ({ ref: r.ref, reason: r.reason })),
  };
}

function toIntent(best: Candidate, t: PlannerTrace): Intent {
  const choice = best.choice;
  if (choice.kind === "task")
    return { kind: "task", taskId: choice.taskId, urgency: best.urgency, trace: t };
  return {
    kind: "personal",
    activity: choice.activity,
    ...(choice.targetId === undefined ? {} : { targetId: choice.targetId }),
    ...(choice.itemId === undefined ? {} : { itemId: choice.itemId }),
    ...(choice.tile === undefined ? {} : { tile: { x: choice.tile.x, y: choice.tile.y } }),
    urgency: best.urgency,
    trace: t,
  };
}

export function selectIntent(view: AgentView, config: PlannerConfig): Intent {
  const { candidates, rejected } = enumerateCandidates(view, config);
  const ranked = [...candidates].sort((a, b) => compareCandidates(a, b, config));
  const best = ranked[0];
  const activity = view.self.activity;
  if (activity.kind === "idle") {
    return best === undefined
      ? { kind: "idle" }
      : toIntent(best, trace(best, ranked.length, rejected, config, ""));
  }
  if (best === undefined || matchesActivity(best, activity)) return { kind: "continue" };
  const currentClass = urgencyIndex(activity.urgency);
  const bestClass = urgencyIndex(best.urgency);
  if (bestClass >= currentClass) return { kind: "continue" };
  const age = view.tick - activity.sinceTick;
  const cooldown = config.work.switchCooldownSeconds * config.time.tickRate;
  if (age < cooldown && bestClass > urgencyIndex("containment")) return { kind: "continue" };
  return toIntent(
    best,
    trace(best, ranked.length, rejected, config, ` interrupts ${activity.urgency}`),
  );
}
