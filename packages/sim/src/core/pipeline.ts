import { rebuildActorIndex, rebuildItemIndexes } from "./caches";
import { configTicks } from "./clock";
/**
 * The tick pipeline (SD §5.2–5.3). `runStep` executes one tick: every registered entry in
 * `PHASES` order (see `registry.pipeline()`), honouring cadence and actor staggering, then
 * finalises the tick's events (phase 8).
 */
import { applyDueCommands } from "./commands";
import { createDefLookup } from "./defs";
import { createEventBuffer } from "./events";
import { allocateId } from "./ids";
import type { KernelRegistry } from "./registry";
import { createRngApi } from "./rng";
import type { EventDraft, SimEvent } from "./types/events";
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

/** Bookkeeping over the committed events: the quiet timer's input and the trace ring. */
function recordFinalizedEvents(world: World, events: readonly SimEvent[]): void {
  const { state, caches } = world;
  const ringSize = world.config.values.events.traceRingSize;
  for (const event of events) {
    if (event.significance === "narrative") {
      state.narrator.lastNarrativeTick = event.tick;
    } else if (event.significance === "trace") {
      caches.diagnostics.traceEvents.push(event);
    }
  }
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
      const traces = caches.diagnostics.plannerTraces;
      traces.push({ tick: base.tick, actorId, intent });
      const ringSize = config.events.traceRingSize;
      if (traces.length > ringSize) traces.splice(0, traces.length - ringSize);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Core systems
// ---------------------------------------------------------------------------------------------

/**
 * Quiet-too-long timer (phase 7). Reads `state.narrator.lastNarrativeTick`, which phase 8 writes
 * from the previous ticks' committed events (never the current buffer). While a hook is pending
 * the timer does not fire; the sim is halted anyway, so no ticks accrue.
 *
 * W2 decision: the contract's `lastNarrativeTick` (narrative-significance events) drives the
 * timer, not a separate notable counter. Raising the hook re-arms the timer by setting
 * `lastNarrativeTick` to the raise tick, so after `acknowledgeHook` the next hook needs another
 * full quiet window.
 */
export const quietTimerSystem: System = {
  name: "core.quietTimer",
  phase: "planning",
  run(ctx) {
    const narrator = ctx.state.narrator;
    if (narrator.pendingHook !== undefined) return;
    const quietTicks = configTicks(ctx.config, ctx.config.narrator.quietTooLongSeconds);
    if (ctx.tick - narrator.lastNarrativeTick < quietTicks) return;
    const hookId = allocateId(ctx.state, "hook");
    narrator.pendingHook = {
      id: hookId,
      kind: "quietTooLong",
      context: { quietSinceTick: narrator.lastNarrativeTick },
      tick: ctx.tick,
    };
    narrator.lastNarrativeTick = ctx.tick;
    ctx.emit({
      type: "narratorHookRaised",
      subjectIds: [hookId],
      causeIds: [],
      source: "sim",
      payload: { hookId, kind: "quietTooLong" },
    });
  },
};

/**
 * Decision-pending detection (phase 8, before events are stamped): announce the head of
 * `state.decisions.queue` once. W2 decision: "announced" lives in the diagnostics cache, not
 * state; after a restore the halted world does not step, so nothing is re-announced until the
 * queue head changes.
 */
export const decisionPendingSystem: System = {
  name: "core.decisionPending",
  phase: "finalize",
  run(ctx) {
    const head = ctx.state.decisions.queue[0];
    const kernelCache = ctx.caches.diagnostics;
    if (head === undefined) {
      kernelCache.announcedDecisionId = null;
      return;
    }
    if (kernelCache.announcedDecisionId === head) return;
    kernelCache.announcedDecisionId = head;
    const decision = ctx.state.decisions.records[head];
    const draft: EventDraft = {
      type: "decisionPending",
      subjectIds: decision === undefined ? [head] : [head, decision.perspectiveActorId],
      causeIds: [],
      source: "sim",
      payload: { decisionId: head },
    };
    ctx.emit(draft);
  },
};

/**
 * Index refresh (phase 2): item holder/container indexes when `dirty.inventory`, and the
 * actor-by-compartment index every tick (cheap; actors move every tick).
 */
export const indexSystem: System = {
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
    quietTimerSystem,
    decisionPendingSystem,
  ];
}
