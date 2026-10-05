import { describe, expect, it } from "vitest";
import { checkInvariants, jsonSafetyViolations } from "../../core/invariants";
import { actionLabel } from "../../core/render";
import type { SimEvent } from "../../core/types/events";
import { dirtViolations } from "../dirt/invariants";
import { registerEquipmentSystems } from "../equipment/register";
import { spatialViolations } from "../spatial/invariants";
import type { CrewWorldOptions } from "./fixtures/crew-deck";
import { eightCrewWorld } from "./fixtures/eight";
import { workViolations } from "./invariants";

const TWO_MINUTES = 20 * 120;

function soak(options: CrewWorldOptions) {
  const tw = eightCrewWorld(options);
  const { kernel, world } = tw;
  const labels = new Map<string, Set<string>>();
  const events: SimEvent[] = [];
  for (let i = 0; i < TWO_MINUTES; i++) {
    events.push(...kernel.advance(world, 1).events);
    const violations = [
      ...checkInvariants(world.state),
      ...spatialViolations(world),
      ...dirtViolations(world),
      ...workViolations(world),
    ];
    if (violations.length > 0)
      throw new Error(`tick ${world.state.tick}: ${violations.join("; ")}`);
    for (const actor of Object.values(world.state.actors)) {
      const set = labels.get(actor.id) ?? new Set<string>();
      set.add(actionLabel(actor, world.state, world.content));
      labels.set(actor.id, set);
    }
  }
  return { world, labels, events };
}

describe("8 crew × 2 sim-minutes, headless", () => {
  it.each([
    ["work + needs only", {}],
    ["with W5 power/equipment", { extra: registerEquipmentSystems }],
  ] as const)("%s: no violations, varied labels, a conversation", (_name, options) => {
    const { world, labels, events } = soak(options as CrewWorldOptions);
    expect(labels.size).toBe(8);
    for (const [actorId, set] of labels) {
      expect(set.size, `${actorId}: ${[...set].join(" | ")}`).toBeGreaterThanOrEqual(3);
    }
    expect(events.some((e) => e.type === "conversation")).toBe(true);
    expect(events.filter((e) => e.type === "ateMeal").length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.type === "fellAsleep")).toBe(true);
    expect(events.filter((e) => e.type === "problemResolved").length).toBeGreaterThanOrEqual(3);
    expect(jsonSafetyViolations(world.state)).toEqual([]);
    expect(JSON.parse(JSON.stringify(world.state))).toEqual(world.state);
  });
});
