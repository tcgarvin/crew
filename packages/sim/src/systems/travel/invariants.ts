/**
 * Travel invariants for tests (SD §19.4 style). §dock-alongside: the dock alongside
 * (`state.deck.dock`) is exactly the dock content has for the port the ship is at, from the start
 * of `docking` to the end of `undocking`, and none otherwise (in flight, or at a port without a
 * dock map). While the ramps are not both shut, nobody is on a dock that is not there.
 * §debris-fields-and-ion-storms: waiting hazards are well formed, none is overdue in transit and
 * none outlives its leg's transit. Pure over state and content.
 */
import { dockForPort, expectedDock, isDockPoint } from "../../core/docks";
import { HAZARD_KINDS } from "../../core/types/content";
import type { World } from "../../core/types/kernel";
import { HAZARD_DIFFICULTY_MAX, HAZARD_DIFFICULTY_MIN } from "./hazards";

export function travelViolations(world: Pick<World, "state" | "content">): string[] {
  const out: string[] = [];
  const { state, content } = world;
  const expected = expectedDock(content, state.travel);
  const actual = state.deck.dock;
  if (expected === undefined && actual !== undefined) {
    out.push(`dock "${actual.dockId}" is alongside in stage ${state.travel.stage} with none due`);
  } else if (expected !== undefined && actual === undefined) {
    out.push(`no dock alongside in stage ${state.travel.stage}; "${expected.id}" is due`);
  } else if (expected !== undefined && actual !== undefined && expected.id !== actual.dockId) {
    out.push(`dock "${actual.dockId}" is alongside where "${expected.id}" is due`);
  }
  if (state.travel.stage !== "preparingDeparture" && "recallSinceTick" in state.travel) {
    out.push(`recallSinceTick outlived preparingDeparture (stage ${state.travel.stage})`);
  }
  out.push(...stagingViolations(world), ...localViolations(world), ...hazardViolations(world));
  return out;
}

/**
 * §debris-fields-and-ion-storms: every waiting hazard has a known kind, a difficulty on the 1-10
 * scale and a whole-tick fire time; none is overdue in transit, where `hazardsSystem` fires them
 * the tick they fall due; and none outlives the transit of its leg (dropped the tick it ends). (Ids
 * below `nextId.hazard` are core's, `checkInvariants`.)
 */
function hazardViolations({ state }: Pick<World, "state">): string[] {
  const out: string[] = [];
  const stage = state.travel.stage;
  if ((stage === "approaching" || stage === "docking") && state.hazards.length > 0) {
    out.push(`${state.hazards.length} hazards outlived their leg's transit (stage ${stage})`);
  }
  for (const hazard of state.hazards) {
    const where = `hazard ${hazard.id}`;
    if (!(HAZARD_KINDS as readonly string[]).includes(hazard.kind)) {
      out.push(`${where} has unknown kind "${hazard.kind}"`);
    }
    const { difficulty } = hazard;
    if (
      !Number.isInteger(difficulty) ||
      difficulty < HAZARD_DIFFICULTY_MIN ||
      difficulty > HAZARD_DIFFICULTY_MAX
    ) {
      out.push(
        `${where} difficulty ${difficulty} is not an integer in [${HAZARD_DIFFICULTY_MIN}, ${HAZARD_DIFFICULTY_MAX}]`,
      );
    }
    if (!Number.isInteger(hazard.fireAtTick)) {
      out.push(`${where} fireAtTick ${hazard.fireAtTick} is not a whole tick`);
    } else if (state.travel.stage === "transit" && hazard.fireAtTick <= state.tick) {
      out.push(`${where} was due at tick ${hazard.fireAtTick} and has not fired in transit`);
    }
  }
  return out;
}

/**
 * §staging-hook-and-the-hold: the staging record lives only in `transit` and `approaching`, and the
 * ship is never on approach to a dock map's port without its staging call having been raised and
 * answered.
 */
function stagingViolations({ state, content }: Pick<World, "state" | "content">): string[] {
  const travel = state.travel;
  if (travel.stage !== "transit" && travel.stage !== "approaching") {
    return "staging" in travel ? [`staging record outlived its leg (stage ${travel.stage})`] : [];
  }
  if (travel.stage !== "approaching" || dockForPort(content, travel.toPortId) === undefined) {
    return [];
  }
  const staging = travel.staging;
  if (staging === undefined) return []; // a save before the staging record, past its lead point
  if (staging.status !== "raised" || state.narrator.pendingHook?.id === staging.hookId) {
    return [`on approach to ${travel.toPortId} with the staging call unanswered`];
  }
  return [];
}

/**
 * §locals-come-and-go-with-the-dock: no local without the dock they belong to, and every local on
 * its floor (never on the ship's own tiles), walking only over it; props only with a dock; errands
 * name real jobs.
 */
function localViolations({ state, content }: Pick<World, "state" | "content">): string[] {
  const out: string[] = [];
  const presence = state.deck.dock;
  const locals = Object.values(state.dockside.locals);
  if (presence === undefined) {
    if (locals.length > 0) out.push(`${locals.length} locals with no dock alongside`);
    if (state.dockside.props.length > 0) out.push("props with no dock alongside");
    if (state.dockside.dockId !== undefined) out.push("dockside dressed with no dock alongside");
    return out;
  }
  if (locals.length > 0 && state.dockside.dockId !== presence.dockId) {
    out.push(`locals belong to "${state.dockside.dockId}", "${presence.dockId}" is alongside`);
  }
  for (const local of locals) {
    const { x, y, deckId } = local.location;
    if (deckId !== presence.deckId || !isDockPoint(content, state, x, y)) {
      out.push(`local ${local.id} (${local.name}) is off the dock floor at ${x},${y}`);
    }
    if (local.movement.kind === "moving") {
      const off = local.movement.path.find((t) => !isDockPoint(content, state, t.x, t.y));
      if (off !== undefined) out.push(`local ${local.id} walks off the dock at ${off.x},${off.y}`);
    }
    if (local.errand !== undefined && state.jobs[local.errand.jobId] === undefined) {
      out.push(`local ${local.id} has an errand for unknown job ${local.errand.jobId}`);
    }
  }
  return out;
}
