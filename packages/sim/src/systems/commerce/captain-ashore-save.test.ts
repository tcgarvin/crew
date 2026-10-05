/**
 * D70: save schema 5 → 6. `jobBoard` becomes `captainAshore` (a pending hook and the docking's
 * last ask, both now naming who went ashore: the captain), `decisions.held` starts empty, and
 * D42's `surfaceWhenDocked` is retired: an offer whose card was waiting for the dock is withdrawn
 * as expired, since offers are now only made in person at the dock.
 */
import { describe, expect, it } from "vitest";
import { migrateState, migrations } from "../../core/save";
import type { WorldState } from "../../core/types/state";
import { PORTS, freightTestWorld } from "../travel/fixtures";

type Raw = Record<string, unknown> & {
  narrator: Record<string, unknown>;
  decisions: Record<string, unknown>;
  jobs: Record<string, Record<string, unknown>>;
  tick: number;
};

function schema5(): { raw: Raw; captainId: string } {
  const { world } = freightTestWorld();
  const raw = JSON.parse(JSON.stringify(world.state)) as Raw;
  const captain = Object.values(world.state.actors).find((a) => a.roleTags.includes("captain"));
  if (captain === undefined) throw new Error("no captain");
  // biome-ignore lint/performance/noDelete: a schema-5 save has no such key.
  delete raw.decisions.held;
  raw.tick = 500;
  raw.schemaVersion = 5;
  return { raw, captainId: captain.id };
}

describe("save migration 5 → 6 (D70)", () => {
  it("renames the board's ask and a pending jobBoard hook, naming the captain", () => {
    const { raw, captainId } = schema5();
    raw.narrator.jobBoardLastAsk = { portId: PORTS.a, tick: 400 };
    raw.narrator.pendingHook = {
      id: "k1",
      kind: "jobBoard",
      context: { portId: PORTS.a },
      tick: 400,
    };
    const migrated = migrateState(
      raw,
      5,
      { content: {} as never, config: {} as never },
      migrations,
      6,
    ) as WorldState;
    expect(migrated.schemaVersion).toBe(6);
    expect(migrated.decisions.held).toEqual([]);
    expect(
      (migrated.narrator as unknown as Record<string, unknown>).jobBoardLastAsk,
    ).toBeUndefined();
    expect(migrated.narrator.captainAshoreLastAsk).toEqual({
      portId: PORTS.a,
      tick: 400,
      actorId: captainId,
    });
    expect(migrated.narrator.pendingHook).toEqual({
      id: "k1",
      kind: "captainAshore",
      context: { portId: PORTS.a, actorId: captainId },
      tick: 400,
    });
  });

  it("withdraws an offer whose card was waiting for the dock, and keeps a closed one closed", () => {
    const { raw } = schema5();
    const job = (id: string, status: string) => ({
      id,
      status,
      fromPortId: PORTS.b,
      toPortId: PORTS.a,
      surfaceWhenDocked: true,
    });
    raw.jobs = { j1: job("j1", "offered"), j2: job("j2", "declined") };
    const migrated = migrateState(
      raw,
      5,
      { content: {} as never, config: {} as never },
      migrations,
      6,
    ) as unknown as Raw;
    expect(migrated.jobs.j1).toEqual({
      id: "j1",
      status: "expired",
      closedTick: 500,
      fromPortId: PORTS.b,
      toPortId: PORTS.a,
    });
    expect(migrated.jobs.j2?.status).toBe("declined");
    expect(migrated.jobs.j2?.surfaceWhenDocked).toBeUndefined();
  });
});
