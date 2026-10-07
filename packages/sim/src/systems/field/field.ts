/**
 * D92: the asteroid field's lifecycle (slice 5 calls 3, 4, 8, 9, 19): scheduled → active at the
 * first transit tick at or after its start → ended when progress leaves it or it drifts clear
 * while stuck; dropped with its leg. Detection and the alert (`detection.ts`), arrivals and the
 * hull (`impacts.ts`, `hull.ts`), machine effects (`effects.ts`) and the stuck clock
 * (`stuck.ts`) are this system's, phase `equipment` after travel's hazards.
 *
 * Gate stub: only the leg's end is handled (a field never begun is missed, an ended one
 * dropped), so with no field scheduled nothing here runs.
 *
 * Owner: W1 of ship life slice 5.
 */
import type { StepCtx, System } from "../../core/types/pipeline";

/** Has the leg the field lies on ended? The same test as `systems/travel/hazards.ts`'s. */
function legGone(travel: StepCtx["state"]["travel"]): boolean {
  if (travel.stage === "docked") return travel.plannedDestinationId === undefined;
  return travel.stage === "approaching" || travel.stage === "docking";
}

/** Drops the field with its leg: `fieldMissed` if it never began. */
function dropWithLeg(ctx: StepCtx): void {
  const field = ctx.state.field;
  if (field === undefined) return;
  if (field.phase.kind === "scheduled") {
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
  // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
  delete ctx.state.field;
}

export const fieldSystem: System = {
  name: "field.field",
  phase: "equipment",
  run(ctx) {
    if (ctx.state.field === undefined) return;
    if (legGone(ctx.state.travel)) dropWithLeg(ctx);
  },
};
