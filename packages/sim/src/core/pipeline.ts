/**
 * The tick pipeline (SD §5.2–5.3). `runStep` executes one tick: every registered entry in
 * `PHASES` order (see `registry.pipeline()`), honouring cadence and actor staggering, then
 * finalises the tick's events (phase 8).
 */
import { rebuildActorIndex, rebuildItemIndexes } from "./caches";
import { dayTicks } from "./clock";
import { applyDueCommands, pushCapped } from "./commands";
import { raisePolicyDecisionHookIfDue } from "./decisions";
import { createDefLookup } from "./defs";
import { createEventBuffer } from "./events";
import { raiseHookIfIdle } from "./hooks";
import type { KernelRegistry } from "./registry";
import { createRngApi } from "./rng";
import type { ConfigDef } from "./types/content";
import type { SimEvent } from "./types/events";
import type { ActorId } from "./types/ids";
import type { World } from "./types/kernel";
import type { PlannerConfig, PlannerStage, StepCtx, System } from "./types/pipeline";

/** Is the actor at `index` due on `tick` for a cadence of `every` ticks? */
export function isStaggerDue(tick: number, index: number, every: number): boolean {
  return tick % every === index % every;
}

/** Actors (in `state.actors` key order) due this tick for a staggered cadence. */
export function dueActors(
  actorIds: readonly ActorId[],
  tick: number,
  every: number,
): readonly ActorId[] {
  return actorIds.filter((_, index) => isStaggerDue(tick, index, every));
}

type BaseCtx = Omit<StepCtx, "elapsedTicks" | "dueActorIds">;

/**
 * Run one tick and return its committed events. `state.tick` advances by one.
 *
 * W2 decision on cadence: a non-staggered system with `every: N` runs on ticks where
 * `tick % N === 0` and receives `elapsedTicks = N` (stateless, so it survives save/restore). A
 * `staggerBy: "actor"` system runs every tick that has at least one due actor, with
 * `dueActorIds` = actors whose index `i` satisfies `tick % N === i % N`, and `elapsedTicks = N`.
 */
export function runStep(world: World, registry: KernelRegistry): SimEvent[] {
  const { state, caches, content } = world;
  const config = world.config.values;
  const tick = state.tick + 1;
  const buffer = createEventBuffer();
  const base: BaseCtx = {
    state,
    caches,
    content,
    defs: createDefLookup(content, state),
    config,
    rng: createRngApi(state),
    emit: buffer.emit,
    tick,
    dirty: caches.dirty,
  };
  const actorIds = Object.keys(state.actors) as ActorId[];

  for (const entry of registry.pipeline()) {
    if (entry.kind === "planner") {
      runPlannerStage(world, registry, entry, base, actorIds);
      continue;
    }
    const every = entry.every ?? 1;
    if (entry.staggerBy === "actor") {
      const due = dueActors(actorIds, tick, every);
      if (due.length > 0) entry.run({ ...base, elapsedTicks: every, dueActorIds: due });
    } else if (tick % every === 0) {
      entry.run({ ...base, elapsedTicks: every });
    }
  }

  // Phase 8 commit: the tick is complete, stamp its events.
  state.tick = tick;
  const events = buffer.finalize(state, tick);
  recordFinalizedEvents(world, events);
  return events;
}

/**
 * Does `event` call the narrator (a `notableEvent` hook)? A `narrative` event whose type is in
 * `narrator.hookOnEvents`, or (§notable-event-hook) an aftermath event of any significance whose
 * type is in `narrator.aftermathHookOnEvents` and that passes its type's filter: `faultRepaired`
 * only for a fault something caused (a scheduled fault, a hazard scrape, a field impact; never
 * wear) and not while a field is on, when the field's own calls cover it; `alertCleared` only for a
 * field's alert (a fight's is not the narrator's in A1).
 */
export function hooksNarrator(
  event: SimEvent,
  state: World["state"],
  narrator: Pick<ConfigDef["narrator"], "hookOnEvents" | "aftermathHookOnEvents">,
): boolean {
  if (event.significance === "narrative" && narrator.hookOnEvents.includes(event.type)) {
    return true;
  }
  if (!narrator.aftermathHookOnEvents.includes(event.type)) return false;
  switch (event.type) {
    case "faultRepaired":
      return event.causeIds.length > 0 && state.field === undefined;
    // Expeditions A1 (call 4): the narrator hears nothing of a fight until A2.
    case "alertCleared":
      return event.payload.cause === "field";
    default:
      return true;
  }
}

