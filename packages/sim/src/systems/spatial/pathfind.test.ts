import { describe, expect, it } from "vitest";
import type { TileCoord } from "../../core/types/common";
import type { DoorId } from "../../core/types/ids";
import { DECK12, MARA, deck12World, doorByKey } from "./fixtures/deck-12x8";
import { deckGeometry } from "./geometry";
import { type PathPolicy, cachedPath, findPath, pathLength } from "./pathfind";
import { actorPolicy } from "./routing";

const open: PathPolicy = { doorCost: () => 0, tileBlocked: () => false };

function setup() {
  const test = deck12World();
  return { ...test, geometry: deckGeometry(test.world.caches, DECK12.deck) };
}

function isAdjacent(a: TileCoord, b: TileCoord) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) === 1;
}

describe("findPath", () => {
  it("walks a straight corridor", () => {
    const { geometry } = setup();
    const path = findPath(geometry, { x: 0, y: 5 }, { x: 11, y: 5 }, open);
    expect(path).toHaveLength(12);
    expect(pathLength(path ?? [])).toBe(11);
  });

  it("crosses doors orthogonally and finds the expected length between rooms", () => {
    const { geometry } = setup();
    const path = findPath(geometry, { x: 1, y: 3 }, { x: 10, y: 3 }, open) ?? [];
    expect(pathLength(path)).toBeCloseTo(13, 9);
    expect(path).toEqual(
      expect.arrayContaining([
        { x: 1, y: 4 },
        { x: 1, y: 5 },
        { x: 10, y: 5 },
        { x: 10, y: 4 },
      ]),
    );
    for (let i = 1; i < path.length; i++) {
      expect(isAdjacent(path[i - 1] as TileCoord, path[i] as TileCoord)).toBe(true);
    }
  });

  it("uses diagonals in open floor", () => {
    const { geometry } = setup();
    const path = findPath(geometry, { x: 0, y: 0 }, { x: 3, y: 3 }, open) ?? [];
    expect(path).toHaveLength(4);
    expect(pathLength(path)).toBeCloseTo(3 * Math.SQRT2, 9);
  });

  it("refuses to cut corners past a machine footprint, a wall or a door", () => {
    const { geometry } = setup();
    // (10,1) is the pump: the diagonal (9,1)→(10,2) would clip it.
    expect(pathLength(findPath(geometry, { x: 9, y: 1 }, { x: 10, y: 2 }, open) ?? [])).toBe(2);
    // Room A → corridor next to door A: no diagonal through the door's corner.
    expect(pathLength(findPath(geometry, { x: 1, y: 4 }, { x: 0, y: 5 }, open) ?? [])).toBe(2);
    expect(pathLength(findPath(geometry, { x: 0, y: 4 }, { x: 1, y: 5 }, open) ?? [])).toBe(2);
    // A→B wall: must go round through the corridor.
    const round = findPath(geometry, { x: 3, y: 4 }, { x: 4, y: 4 }, open) ?? [];
    expect(pathLength(round)).toBeGreaterThan(4);
  });

  it("treats a jammed door as a wall", () => {
    const { world, geometry } = setup();
    const doorC = doorByKey(world, "doorC");
    const jammed: PathPolicy = {
      doorCost: (id: DoorId) => (id === doorC ? null : 0),
      tileBlocked: () => false,
    };
    expect(findPath(geometry, { x: 0, y: 5 }, { x: 11, y: 0 }, jammed)).toBeNull();
    expect(findPath(geometry, { x: 1, y: 3 }, { x: 11, y: 5 }, jammed)).not.toBeNull();

    // The same through an actor's knowledge.
    const actor = world.state.actors[MARA];
    if (actor === undefined) throw new Error("no Mara");
    actor.knowledge[`${doorC}/doorState`] = {
      subjectId: doorC,
      factType: "doorState",
      value: { physicalState: "jammed" },
      observedTick: 0,
      learnedTick: 0,
      sourceId: MARA,
      evidence: "direct",
      certainty: "confirmed",
    };
    const policy = actorPolicy(world.state, geometry, actor, world.config.values);
    expect(findPath(geometry, { x: 0, y: 5 }, { x: 11, y: 0 }, policy)).toBeNull();
  });

  it("returns null when isolated or the target is not floor", () => {
    const { geometry } = setup();
    const sealed: PathPolicy = { doorCost: () => null, tileBlocked: () => false };
    expect(findPath(geometry, { x: 0, y: 0 }, { x: 0, y: 5 }, sealed)).toBeNull();
    expect(findPath(geometry, { x: 0, y: 5 }, { x: 0, y: 7 }, open)).toBeNull();
    expect(findPath(geometry, { x: 0, y: 5 }, { x: 10, y: 1 }, open)).toBeNull();
    expect(findPath(geometry, { x: 0, y: 5 }, { x: 0, y: 5 }, open)).toEqual([{ x: 0, y: 5 }]);
  });

  it("caches results by policy key", () => {
    const { world, geometry } = setup();
    const keyed: PathPolicy = { ...open, key: "open" };
    const first = cachedPath(world.caches, geometry, { x: 0, y: 5 }, { x: 11, y: 6 }, keyed);
    const second = cachedPath(world.caches, geometry, { x: 0, y: 5 }, { x: 11, y: 6 }, keyed);
    expect(second).toBe(first);
    expect(world.caches.nav.paths.size).toBe(1);
  });
});
