import { describe, expect, it } from "vitest";
import { tinyTestWorld } from "../../core/fixtures/test-world";
import { createRegistry } from "../../core/registry";
import type { SimEvent } from "../../core/types/events";
import { watchBillOf } from "./bill";
import { registerWatch } from "./index";

type Bell = Extract<SimEvent, { type: "bell" }>;
const bells = (events: readonly SimEvent[]) => events.filter((e): e is Bell => e.type === "bell");

describe("the bell (§the-bell)", () => {
  it("rings once at each change of watch, naming the section that has it", () => {
    const registry = createRegistry();
    registerWatch(registry);
    // The tiny day: 600 s of two watches; its bill has one section, `alpha`, on watch 0.
    const { world, kernel } = tinyTestWorld({ registry, quietTooLongSeconds: 3000 });
    const watch = 300 * world.config.values.time.tickRate;
    const first = kernel.advance(world, watch - 1);
    expect(bells(first.events)).toEqual([]);
    const second = kernel.advance(world, watch + 1);
    const rung = bells(second.events);
    expect(rung.map((e) => [e.tick, e.payload])).toEqual([
      [watch, { watchIndex: 1 }],
      [2 * watch, { watchIndex: 2, sectionKey: "alpha" }],
    ]);
    expect(rung.every((e) => e.significance === "notable")).toBe(true);
    expect(world.state.watch.lastBellWatch).toBe(2);
  });

  it("reads the bill off the crew's sections", () => {
    const { world } = tinyTestWorld();
    expect(watchBillOf(world.state)).toEqual({
      sections: [{ key: "alpha", index: 0, members: ["a1"] }],
      dayworkers: [],
    });
  });
});