/**
 * Bookkeeping over the committed events: the quiet timer's input (`narrative` events only), the
 * last narrative event (a hookable one, `hooksNarrator`, wins within a tick, whatever its
 * significance), the `notableEvent` owed for a hookable one (§notable-event-hook) and the trace
 * ring.
 */
function recordFinalizedEvents(world: World, events: readonly SimEvent[]): void {
  const { state, caches } = world;
  const ringSize = world.config.values.events.traceRingSize;
  const narrator = world.config.values.narrator;
  let hookableSeen = false;
  for (const event of events) {
    const isHookable = hooksNarrator(event, state, narrator);
    const isNarrative = event.significance === "narrative";
    if (isNarrative) state.narrator.lastNarrativeTick = event.tick;
    if (isHookable || (isNarrative && !hookableSeen)) {
      state.narrator.lastNarrativeEvent = { tick: event.tick, type: event.type, eventId: event.id };
    }
    hookableSeen ||= isHookable;
    if (event.significance === "trace") caches.diagnostics.traceEvents.push(event);
  }
  // §notable-event-hook: owed a `notableEvent` until travel raises it (or a later story hook covers
  // it).
  const last = state.narrator.lastNarrativeEvent;
  if (hookableSeen && last !== undefined) state.narrator.pendingNotable = { ...last };
  const ring = caches.diagnostics.traceEvents;
  if (ring.length > ringSize) ring.splice(0, ring.length - ringSize);
}

/**
 * Phase 7 planner stage: for each due crew actor, build its `AgentView`, call the planner and
 * store the `Intent` as `actor.pendingIntent` for the work system to act on next tick. Cadence
 * is `config.work.reconsiderEveryTicks`, staggered by actor.
 *
 * W2 decision: only crew with availability `available` are planned; "plan immediately when the
 * current action is invalid" is left to the work system (W4), which can clear or overwrite
 * `pendingIntent` itself.
 */
