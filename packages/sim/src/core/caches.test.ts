import { describe, expect, it } from "vitest";
import { rebuildCaches } from "./caches";
import { tinyTestWorld } from "./fixtures/test-world";
import { compartmentByKey } from "./world";

describe("caches", () => {
  it("indexes items by holder and container, actors and machines by compartment", () => {
    const { world } = tinyTestWorld();
    const { state, caches } = world;
    const hold = compartmentByKey(state, "hold");
    const engineering = compartmentByKey(state, "engineering");
    expect(hold).toBeDefined();
    const rations = Object.values(state.items).find((i) => i.defId === "item.tiny.rations");
    expect(caches.index.itemsByHolder).toEqual({ a1: [rations?.id] });
    expect(caches.index.actorsByCompartment).toEqual({ [hold as string]: ["a1"] });
    expect(caches.index.machinesByCompartment).toEqual({ [engineering as string]: ["m1"] });
  });

  it("runs registered cache builders on rebuild and sets every dirty flag", () => {
    const { world, registry } = tinyTestWorld();
    const built: number[] = [];
    registry.registerCacheBuilder({
      name: "test.nav",
      build: (w) => {
        w.caches.nav.geometryRevision = w.state.deck.geometryRevision;
        built.push(w.state.tick);
      },
    });
    world.caches.dirty.navigation = false;
    rebuildCaches(world, registry);
    expect(built).toEqual([0]);
    expect(world.caches.nav.geometryRevision).toBe(0);
    expect(world.caches.dirty.navigation).toBe(true);
    expect(() => registry.registerCacheBuilder({ name: "test.nav", build: () => {} })).toThrow();
  });

  it("refreshes the item index in phase 2 when inventory is dirty", () => {
    const { world, kernel } = tinyTestWorld();
    const wrench = Object.values(world.state.items).find((i) => i.defId === "item.tiny.wrench");
    if (wrench === undefined) throw new Error("no wrench");
    wrench.location = { kind: "carriedBy", actorId: "a1" as never };
    world.caches.dirty.inventory = true;
    kernel.advance(world, 1);
    expect(world.caches.index.itemsByHolder["a1" as never]).toContain(wrench.id);
    expect(world.caches.dirty.inventory).toBe(false);
  });
});
