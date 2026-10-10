/**
 * §field-lifecycle: the asteroid field's lifecycle (slice 5 calls 3, 4, 8, 9, 19): scheduled →
 * active at the first transit tick at or after its start → ended when progress leaves it or it
 * drifts clear while stuck; dropped with its leg. Detection and the alert (`detection.ts`),
 * arrivals and the hull (`impacts.ts`, `hull.ts`), machine effects (`effects.ts`) and the stuck
 * clock (`stuck.ts`) are this system's, phase `equipment` after travel's hazards.
 *
 * Timing. The helm's check falls `field.warningSeconds` before the start, in transit. A field
 * whose check would fall outside transit (scheduled in port, or still departing) is held: its
 * start moves on so the check falls on the first transit tick, and a sighting always gives the
 * crew their warning. (`scheduleField` never samples a start inside the warning for the same
 * reason.) So a scheduled field whose check tick has passed has had its check.
 *
 * Where. Entering, the field spans the severity's `lengthSeconds` of route at nominal speed from
 * where the ship is, ending at the approach lead (`narrator.approachHookLeadSeconds` short of the
 * route's end) at the latest, so the ship is out of the rocks before travel holds for the
 * staging call. A field due when the ship is already past that point never begins: missed.
 *
 * Ending. Crossed when progress reaches `endsAtProgress`, drifted after `stuckDriftImpacts`
 * impacts while stuck; either way `fieldCleared` and the alert stands down
 * `field.alertClearSeconds` later. The ended field stays until the leg ends (one per leg); a
 * field still active when the leg's transit ends is crossed first.
 *
 * Owner: W1 of ship life slice 5.
 */
import { configTicks } from "../../core/clock";
import type { StepCtx, System } from "../../core/types/pipeline";
import type { ActiveField, ScriptedImpact } from "../../core/types/state";
import { whoHasTheHelm } from "../watch/helm";
import { checkForField, clearAlertIfDue, noticeFirstImpact, scheduleAlertClear } from "./detection";
import { emitFieldCleared } from "./hull";
import {
  type HelmAtField,
  type ImpactSpec,
  arrivalChance,
  landImpact,
  randomImpactRate,
  randomSpec,
  scriptedSpec,
} from "./impacts";
import { driftedClear, isStuck, updateStuck } from "./stuck";

type ActivePhase = Extract<ActiveField["phase"], { kind: "active" }>;

/** Has the leg the field lies on ended? The same test as `systems/travel/hazards.ts`'s. */
function legGone(travel: StepCtx["state"]["travel"]): boolean {
  if (travel.stage === "docked") return travel.plannedDestinationId === undefined;
  return travel.stage === "approaching" || travel.stage === "docking";
}

/** Drops the field with its leg: `fieldMissed` if it never began, crossed if still active. */
function dropWithLeg(ctx: StepCtx, field: ActiveField): void {
  if (field.phase.kind === "active") endField(ctx, field, field.phase, "crossed");
  if (field.phase.kind === "scheduled") emitMissed(ctx, field);
  // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
  delete ctx.state.field;
}

function emitMissed(ctx: StepCtx, field: ActiveField): void {
  const travel = ctx.state.travel;
  const leg =
    travel.stage === "docked"
      ? { fromPortId: travel.portId }
      : { fromPortId: travel.fromPortId, toPortId: travel.toPortId };
  ctx.emit({
    type: "fieldMissed",
    subjectIds: [field.id],
    causeIds: field.causeCommandId === undefined ? [] : [field.causeCommandId],
    source: "sim",
    payload: { fieldId: field.id, ...leg },
  });
}

/** The route progress past which no field may lie: the approach lead short of the end. */
function lastFieldProgress(ctx: StepCtx, routeDistance: number): number {
  const lead = ctx.config.narrator.approachHookLeadSeconds * ctx.config.travel.nominalSpeed;
  return Math.max(0, routeDistance - lead);
}

