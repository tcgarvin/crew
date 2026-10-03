import { describe, expect, it } from "vitest";
import { configTicks } from "../../core/clock";
import { tinyConfig, tinyEffectiveConfig } from "../../core/fixtures/tiny-content";
import { createKernel } from "../../core/kernel";
import { createRegistry } from "../../core/registry";
import type { SimEvent } from "../../core/types/events";
import {
  DECK12,
  JON,
  MARA,
  deck12Content,
  deck12World,
  doorByKey,
  place,
} from "./fixtures/deck-12x8";
import { stepChecked } from "./fixtures/helpers";
import { registerSpatial } from "./index";
import { requestMove } from "./movement";

/** The 12×8 deck with powered `doorB` authored as a ramp (D58). */
function rampWorld() {
  const config = tinyConfig();
  const content = deck12Content(config);
  const deck = content.decks[DECK12.deck];
  if (deck === undefined) throw new Error("no deck12");
  const doors = deck.doors.map((d) => (d.key === "doorB" ? { ...d, kind: "ramp" as const } : d));
  const registry = createRegistry();
  registerSpatial(registry);
  const kernel = createKernel(registry);
  const world = kernel.createWorld(
    DECK12.scenario,
    7,
    { ...content, decks: { ...content.decks, [DECK12.deck]: { ...deck, doors } } },
    tinyEffectiveConfig(config),
  );
  return { registry, kernel, world };
}

type World = ReturnType<typeof deck12World>["world"];

function door(world: World, key: string) {
  const found = world.state.doors[doorByKey(world, key)];
  if (found === undefined) throw new Error(`no door ${key}`);
  return found;
}

function doorChanges(events: readonly SimEvent[]) {
  return events.flatMap((e) =>
    e.type === "doorStateChanged" ? [{ tick: e.tick, from: e.payload.from, to: e.payload.to }] : [],
  );
}

