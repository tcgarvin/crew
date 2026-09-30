/**
 * Worker wiring smoke test: the registry `sim.worker.ts` builds (`createFullRegistry`) plus the
 * real authored bundle. Covers what the inspector needs — an `AgentView` for a crew member, and
 * its structured-clone-safe snapshot — which Integration 1 could not provide.
 */
import type { ActorId } from "@crew/sim";
import { checkInvariants, createKernel, toAgentViewSnapshot } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { loadWebContent } from "./content";
import { createFullRegistry } from "./registry";

describe("worker registry + real content", () => {
  it("builds a world, advances it, and serves the inspector's AgentView", () => {
    const { bundle, config, scenarioId } = loadWebContent();
    const kernel = createKernel(createFullRegistry());
    const world = kernel.createWorld(scenarioId, 12345, bundle, config);
    const actorIds = Object.keys(world.state.actors) as ActorId[];
    expect(actorIds.length).toBe(8);

    // Initial needs come from `config.needs.initialRange`, so nobody starts at zero hunger.
    const range = config.values.needs.initialRange.hunger;
    for (const id of actorIds) {
      const hunger = world.state.actors[id]?.needs.hunger ?? -1;
      expect(hunger).toBeGreaterThanOrEqual(range.min);
      expect(hunger).toBeLessThanOrEqual(range.max);
    }

    kernel.advance(world, 1);
    expect(checkInvariants(world.state)).toEqual([]);

    const first = actorIds[0] as ActorId;
    const view = kernel.getAgentView(world, first);
    const snapshot = toAgentViewSnapshot(view);
    expect(snapshot.self.id).toBe(first);
    expect(structuredClone(snapshot)).toEqual(snapshot);
  });
});
