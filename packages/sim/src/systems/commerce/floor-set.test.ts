/**
 * D66, Dockside §5.2: the floor set, a pure function of state and content. Regulars at their
 * posts; the receiver for freight bound here (a dock hand from the name table, by the warehouse
 * door); a passenger left behind here, on the bench. Plus the 4 → 5 save migration.
 */
import { describe, expect, it } from "vitest";
import { TINY } from "../../core/fixtures/tiny-content";
import { floorSet } from "../../core/floor-set";
import { migrateState } from "../../core/save";
import type { ContentBundle } from "../../core/types/content";
import type { ActorId, JobId } from "../../core/types/ids";
import type { WorldState } from "../../core/types/state";
import type { Job } from "../../core/types/travel";
import { dockWorkContent, dockWorkWorld } from "./fixtures-dock";

const FAR = TINY.port2;

function withBench(content: ContentBundle): ContentBundle {
  const docks = Object.fromEntries(
    Object.entries(content.docks ?? {}).map(([id, dock]) => [
      id,
      dock.portId === FAR
        ? {
            ...dock,
            posts: [
              ...dock.posts,
              {
                key: "bench",
                kind: "bench" as const,
                name: "the bench",
                tile: { x: 8, y: 11 },
                facing: "n" as const,
              },
            ],
          }
        : dock,
    ]),
  );
  return { ...content, docks };
}

function freightJob(id: string, status: Job["status"]): Job {
  return {
    id: id as JobId,
    origin: "scenario",
    issuer: "Test Shipper",
    issuerPerson: { name: "Test Shipper", role: "shipper" },
    pitch: { key: "test", params: {} },
    urgency: "relaxed",
    description: { key: "test", params: {} },
    fromPortId: TINY.port,
    toPortId: FAR,
    cargo: [{ itemDefId: TINY.crate, count: 2 }],
    cargoClass: "general",
    pay: 100,
    status,
    offeredTick: 0,
    expiresAtTick: 1000,
    cargoItemIds: [],
  };
}

describe("the floor set (D66)", () => {
  it("adds a receiver for freight bound here and a left-behind passenger on the bench", () => {
    const content = withBench(
      dockWorkContent({
        dockHands: true,
        castSeed: { [FAR]: [{ name: "Greta Test", role: "shift boss", note: "n", post: "gate" }] },
      }),
    );
    const { world } = dockWorkWorld({ dockHands: true });
    const state = world.state as WorldState;
    expect(floorSet(state, content, FAR).map((e) => e.reason.kind)).toEqual(["regular"]);

    state.jobs["j90" as JobId] = freightJob("j90", "inTransit");
    state.jobs["j91" as JobId] = freightJob("j91", "paid");
    const passenger = Object.values(state.actors)[0];
    if (passenger === undefined) throw new Error("no actor");
    passenger.passenger = true;
    passenger.availability = "offShip";
    passenger.location = { kind: "inExternalStore", portId: FAR, storeKey: "warehouse" };
    state.jobs["j92" as JobId] = {
      ...freightJob("j92", "failed"),
      passage: {
        actorId: passenger.id as ActorId,
        roundTrip: true,
        leg: "ashore",
        endReason: "leftBehind",
      },
    };
    const entries = floorSet(state, content, FAR);
    expect(entries.map((e) => [e.reason.kind, e.postKey])).toEqual([
      ["regular", "gate"],
      ["receiver", "door"],
      ["passenger", "bench"],
    ]);
    const receiver = entries[1];
    expect(receiver).toMatchObject({ role: "dock hand", reason: { jobId: "j90" } });
    // Pure: the same state gives the same people, names included.
    expect(floorSet(state, content, FAR)).toEqual(entries);
    expect(entries[2]?.name).toBe(passenger.name);
  });
});

describe("save migration 4 → 5 (D66)", () => {
  it("adds an empty dockside, the local counter, and drops a pending approachingPort", () => {
    const { world } = dockWorkWorld();
    const raw = JSON.parse(JSON.stringify(world.state)) as Record<string, unknown> & {
      narrator: Record<string, unknown>;
      nextId: Record<string, unknown>;
    };
    // biome-ignore lint/performance/noDelete: a schema-4 save has no such key.
    delete raw.dockside;
    // biome-ignore lint/performance/noDelete: nor this counter.
    delete raw.nextId.local;
    raw.narrator.pendingHook = {
      id: "k7",
      kind: "approachingPort",
      context: { portId: FAR, etaTicks: 10 },
      tick: 5,
    };
    raw.schemaVersion = 4;
    const migrated = migrateState(raw, 4, { content: world.content }) as WorldState;
    expect(migrated.schemaVersion).toBe(6);
    expect(migrated.dockside).toEqual({ locals: {}, props: [] });
    expect(migrated.nextId.local).toBe(1);
    expect(migrated.narrator.pendingHook).toBeUndefined();
    expect(migrated.narrator.recentHookIds).toContain("k7");
  });
});
