/**
 * Travel invariants for tests (SD §19.4 style). D61: the dock alongside (`state.deck.dock`) is
 * exactly the dock content has for the port the ship is at, from the start of `docking` to the
 * end of `undocking`, and none otherwise (in flight, or at a port without a dock map). While the
 * ramps are not both shut, nobody is on a dock that is not there. Pure over state and content.
 */
import { dockForPort, expectedDock, isDockPoint } from "../../core/docks";
import type { World } from "../../core/types/kernel";

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
  out.push(...stagingViolations(world), ...localViolations(world));
  return out;
}

/**
 * D66: the staging record lives only in `transit` and `approaching`, and the ship is never on
 * approach to a dock map's port without its staging call having been raised and answered.
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
  if (staging === undefined) return []; // a save from before D66, past its lead point
  if (staging.status !== "raised" || state.narrator.pendingHook?.id === staging.hookId) {
    return [`on approach to ${travel.toPortId} with the staging call unanswered`];
  }
  return [];
}

/**
 * D66: no local without the dock they belong to, and every local on its floor (never on the
 * ship's own tiles), walking only over it; props only with a dock; errands name real jobs.
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
