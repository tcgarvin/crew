/**
 * §sighting-and-the-alert: detection and the alert (slice 5 call 4). `field.warningSeconds` before
 * a `rolled` field starts, whoever has the helm rolls piloting against the severity on the
 * nav-hazard curve (`cleanPassChance` at `hazards.difficulty` easy / hard / brutal for light /
 * heavy / brutal): a pass is `fieldSighted`, the crew know (`noticedAtTick`) and the ship goes on
 * alert. A failed roll, an empty helm or an `unseen` field leave nobody the wiser until the first
 * impact, which notices the field, raises the alert and is `fieldEntered` (narrative then; notable
 * when the helm had sighted it, so it hooks only the first knowledge).
 *
 * The alert is the field's to raise and clear: `field.alertClearSeconds` after the field ends it
 * stands down (`alertCleared`, `state.alert` deleted), whether or not the leg (and the field
 * record) has ended meanwhile.
 *
 * Owner: W1 of ship life slice 5.
 */
import { configTicks } from "../../core/clock";
import type { FieldSeverity } from "../../core/types/content";
import type { StepCtx } from "../../core/types/pipeline";
import type { ActiveField } from "../../core/types/state";
import { cleanPassChance } from "../travel/hazards";
import { whoHasTheHelm } from "../watch/helm";

/** Which nav-hazard difficulty a field of each severity is checked at. */
const DIFFICULTY_OF: Readonly<Record<FieldSeverity, "easy" | "hard" | "brutal">> = {
  light: "easy",
  heavy: "hard",
  brutal: "brutal",
};

/** The tick of the helm's check: `field.warningSeconds` before the field starts. */
export function warningTick(ctx: Pick<StepCtx, "config">, field: ActiveField): number {
  return field.startsAtTick - configTicks(ctx.config, ctx.config.field.warningSeconds);
}

/** The piloting check's difficulty for a field of `severity`. */
export function fieldDifficulty(ctx: Pick<StepCtx, "config">, severity: FieldSeverity): number {
  return ctx.config.hazards.difficulty[DIFFICULTY_OF[severity]];
}

/** The helm's check on a `rolled` field: a pass sights it and raises the alert. */
export function checkForField(ctx: StepCtx, field: ActiveField): void {
  if (field.detection !== "rolled") return;
  const standerId = whoHasTheHelm(ctx.state, ctx.content);
  if (standerId === undefined) return;
  const stander = ctx.state.actors[standerId];
  if (stander === undefined) {
    throw new Error(`field ${field.id}: the helm's stander ${standerId} is not in state`);
  }
  const p = cleanPassChance(stander.skills.piloting ?? 0, fieldDifficulty(ctx, field.severity));
  if (ctx.rng.float("failures") >= p) return;
  field.noticedAtTick = ctx.tick;
  ctx.emit({
    type: "fieldSighted",
    subjectIds: [field.id, standerId],
    causeIds: [],
    source: "sim",
    payload: { fieldId: field.id, standerId, severity: field.severity },
  });
  raiseAlert(ctx, field);
}

/**
 * The first impact of the field: `fieldEntered`, and if nobody had noticed the field, now they
 * have (`noticedAtTick`, the alert).
 */
export function noticeFirstImpact(ctx: StepCtx, field: ActiveField): void {
  const noticedBefore = field.noticedAtTick !== undefined;
  ctx.emit({
    type: "fieldEntered",
    subjectIds: [field.id],
    causeIds: [],
    source: "sim",
    ...(noticedBefore ? { significance: "notable" as const } : {}),
    payload: { fieldId: field.id, noticedBefore },
  });
  if (noticedBefore) return;
  field.noticedAtTick = ctx.tick;
  raiseAlert(ctx, field);
}

/**
 * Put the ship on alert for `field` (`alertRaised`). An alert still standing down from an earlier
 * field is kept and stops standing down, without a second klaxon.
 */
function raiseAlert(ctx: StepCtx, field: ActiveField): void {
  const alert = ctx.state.alert;
  if (alert !== undefined) {
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete alert.clearsAtTick;
    return;
  }
  ctx.state.alert = { sinceTick: ctx.tick, cause: "field", reports: {} };
  ctx.emit({
    type: "alertRaised",
    subjectIds: [field.id],
    causeIds: [],
    source: "sim",
    payload: { cause: "field", fieldId: field.id },
  });
}

/** The field has ended: the alert, if one is up, stands down `field.alertClearSeconds` later. */
export function scheduleAlertClear(ctx: StepCtx): void {
  const alert = ctx.state.alert;
  if (alert === undefined) return;
  alert.clearsAtTick = ctx.tick + configTicks(ctx.config, ctx.config.field.alertClearSeconds);
}

/** Stand the alert down once its `clearsAtTick` has come (`alertCleared`). */
export function clearAlertIfDue(ctx: StepCtx): void {
  const alert = ctx.state.alert;
  if (alert?.clearsAtTick === undefined || alert.clearsAtTick > ctx.tick) return;
  // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
  delete ctx.state.alert;
  ctx.emit({
    type: "alertCleared",
    subjectIds: [],
    causeIds: [],
    source: "sim",
    payload: { cause: alert.cause },
  });
}
