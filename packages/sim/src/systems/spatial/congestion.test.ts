import { describe, expect, it } from "vitest";
import { configTicks } from "../../core/clock";
import type { MachineId } from "../../core/types/ids";
import { JON, MARA, deck12World } from "./fixtures/deck-12x8";
import { stepChecked } from "./fixtures/helpers";
import { requestMove } from "./movement";
import { holdsReservation, reservationHolders } from "./reservations";

describe("interaction position congestion", () => {
  it("lets exactly one actor occupy a capacity-1 position; the other waits adjacent", () => {
    const test = deck12World();
    const { world } = test;
    const config = world.config.values;
    const pump = Object.values(world.state.machines).find((m) => m.placementKey === "pump1");
    const target = { machineId: pump?.id as MachineId, positionKey: "front" };
    expect(requestMove(world.state, MARA, target, world.caches, config)).toBe(true);
    expect(requestMove(world.state, JON, target, world.caches, config)).toBe(true);
    const deck = world.state.actors[MARA]?.location;
    if (deck?.kind !== "onDeck") throw new Error("Mara not on deck");
    const ip = { x: 9, y: 1 };
    expect(holdsReservation(world.caches, deck.deckId, ip, MARA)).toBe(true);
    expect(holdsReservation(world.caches, deck.deckId, ip, JON)).toBe(false);

    let jonWaited = false;
    const reroute = configTicks(config, config.movement.blockedRerouteSeconds);
    stepChecked(test, 400, () => {
      const onIp = Object.values(world.state.actors).filter(
        (a) =>
          a.location.kind === "onDeck" &&
          Math.floor(a.location.x) === ip.x &&
          Math.floor(a.location.y) === ip.y &&
          a.movement.kind === "stationary",
      );
      expect(onIp.length).toBeLessThanOrEqual(1);
      const jon = world.state.actors[JON];
      if (jon?.movement.kind === "moving" && jon.movement.blockedSinceTick !== undefined) {
        jonWaited = true;
      }
    });
    expect(jonWaited).toBe(true);
    expect(world.state.actors[MARA]?.location).toMatchObject({ x: 9.5, y: 1.5 });
    expect(reservationHolders(world.caches, deck.deckId, ip)).toEqual([MARA]);
    const jon = world.state.actors[JON];
    if (jon?.location.kind !== "onDeck") throw new Error("Jon not on deck");
    const jx = Math.floor(jon.location.x);
    const jy = Math.floor(jon.location.y);
    expect(Math.max(Math.abs(jx - ip.x), Math.abs(jy - ip.y))).toBe(1);
    // Bounded wait: after blockedRerouteSeconds Jon stops and asks to replan.
    expect(jon.movement).toMatchObject({
      kind: "stationary",
      routeFailure: { reason: "positionTaken", tile: ip },
    });
    expect(reroute).toBeGreaterThan(0);

    // Once Mara leaves, Jon can take the position.
    requestMove(world.state, MARA, { x: 11, y: 3 }, world.caches, config);
    expect(requestMove(world.state, JON, target, world.caches, config)).toBe(true);
    stepChecked(test, 100);
    expect(world.state.actors[JON]?.location).toMatchObject({ x: 9.5, y: 1.5 });
  });
});
