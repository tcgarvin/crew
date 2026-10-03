/**
 * Travel invariants for tests (SD §19.4 style). D61: the dock alongside (`state.deck.dock`) is
 * exactly the dock content has for the port the ship is at, from the start of `docking` to the
 * end of `undocking`, and none otherwise (in flight, or at a port without a dock map). While the
 * ramps are not both shut, nobody is on a dock that is not there. Pure over state and content.
 */
import { expectedDock } from "../../core/docks";
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
  return out;
}
