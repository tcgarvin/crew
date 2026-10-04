/**
 * Needs (SD §11.3), phase 5 ("needs"), every tick.
 *
 * Deficits in [0, 1] rise with time and fall with the matching activity. The activity itself is
 * read from `actor.activity` (owned by work); needs never starts or stops one: personal-need
 * activities are planner candidates, not problems (W0 decision 23).
 *
 * - hunger: rises at `hungerPerSecond`; eating reduces it at the meal's commit point (work).
 * - fatigue: rises at `fatiguePerSecondWorking` while on a task, `fatiguePerSecondAwake`
 *   otherwise; falls at `fatigueRecoveryPerSecondAsleep` while asleep in a bunk.
 * - comfort: falls at `comfortRecoveryPerSecondResting` while resting, socializing or asleep;
 *   rises at `comfortPerSecond` otherwise.
 * - social: falls at `socialRecoveryPerSecondChatting` while socializing; rises otherwise.
 * Rates are scaled by trait modifiers (`hungerRate`, `fatigueRate`, `comfortRate`, `socialRate`).
 *
 * W4a decision: severe fatigue impairs capacities through existing config, no new fields: above
 * `urgency.needSurvivalAbove`, `capacities.movement` and `.manipulation` fall linearly from 1 to
 * `movement.fatigueSpeedFloor` at fatigue 1.0 (bounded). Spatial already applies a mild,
 * whole-range fatigue speed factor; this only adds the "severe deprivation impairs" tail SD §11.3
 * asks for. Capacities are restored to 1 below the threshold (bodies are deferred, PLAN §7).
 *
 * W4a decision: "need critical" is `needThresholdCrossed` with `rising: true` at
 * `urgency.needSurvivalAbove`, emitted at `notable` significance (so it reaches the ticker);
 * crossing `needs.seekThreshold` either way is `trace`. No separate `needCritical` event kind.
 */
import type { KernelRegistry, Unregister } from "../../core/registry";
import type { Actor, NeedKey } from "../../core/types/actor";
import type { TraitModifierKey } from "../../core/types/content";
import type { StepCtx, System } from "../../core/types/pipeline";
import { currentHold } from "../work/activity";

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

const RATE_MODIFIER: Readonly<Record<NeedKey, TraitModifierKey>> = {
  hunger: "hungerRate",
  fatigue: "fatigueRate",
  comfort: "comfortRate",
  social: "socialRate",
};

function traitMultiplier(ctx: StepCtx, actor: Actor, key: TraitModifierKey): number {
  let multiplier = 1;
  for (const traitId of actor.traits) {
    multiplier *= ctx.defs.trait(traitId).modifiers[key] ?? 1;
  }
  return multiplier;
}

/** Signed change per second for each need given what the actor is doing now. */
function needRates(ctx: StepCtx, actor: Actor): Record<NeedKey, number> {
  const needs = ctx.config.needs;
  const hold = currentHold(actor.activity);
  const asleep = hold === "sleep";
  const resting = asleep || hold === "rest" || hold === "socialize";
  const working = actor.activity.kind === "task";
  const fatigue = asleep
    ? -needs.fatigueRecoveryPerSecondAsleep
    : working
      ? needs.fatiguePerSecondWorking
      : needs.fatiguePerSecondAwake;
  return {
    hunger: needs.hungerPerSecond,
    fatigue,
    comfort: resting ? -needs.comfortRecoveryPerSecondResting : needs.comfortPerSecond,
    social: hold === "socialize" ? -needs.socialRecoveryPerSecondChatting : needs.socialPerSecond,
  };
}

function emitCrossings(ctx: StepCtx, actor: Actor, key: NeedKey, before: number, after: number) {
  const survival = ctx.config.urgency.needSurvivalAbove;
  const seek = ctx.config.needs.seekThreshold;
  const critical = before <= survival && after > survival;
  if (!critical && before <= seek === after <= seek) return;
  ctx.emit({
    type: "needThresholdCrossed",
    subjectIds: [actor.id],
    causeIds: [],
    source: "sim",
    ...(critical ? { significance: "notable" as const } : {}),
    // A critical crossing is always rising (`before` ≤ survival < `after`).
    payload: { need: key, value: after, rising: after > before },
  });
}

/** Bounded capacity curve for severe fatigue (see module doc). */
export function fatigueCapacity(fatigue: number, severeAbove: number, floor: number): number {
  if (fatigue <= severeAbove || severeAbove >= 1) return 1;
  const t = clamp01((fatigue - severeAbove) / (1 - severeAbove));
  return clamp01(1 - (1 - clamp01(floor)) * t);
}

function updateActor(ctx: StepCtx, actor: Actor, dt: number): void {
  const rates = needRates(ctx, actor);
  for (const key of Object.keys(rates) as NeedKey[]) {
    const rate = rates[key];
    // Trait modifiers scale deprivation, not recovery.
    const scaled = rate > 0 ? rate * traitMultiplier(ctx, actor, RATE_MODIFIER[key]) : rate;
    const before = actor.needs[key];
    const after = clamp01(before + scaled * dt);
    if (after !== before) {
      actor.needs[key] = after;
      emitCrossings(ctx, actor, key, before, after);
    }
  }
  const capacity = fatigueCapacity(
    actor.needs.fatigue,
    ctx.config.urgency.needSurvivalAbove,
    ctx.config.movement.fatigueSpeedFloor,
  );
  if (actor.capacities.movement !== capacity || actor.capacities.manipulation !== capacity) {
    actor.capacities.movement = capacity;
    actor.capacities.manipulation = capacity;
  }
}

export const needsSystem: System = {
  name: "needs.needs",
  phase: "needs",
  run(ctx) {
    const dt = ctx.elapsedTicks / ctx.config.time.tickRate;
    for (const actor of Object.values(ctx.state.actors)) {
      if (!actor.crew || actor.availability !== "available") continue;
      updateActor(ctx, actor, dt);
    }
  },
};

export function registerNeeds(registry: KernelRegistry): Unregister {
  return registry.registerSystem(needsSystem);
}
