import { describe, expect, it } from "vitest";
import { restore, serialize } from "../../core/save";
import { JON, MARA, deck12World } from "./fixtures/deck-12x8";
import { stepChecked } from "./fixtures/helpers";
import { requestMove } from "./movement";

describe("spatial save/restore", () => {
  it("continues a route mid-segment and mid-door without snapping", () => {
    const test = deck12World();
    const { world, registry, kernel } = test;
    const config = world.config.values;
    requestMove(world.state, MARA, { x: 9, y: 2 }, world.caches, config);
    requestMove(world.state, JON, { x: 1, y: 2 }, world.caches, config);
    stepChecked(test, 37);
    const mara = world.state.actors[MARA];
    expect(mara?.movement.kind === "moving" && mara.movement.segmentDistanceTravelled > 0).toBe(
      true,
    );

    const blob = JSON.parse(JSON.stringify(serialize(world)));
    const restored = restore(blob, world.content, registry);
    expect(restored.state.actors[MARA]?.location).toEqual(mara?.location);
    expect(restored.caches.nav.reservations).toEqual(world.caches.nav.reservations);

    for (let i = 0; i < 200; i++) {
      kernel.advance(world, 1);
      kernel.advance(restored, 1);
      expect(restored.state.actors[MARA]?.location).toEqual(world.state.actors[MARA]?.location);
      expect(restored.state.actors[JON]?.location).toEqual(world.state.actors[JON]?.location);
    }
    expect(restored.state).toStrictEqual(world.state);
    expect(world.state.actors[MARA]?.location).toMatchObject({ x: 9.5, y: 2.5 });
    expect(world.state.actors[JON]?.location).toMatchObject({ x: 1.5, y: 2.5 });
  });
});
