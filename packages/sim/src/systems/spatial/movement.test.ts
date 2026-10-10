import { describe, expect, it } from "vitest";
import { configTicks } from "../../core/clock";
import { getRenderFrame } from "../../core/render";
import { compartmentByKey } from "../../core/world";
import { DECK12, JON, MARA, deck12World, place, tinySpatialWorld } from "./fixtures/deck-12x8";
import { stepChecked } from "./fixtures/helpers";
import { requestMove } from "./movement";

function actor(world: ReturnType<typeof deck12World>["world"], id: typeof MARA) {
  const found = world.state.actors[id];
  if (found === undefined) throw new Error(`no actor ${id}`);
  return found;
}

describe("movement", () => {
  it("crosses the corridor in distance / speed seconds, monotonically, never through walls", () => {
    const test = deck12World();
    const { world } = test;
    const config = world.config.values;
    expect(requestMove(world.state, JON, { x: 11, y: 6 }, world.caches, config)).toBe(true);
    // Jon carries nothing, so he walks at exactly walkSpeed.
    const expected = configTicks(config, 11 / config.movement.walkSpeed);
    let lastX = actor(world, JON).location.kind === "onDeck" ? 0.5 : Number.NaN;
    let arrivedAt = -1;
    stepChecked(test, expected + 5, (events) => {
      const mara = actor(world, JON);
      if (mara.location.kind !== "onDeck") throw new Error("left the deck");
      if (arrivedAt < 0) {
        expect(mara.location.x).toBeGreaterThan(lastX);
        expect(mara.location.y).toBe(6.5);
      }
      lastX = mara.location.x;
      if (events.some((e) => e.type === "reachedTile") && arrivedAt < 0) {
        arrivedAt = world.state.tick;
      }
    });
    expect(Math.abs(arrivedAt - expected)).toBeLessThanOrEqual(1);
    expect(actor(world, JON).movement).toEqual({ kind: "stationary" });
    expect(actor(world, JON).location).toMatchObject({ x: 11.5, y: 6.5 });
  });

  it("moves continuously (no step longer than speed × dt) through doors and diagonals", () => {
    const test = deck12World();
    const { world } = test;
    const config = world.config.values;
    expect(requestMove(world.state, MARA, { x: 3, y: 0 }, world.caches, config)).toBe(true);
    const maxStep = config.movement.walkSpeed / config.time.tickRate + 1e-9;
    let prev = { ...actor(world, MARA).location } as { x: number; y: number };
    const events = stepChecked(test, 400, () => {
      const loc = actor(world, MARA).location as { x: number; y: number };
      expect(Math.hypot(loc.x - prev.x, loc.y - prev.y)).toBeLessThanOrEqual(maxStep);
      prev = { x: loc.x, y: loc.y };
    });
    expect(actor(world, MARA).location).toMatchObject({ x: 3.5, y: 0.5 });
    const roomA = compartmentByKey(world.state, "roomA");
    const hall = compartmentByKey(world.state, "hall");
    const entered = events.filter((e) => e.type === "enteredCompartment");
    expect(entered.map((e) => e.payload)).toEqual([
      { compartmentId: roomA, fromCompartmentId: hall },
    ]);
    expect(world.caches.index.actorsByCompartment[roomA as never]).toEqual([MARA]);
  });

  it("gives the same result for advance(1)×N and advance(N)", () => {
    const a = deck12World();
    const b = deck12World();
    for (const { world } of [a, b]) {
      requestMove(world.state, MARA, { x: 9, y: 2 }, world.caches, world.config.values);
      requestMove(world.state, JON, { x: 2, y: 1 }, world.caches, world.config.values);
    }
    for (let i = 0; i < 300; i++) a.kernel.advance(a.world, 1);
    b.kernel.advance(b.world, 300);
    expect(b.world.state).toStrictEqual(a.world.state);
    expect(actor(a.world, MARA).location).toMatchObject({ x: 9.5, y: 2.5 });
    expect(actor(a.world, JON).location).toMatchObject({ x: 2.5, y: 1.5 });
  });

  it("slows while passing another actor", () => {
    const test = deck12World();
    const { world } = test;
    const config = world.config.values;
    place(world, MARA, { x: 5, y: 6 });
    requestMove(world.state, JON, { x: 11, y: 6 }, world.caches, config);
    const free = configTicks(config, 11 / config.movement.walkSpeed);
    const delay = configTicks(config, config.movement.passDelaySeconds);
    let arrivedAt = -1;
    let slowTicks = 0;
    stepChecked(test, free + delay + 10, (events) => {
      const mara = actor(world, JON);
      if (
        mara.movement.kind === "moving" &&
        mara.movement.effectiveSpeed < config.movement.walkSpeed
      ) {
        slowTicks += 1;
      }
      if (arrivedAt < 0 && events.some((e) => e.type === "reachedTile"))
        arrivedAt = world.state.tick;
    });
    expect(slowTicks).toBeGreaterThan(0);
    expect(Math.abs(arrivedAt - (free + delay))).toBeLessThanOrEqual(2);
  });

  it("redirects mid-segment without jumping", () => {
    const test = deck12World();
    const { world } = test;
    const config = world.config.values;
    requestMove(world.state, MARA, { x: 11, y: 5 }, world.caches, config);
    stepChecked(test, 15);
    const before = { ...actor(world, MARA).location };
    expect(requestMove(world.state, MARA, { x: 0, y: 5 }, world.caches, config)).toBe(true);
    const mara = actor(world, MARA);
    expect(mara.location).toEqual(before);
    stepChecked(test, 1);
    const after = mara.location as { x: number };
    expect(after.x).toBeLessThan((before as { x: number }).x);
    stepChecked(test, 60);
    expect(mara.location).toMatchObject({ x: 0.5, y: 5.5 });
  });

  it("refuses unreachable targets and leaves the actor alone", () => {
    const { world } = deck12World();
    expect(requestMove(world.state, MARA, { x: 0, y: 7 }, world.caches, world.config.values)).toBe(
      false,
    );
    expect(requestMove(world.state, MARA, { x: 10, y: 1 }, world.caches, world.config.values)).toBe(
      false,
    );
    expect(actor(world, MARA).movement).toEqual({ kind: "stationary" });
  });

  it("works on the tiny kernel deck and shows fractional positions in the render frame", () => {
    const test = tinySpatialWorld();
    const { world } = test;
    expect(requestMove(world.state, MARA, { x: 5, y: 1 }, world.caches, world.config.values)).toBe(
      true,
    );
    stepChecked(test, 3);
    const frame = getRenderFrame(world);
    const rendered = frame.actors.find((a) => a.id === MARA);
    expect(rendered?.x).not.toBe(Math.floor(rendered?.x ?? 0) + 0.5);
    expect(frame.doors[0]?.physicalState).toBe("closed");
    stepChecked(test, 200);
    expect(actor(world, MARA).location).toMatchObject({ x: 5.5, y: 1.5 });
    expect(getRenderFrame(world).doors[0]?.physicalState).toBe("open");
  });
});

describe("footfall (§footfall-and-boots)", () => {
  it("a walk across a clean corridor leaves footfallPerStep on each tile stepped onto", () => {
    const test = deck12World();
    const { world } = test;
    const config = world.config.values;
    const start = actor(world, JON).location as { x: number; y: number };
    expect({ x: Math.floor(start.x), y: Math.floor(start.y) }).toEqual({ x: 0, y: 6 });
    expect(requestMove(world.state, JON, { x: 11, y: 6 }, world.caches, config)).toBe(true);
    stepChecked(test, configTicks(config, 11 / config.movement.walkSpeed) + 5);
    const cells = world.state.dirt.cells[DECK12.deck] ?? [];
    const step = Math.round(config.dirt.footfallPerStep * 255);
    expect(step).toBeGreaterThan(0);
    for (let x = 1; x <= 11; x++) expect(cells[6 * 12 + x]).toBe(step);
    // The tile walked from, and every tile not walked on, stay clean.
    expect(cells[6 * 12]).toBe(0);
    expect(cells.reduce((a, b) => a + b, 0)).toBe(11 * step);
    expect(actor(world, JON).boots).toBeLessThan(0.01);
  });
});
