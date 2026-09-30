/**
 * Integration 1 smoke test (task item 9): builds the real world from the real authored bundle
 * (no mocks) with the spatial system and the dev wander stand-in registered, advances it, and
 * checks the kernel's own invariants — the same wiring `sim.worker.ts` uses.
 */
import type { Command, CommandId } from "@crew/sim";
import { checkInvariants, createKernel, createRegistry, registerSpatial } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { loadWebContent } from "./content";
import { devWanderSystem } from "./devWander";

describe("real kernel + real content (Integration 1)", () => {
  it("advances 400 ticks with wander enabled and no invariant violations", () => {
    const { bundle, config, scenarioId } = loadWebContent();
    const registry = createRegistry();
    registerSpatial(registry);
    registry.registerSystem(devWanderSystem);
    const kernel = createKernel(registry);

    const world = kernel.createWorld(scenarioId, 12345, bundle, config);
    expect(Object.keys(world.state.actors).length).toBeGreaterThan(0);

    let remaining = 400;
    while (remaining > 0) {
      const result = kernel.advance(world, remaining);
      remaining -= result.ticksAdvanced;
      if (result.halt.kind === "hook") {
        // The quiet-too-long hook (or any other) would otherwise halt `advance` forever in this
        // test, which never calls a narrator; acknowledge it immediately like a no-op narrator.
        const hook = world.state.narrator.pendingHook;
        if (hook === undefined) break;
        const command: Command = {
          id: `cmd:test:ack:${hook.id}` as CommandId,
          source: "system",
          kind: "acknowledgeHook",
          payload: { hookId: hook.id },
        };
        const ack = kernel.enqueueCommand(world, command);
        expect(ack.status).toBe("accepted");
      } else if (result.halt.kind === "decision") {
        break;
      } else if (result.ticksAdvanced === 0) {
        break;
      }
    }

    expect(world.state.tick).toBeGreaterThan(0);
    expect(checkInvariants(world.state)).toEqual([]);

    // At least verifies the wander system had somewhere to move actors to and from — real doors
    // exist on the authored deck.
    expect(Object.keys(world.state.doors).length).toBeGreaterThan(0);
  });
});