/** A scheduled field: held outside transit, checked by the helm, entered at its start. */
function stepScheduled(ctx: StepCtx, field: ActiveField): void {
  const travel = ctx.state.travel;
  const warningTicks = configTicks(ctx.config, ctx.config.field.warningSeconds);
  const checkTick = field.startsAtTick - warningTicks;
  if (travel.stage !== "transit") {
    // Held so the check falls on the first transit tick (see the module comment).
    if (checkTick <= ctx.tick) field.startsAtTick = ctx.tick + 1 + warningTicks;
    return;
  }
  if (ctx.tick === checkTick) checkForField(ctx, field);
  if (ctx.tick < field.startsAtTick) return;
  const last = lastFieldProgress(ctx, travel.routeDistance);
  if (travel.routeProgress >= last) {
    emitMissed(ctx, field);
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete ctx.state.field;
    return;
  }
  const length = ctx.config.field.severities[field.severity].lengthSeconds;
  const endsAtProgress = Math.min(
    travel.routeProgress + length * ctx.config.travel.nominalSpeed,
    last,
  );
  field.phase = { kind: "active", enteredTick: ctx.tick, endsAtProgress };
}

/** Who is at the helm, as the rocks see it. */
function helmAtField(ctx: StepCtx): HelmAtField {
  const standerId = whoHasTheHelm(ctx.state, ctx.content);
  if (standerId === undefined) return { manned: false };
  const stander = ctx.state.actors[standerId];
  if (stander === undefined) throw new Error(`field: the helm's stander ${standerId} is gone`);
  return { manned: true, piloting: stander.skills.piloting ?? 0 };
}

/** An impact due this tick, with the scripted impact it fires, if it is one. */
interface DueImpact {
  readonly spec: ImpactSpec;
  readonly scripted?: ScriptedImpact;
}

/** The impacts landing this tick: scripted ones due, then the tick's random draw. */
function dueImpacts(ctx: StepCtx, field: ActiveField, phase: ActivePhase): DueImpact[] {
  const due: DueImpact[] = [];
  for (const impact of field.scripted) {
    if (impact.firedTick !== undefined) continue;
    if (phase.enteredTick + configTicks(ctx.config, impact.atSeconds) > ctx.tick) continue;
    due.push({ spec: scriptedSpec(ctx, field, impact), scripted: impact });
  }
  const rate = randomImpactRate(
    ctx.config,
    field.severity,
    helmAtField(ctx),
    isStuck(phase),
    field.scripted.length,
  );
  const seconds = ctx.elapsedTicks / ctx.config.time.tickRate;
  if (ctx.rng.float("failures") < arrivalChance(rate, seconds)) {
    due.push({ spec: randomSpec(ctx, field) });
  }
  return due;
}

/** An active field: stuck or not, out by progress, or the tick's rocks. */
function stepActive(ctx: StepCtx, field: ActiveField, phase: ActivePhase): void {
  updateStuck(ctx, field, phase);
  const travel = ctx.state.travel;
  if (travel.stage === "transit" && travel.routeProgress >= phase.endsAtProgress) {
    endField(ctx, field, phase, "crossed");
    return;
  }
  for (const { spec, scripted } of dueImpacts(ctx, field, phase)) {
    if (field.impacts === 0) noticeFirstImpact(ctx, field);
    if (scripted !== undefined) scripted.firedTick = ctx.tick;
    landImpact(ctx, field, spec);
    if (ctx.state.hull.lostAtTick !== undefined) return;
    if (!isStuck(phase)) continue;
    field.stuckImpacts += 1;
    if (driftedClear(ctx, field)) {
      endField(ctx, field, phase, "drifted");
      return;
    }
  }
}

function endField(
  ctx: StepCtx,
  field: ActiveField,
  phase: ActivePhase,
  how: "crossed" | "drifted",
): void {
  field.phase = { kind: "ended", enteredTick: phase.enteredTick, endedTick: ctx.tick, how };
  emitFieldCleared(ctx, field, how);
  scheduleAlertClear(ctx);
}

export const fieldSystem: System = {
  name: "field.field",
  phase: "equipment",
  run(ctx) {
    if (ctx.state.hull.lostAtTick !== undefined) return;
    clearAlertIfDue(ctx);
    const field = ctx.state.field;
    if (field === undefined) return;
    if (legGone(ctx.state.travel)) {
      dropWithLeg(ctx, field);
      return;
    }
    if (field.phase.kind === "scheduled") stepScheduled(ctx, field);
    else if (field.phase.kind === "active") stepActive(ctx, field, field.phase);
  },
};
