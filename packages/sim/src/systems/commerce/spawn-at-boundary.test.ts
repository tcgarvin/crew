/**
 * `spawnAtBoundary` tests (D6, review §D.3): boundary-only creation into a port's external store
 * or an accepted job's manifest, gated by the narrator spawn budget and `maxSpawnsPerCommand`.
 */
import { describe, expect, it } from "vitest";
import { cmd } from "../../core/fixtures/test-world";
import type { BoundaryLocation } from "../../core/types/commands/spawn";
import type { ItemDefId, TempRef } from "../../core/types/ids";
import { FIX, PORTS, advanceThroughHooks, freightTestWorld } from "../travel/fixtures";

function spawnItemCommand(
  tempRef: string,
  itemDefId: ItemDefId,
  count: number,
  location: BoundaryLocation = { kind: "portStore", portId: PORTS.a, storeKey: "warehouse" },
) {
  return cmd({
    source: "narrator" as const,
    kind: "spawnAtBoundary" as const,
    payload: {
      defs: { items: [], crew: [] },
      spawns: [{ kind: "item" as const, tempRef: tempRef as TempRef, itemDefId, count }],
      location,
    },
  });
}

describe("spawnAtBoundary", () => {
  it("spawns into a valid external store and decrements the narrator spawn budget", () => {
    const { world, kernel } = freightTestWorld();
    const before = world.state.narrator.budget.spawnsRemaining;
    const result = kernel.enqueueCommand(world, spawnItemCommand("$s0", FIX.crate, 2));
    expect(result.status).toBe("accepted");
    advanceThroughHooks(kernel, world, 1);
    expect(world.state.narrator.budget.spawnsRemaining).toBe(before - 1);
    const spawned = Object.values(world.state.items).find(
      (item) =>
        item.defId === FIX.crate &&
        item.location.kind === "inExternalStore" &&
        item.location.portId === PORTS.a,
    );
    expect(spawned).toBeDefined();
    expect(spawned && "count" in spawned ? spawned.count : undefined).toBe(2);
  });

  it("rejects an on-deck/aboard location with reason boundaryOnly", () => {
    const { world, kernel } = freightTestWorld();
    // `BoundaryLocation` excludes on-deck kinds at the type level; simulate an untyped payload
    // (e.g. from JSON) that bypassed the type checker.
    const onDeck = { kind: "onDeck", deckId: FIX.deck, x: 1, y: 1 } as unknown as BoundaryLocation;
    const result = kernel.enqueueCommand(world, spawnItemCommand("$s0", FIX.crate, 1, onDeck));
    expect(result.status).toBe("rejected");
    expect(result.status === "rejected" && result.rejection.code).toBe("outOfBounds");
    expect(result.status === "rejected" && result.rejection.reason).toContain("boundaryOnly");
  });

  it("rejects an unknown item def", () => {
    const { world, kernel } = freightTestWorld();
    const result = kernel.enqueueCommand(
      world,
      spawnItemCommand("$s0", "item.does.not.exist" as ItemDefId, 1),
    );
    expect(result.status).toBe("rejected");
    expect(result.status === "rejected" && result.rejection.code).toBe("unknownEntity");
  });

  it("rejects once the narrator spawn budget is exhausted", () => {
    const { world, kernel } = freightTestWorld();
    const budget = world.state.narrator.budget.spawnsRemaining;
    for (let i = 0; i < budget; i += 1) {
      const result = kernel.enqueueCommand(world, spawnItemCommand(`$s${i}`, FIX.crate, 1));
      expect(result.status).toBe("accepted");
    }
    // All `budget` commands share the same default `applyAtTick`, so one tick applies them all.
    advanceThroughHooks(kernel, world, 1);
    expect(world.state.narrator.budget.spawnsRemaining).toBe(0);
    const over = kernel.enqueueCommand(world, spawnItemCommand("$over", FIX.crate, 1));
    expect(over.status).toBe("rejected");
    expect(over.status === "rejected" && over.rejection.code).toBe("budgetExhausted");
  });
});
