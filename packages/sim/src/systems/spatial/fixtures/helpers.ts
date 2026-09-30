import type { TestWorld } from "../../../core/fixtures/test-world";
/** Test helpers shared by the spatial tests. */
import { checkInvariants } from "../../../core/invariants";
import type { SimEvent } from "../../../core/types/events";
import { spatialViolations } from "../invariants";

/**
 * Advance one tick at a time, asserting kernel and spatial invariants after each, and call
 * `each` with the tick's events. Returns every event.
 */
export function stepChecked(
  { kernel, world }: TestWorld,
  ticks: number,
  each?: (events: readonly SimEvent[]) => void,
): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    const { events } = kernel.advance(world, 1);
    const problems = [...checkInvariants(world.state), ...spatialViolations(world)];
    if (problems.length > 0) {
      throw new Error(`tick ${world.state.tick}: ${problems.join("; ")}`);
    }
    all.push(...events);
    each?.(events);
  }
  return all;
}