describe("doors", () => {
  it("opens a powered door over openSeconds, lets the actor through, then auto-closes", () => {
    const test = deck12World();
    const { world } = test;
    const config = world.config.values;
    place(world, JON, { x: 5, y: 5 });
    expect(requestMove(world.state, JON, { x: 5, y: 2 }, world.caches, config)).toBe(true);
    let waited = false;
    const events = stepChecked(test, 300, () => {
      const jon = world.state.actors[JON];
      if (jon?.movement.kind === "moving" && jon.movement.blockedSinceTick !== undefined) {
        waited = true;
        expect(jon.location).toMatchObject({ x: 5.5, y: 5.5 });
      }
    });
    expect(waited).toBe(true);
    expect(world.state.actors[JON]?.location).toMatchObject({ x: 5.5, y: 2.5 });
    const changes = doorChanges(events);
    expect(changes.map((c) => `${c.from}>${c.to}`)).toEqual([
      "closed>opening",
      "opening>open",
      "open>closing",
      "closing>closed",
    ]);
    const [opening = 0, open = 0, closing = 0, closed = 0] = changes.map((c) => c.tick);
    expect(open - opening).toBe(configTicks(config, config.doors.openSeconds));
    expect(closed - closing).toBe(configTicks(config, config.doors.closeSeconds));
    // Auto-close waits for the aperture to clear, then autoCloseAfterSeconds.
    expect(closing - open).toBeGreaterThanOrEqual(
      configTicks(config, config.doors.autoCloseAfterSeconds),
    );
    expect(door(world, "doorB").occupants).toEqual([]);
  });

  it("opens a manual door by hand over manualOpenSeconds and leaves it open", () => {
    const test = deck12World();
    const { world } = test;
    const config = world.config.values;
    place(world, JON, { x: 1, y: 5 });
    requestMove(world.state, JON, { x: 1, y: 2 }, world.caches, config);
    const events = stepChecked(test, 400);
    const changes = doorChanges(events);
    expect(changes.map((c) => `${c.from}>${c.to}`)).toEqual(["closed>opening", "opening>open"]);
    expect((changes[1]?.tick ?? 0) - (changes[0]?.tick ?? 0)).toBe(
      configTicks(config, config.doors.manualOpenSeconds),
    );
    expect(world.state.actors[JON]?.location).toMatchObject({ x: 1.5, y: 2.5 });
    expect(door(world, "doorA").physicalState).toBe("open");
  });

  it("an unpowered door holds its state and the waiting actor gives up with routeBlocked", () => {
    const test = deck12World();
    const { world } = test;
    const config = world.config.values;
    const main = world.state.power.domains.main;
    if (main === undefined) throw new Error("no main bus");
    main.tripped = true;
    place(world, JON, { x: 5, y: 5 });
    requestMove(world.state, JON, { x: 5, y: 2 }, world.caches, config);
    const reroute = configTicks(config, config.movement.blockedRerouteSeconds);
    const events = stepChecked(test, reroute + 5);
    expect(door(world, "doorB").physicalState).toBe("closed");
    const blocked = events.filter((e) => e.type === "routeBlocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.payload).toMatchObject({ doorId: door(world, "doorB").id });
    const jon = world.state.actors[JON];
    expect(jon?.movement).toMatchObject({
      kind: "stationary",
      routeFailure: { reason: "blocked" },
    });
    expect(jon?.location).toMatchObject({ x: 5.5, y: 5.5 });
    // It now believes the door will not open, so it will not plan through it again.
    expect(requestMove(world.state, JON, { x: 5, y: 2 }, world.caches, config)).toBe(false);

    // An open door with no power stays open even when asked to close.
    const doorC = door(world, "doorC");
    doorC.requestedState = "closed";
    stepChecked(test, 100);
    expect(doorC.physicalState).toBe("open");
  });

  it("a door that loses power mid-opening holds its progress", () => {
    const test = deck12World();
    const { world } = test;
    const doorB = door(world, "doorB");
    doorB.requestedState = "open";
    stepChecked(test, 10);
    expect(doorB.physicalState).toBe("opening");
    const progress = doorB.transitionProgress;
    const main = world.state.power.domains.main;
    if (main === undefined) throw new Error("no main bus");
    main.tripped = true;
    stepChecked(test, 30);
    expect(doorB.physicalState).toBe("opening");
    expect(doorB.transitionProgress).toBe(progress);
  });

  it("a jammed door blocks: the actor reaches it, gets routeBlocked and learns of the jam", () => {
    const test = deck12World();
    const { world } = test;
    const config = world.config.values;
    const doorC = door(world, "doorC");
    doorC.physicalState = "jammed";
    doorC.requestedState = "open";
    expect(requestMove(world.state, MARA, { x: 9, y: 2 }, world.caches, config)).toBe(true);
    const events = stepChecked(test, 300);
    const blocked = events.filter((e) => e.type === "routeBlocked");
    expect(blocked.map((e) => e.payload)).toEqual([{ tile: { x: 10, y: 4 }, doorId: doorC.id }]);
    const mara = world.state.actors[MARA];
    expect(mara?.location).toMatchObject({ x: 10.5, y: 5.5 });
    expect(mara?.movement).toMatchObject({
      kind: "stationary",
      routeFailure: { reason: "blocked" },
    });
    expect(mara?.knowledge[`${doorC.id}/doorState`]).toMatchObject({
      value: { physicalState: "jammed" },
      certainty: "confirmed",
    });
    expect(doorC.physicalState).toBe("jammed");
    expect(doorChanges(events)).toEqual([]);
    expect(requestMove(world.state, MARA, { x: 9, y: 2 }, world.caches, config)).toBe(false);
  });

  it("a powered ramp travels open and shut in rampOpenSeconds (D58)", () => {
    const test = rampWorld();
    const { world } = test;
    const config = world.config.values;
    expect(config.doors.rampOpenSeconds).not.toBe(config.doors.openSeconds);
    const ramp = door(world, "doorB");
    expect(ramp.kind).toBe("ramp");
    ramp.requestedState = "open";
    // Open, then the powered auto-close shuts it again: both legs take the ramp's time.
    const changes = doorChanges(stepChecked(test, 400));
    expect(changes.map((c) => `${c.from}>${c.to}`)).toEqual([
      "closed>opening",
      "opening>open",
      "open>closing",
      "closing>closed",
    ]);
    const [opening = 0, open = 0, closing = 0, closed = 0] = changes.map((c) => c.tick);
    const rampTicks = configTicks(config, config.doors.rampOpenSeconds);
    expect(open - opening).toBe(rampTicks);
    expect(closed - closing).toBe(rampTicks);
  });
});