function runPlannerStage(
  world: World,
  registry: KernelRegistry,
  stage: PlannerStage,
  base: BaseCtx,
  actorIds: readonly ActorId[],
): void {
  const { state, caches } = world;
  const config = world.config.values;
  const plannerConfig: PlannerConfig = {
    work: config.work,
    urgency: config.urgency,
    needs: config.needs,
    time: config.time,
    galley: config.galley,
    recreation: config.recreation,
    social: config.social,
    mood: config.mood,
    field: config.field,
    damage: config.damage,
    intercom: config.intercom,
    expedition: config.expedition,
    bodies: config.bodies,
    medical: config.medical,
  };
  const due = dueActors(actorIds, base.tick, config.work.reconsiderEveryTicks);
  for (const actorId of due) {
    const actor = state.actors[actorId];
    if (actor === undefined || !actor.crew || actor.availability !== "available") continue;
    const view = registry.buildAgentView(world, actorId);
    const intent = stage.planner(view, plannerConfig);
    actor.pendingIntent = intent;
    actor.lastPlannedTick = base.tick;
    if (intent.kind === "task" || intent.kind === "personal") {
      pushCapped(
        caches.diagnostics.plannerTraces,
        { tick: base.tick, actorId, intent },
        config.events.traceRingSize,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Core systems
// ---------------------------------------------------------------------------------------------

/**
 * Quiet-too-long timer (phase 8, after `decisionPendingSystem`). Reads
 * `state.narrator.lastNarrativeTick`, which phase 8 commit writes from the previous ticks'
 * committed events (never the current buffer) and `raiseHookIfIdle` writes whenever any hook
 * is raised. While a hook is pending the timer does not fire; the sim is halted anyway, so no
 * ticks accrue.
 *
 * W2 decision: the contract's `lastNarrativeTick` (narrative-significance events) drives the
 * timer, not a separate notable counter. Raising the hook re-arms the timer by setting
 * `lastNarrativeTick` to the raise tick, so after `acknowledgeHook` the next hook needs another
 * full quiet window.
 *
 * Pacing follow-up (passengers-and-galaxy §2.2): a quiet check-in means `quietTooLongDays`
 * with no narrator contact at all, so every hook kind re-arms the timer (see `core/hooks.ts`),
 * and the timer runs last in the tick so that any other hook raised in the same tick
 * (`stageDock`, `captainAshore`, `notableEvent` in phase 4; `policyDecision` just before this
 * system) wins and the quiet one yields.
 */
const quietTimerSystem: System = {
  name: "core.quietTimer",
  phase: "finalize",
  run(ctx) {
    const narrator = ctx.state.narrator;
    if (narrator.pendingHook !== undefined) return;
    // §requested-call-back: a standing request may ask the check-in to wait twice as long.
    const held = narrator.callBack?.holdQuiet === true ? 2 : 1;
    const quietTicks = held * dayTicks(ctx.config, ctx.config.narrator.quietTooLongDays);
    if (ctx.tick - narrator.lastNarrativeTick < quietTicks) return;
    raiseHookIfIdle(ctx, "quietTooLong", { quietSinceTick: narrator.lastNarrativeTick });
  },
};

/**
 * Decision-pending detection (phase 8, before events are stamped): announce the head of
 * `state.decisions.queue` once. W2 decision: "announced" lives in the diagnostics cache, not
 * state; after a restore the halted world does not step, so nothing is re-announced until the
 * queue head changes.
 *
 * §policy-decision-hook: a kernel-raised (policy) head gets its `policyDecision` hook here first,
 * in the tick it reaches the head, so the world halts on the hook before the decision (`world.ts`)
 * and the narrator dresses the card before it is shown. If another hook is pending the raise waits
 * for the next tick, which `haltReason` lets run once that hook is acknowledged.
 */
export const decisionPendingSystem: System = {
  name: "core.decisionPending",
  phase: "finalize",
  run(ctx) {
    raisePolicyDecisionHookIfDue(ctx);
    const head = ctx.state.decisions.queue[0];
    const kernelCache = ctx.caches.diagnostics;
    if (head === undefined) {
      kernelCache.announcedDecisionId = null;
      return;
    }
    if (kernelCache.announcedDecisionId === head) return;
    kernelCache.announcedDecisionId = head;
    const decision = ctx.state.decisions.records[head];
    ctx.emit({
      type: "decisionPending",
      subjectIds: decision === undefined ? [head] : [head, decision.perspectiveActorId],
      causeIds: [],
      source: "sim",
      payload: { decisionId: head },
    });
  },
};

/**
 * §narrator-lever-budgets: the narrator budget (D6) refills every `narrator.budgetRefillDays`:
 * spawns, faults and hazards back to their config values, from the tick of the last refill (world
 * creation, for a fresh game). Phase 8, before the quiet timer, so a hook raised this tick sees the
 * refilled budget.
 */
const budgetRefillSystem: System = {
  name: "core.budgetRefill",
  phase: "finalize",
  run(ctx) {
    const narrator = ctx.state.narrator;
    const every = dayTicks(ctx.config, ctx.config.narrator.budgetRefillDays);
    if (ctx.tick - narrator.budgetRefilledTick < every) return;
    narrator.budget = {
      spawnsRemaining: ctx.config.narrator.spawnBudget,
      faultsRemaining: ctx.config.narrator.faultBudget,
      hazardsRemaining: ctx.config.narrator.hazardBudget,
    };
    narrator.budgetRefilledTick = ctx.tick;
  },
};

/**
 * Index refresh (phase 2): item holder/container indexes when `dirty.inventory`, and the
 * actor-by-compartment index every tick (cheap; actors move every tick).
 */
const indexSystem: System = {
  name: "core.indexes",
  phase: "topology",
  run(ctx) {
    if (ctx.dirty.inventory) {
      rebuildItemIndexes(ctx.state, ctx.caches.index);
      ctx.dirty.inventory = false;
    }
    rebuildActorIndex(ctx.content, ctx.state, ctx.caches.index);
  },
};

/** Kernel-core entries, registered first by `createRegistry`. */
export function coreSystems(registry: KernelRegistry): System[] {
  return [
    {
      name: "core.commands",
      phase: "inputs",
      run: (ctx) => applyDueCommands(registry, ctx),
    },
    indexSystem,
    decisionPendingSystem,
    budgetRefillSystem,
    quietTimerSystem,
  ];
}
