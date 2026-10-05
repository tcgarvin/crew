/** Test driver: step one tick at a time with invariant checks, recording labels per actor. */
import type { TestWorld } from "../../../core/fixtures/test-world";
import { checkInvariants } from "../../../core/invariants";
import { actionLabel } from "../../../core/render";
import type { SimEvent } from "../../../core/types/events";
import type { ActorId } from "../../../core/types/ids";
import { dirtViolations } from "../../dirt/invariants";
import { spatialViolations } from "../../spatial/invariants";

export interface RunLog {
  readonly events: SimEvent[];
  /** Label sequence per actor (consecutive duplicates collapsed). */
  readonly labels: Record<ActorId, string[]>;
}

export function run(
  { kernel, world }: TestWorld,
  ticks: number,
  until?: (world: TestWorld["world"]) => boolean,
): RunLog {
  const events: SimEvent[] = [];
  const labels: Record<ActorId, string[]> = {};
  for (let i = 0; i < ticks; i++) {
    const result = kernel.advance(world, 1);
    const violations = [
      ...checkInvariants(world.state),
      ...spatialViolations(world),
      ...dirtViolations(world),
    ];
    if (violations.length > 0)
      throw new Error(`tick ${world.state.tick}: ${violations.join("; ")}`);
    events.push(...result.events);
    for (const actor of Object.values(world.state.actors)) {
      const label = actionLabel(actor, world.state, world.content);
      const list = labels[actor.id] ?? [];
      if (list[list.length - 1] !== label) list.push(label);
      labels[actor.id] = list;
    }
    if (until?.(world)) break;
  }
  return { events, labels };
}

export const eventsOf = <T extends SimEvent["type"]>(log: RunLog, type: T) =>
  log.events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
