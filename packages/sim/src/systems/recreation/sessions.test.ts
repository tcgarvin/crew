/**
 * Session rows (slice 4, call 4): opening (or joining the one open at the venue), joining with
 * room and before `lateJoinSeconds`, and leaving: the host hands over, an empty open session
 * collapses, a contest under `min` once started is abandoned.
 */
import { describe, expect, it } from "vitest";
import type { TestWorld } from "../../core/fixtures/test-world";
import type { ActorId, CompartmentId, MachineId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import type { SessionVenue } from "../../core/types/state";
import {
  ACTIVITY,
  BETTINA,
  DANE,
  JAX,
  NOOR,
  TOMAS,
  loungeStepCtx,
  loungeWorld,
  runFor,
} from "./fixtures/lounge-deck";
import { joinSession, leaveSession, openSession } from "./sessions";

function fresh(): TestWorld {
  const fixture = loungeWorld();
  runFor(fixture, 1);
  return fixture;
}

const actor = (world: World, id: ActorId) => {
  const found = world.state.actors[id];
  if (found === undefined) throw new Error(`no ${id}`);
  return found;
};

function tableVenue(world: World): SessionVenue {
  const table = Object.values(world.state.machines).find((m) => m.placementKey === "table");
  const lounge = Object.values(world.state.compartments).find((c) => c.key === "lounge");
  if (table === undefined || lounge === undefined) throw new Error("fixture changed");
  return { compartmentId: lounge.id as CompartmentId, machineId: table.id as MachineId };
}

const cards = (world: World) => {
  const def = world.content.activities[ACTIVITY.cards];
  if (def === undefined) throw new Error("no cards");
  return def;
};

describe("openSession and joinSession", () => {
  it("opens a row for the host, and a second host at the same venue joins it instead", () => {
    const { world } = fresh();
    const { ctx, drafts } = loungeStepCtx(world);
    const id = openSession(ctx, actor(world, JAX), cards(world), tableVenue(world));
    const again = openSession(ctx, actor(world, TOMAS), cards(world), tableVenue(world));
    expect(again).toBe(id);
    const row = world.state.social.sessions[id];
    expect(row?.hostId).toBe(JAX);
    expect(row?.members).toEqual([JAX, TOMAS]);
    expect(row?.openedTick).toBe(ctx.tick);
    expect(drafts.map((d) => d.type)).toEqual(["sessionOpened", "sessionJoined"]);
    expect(world.state.nextId.session).toBe(2);
  });

  it("refuses a fifth at a four-hand table, and a latecomer past lateJoinSeconds", () => {
    const { world } = fresh();
    const { ctx } = loungeStepCtx(world);
    const id = openSession(ctx, actor(world, JAX), cards(world), tableVenue(world));
    for (const other of [TOMAS, NOOR, BETTINA]) {
      expect(joinSession(ctx, actor(world, other), id)).toBe(true);
    }
    expect(joinSession(ctx, actor(world, DANE), id)).toBe(false);
    const row = world.state.social.sessions[id];
    if (row === undefined) throw new Error("no row");
    row.members = [JAX, TOMAS];
    row.startedTick = ctx.tick;
    row.endsAtTick = ctx.tick + 1000;
    const late = world.config.values.recreation.lateJoinSeconds * world.config.values.time.tickRate;
    const later = { ...ctx, tick: ctx.tick + late };
    expect(joinSession(later, actor(world, NOOR), id)).toBe(true);
    const tooLate = { ...ctx, tick: ctx.tick + late + 1 };
    expect(joinSession(tooLate, actor(world, BETTINA), id)).toBe(false);
  });
});

describe("leaveSession", () => {
  it("hands an open session to the next member, and collapses one left empty", () => {
    const { world } = fresh();
    const { ctx, drafts } = loungeStepCtx(world);
    const id = openSession(ctx, actor(world, JAX), cards(world), tableVenue(world));
    joinSession(ctx, actor(world, TOMAS), id);
    leaveSession(ctx, actor(world, JAX), id);
    expect(world.state.social.sessions[id]?.hostId).toBe(TOMAS);
    leaveSession(ctx, actor(world, TOMAS), id);
    expect(world.state.social.sessions[id]).toBeUndefined();
    const collapsed = drafts.filter((d) => d.type === "sessionCollapsed");
    expect(collapsed.map((d) => d.payload)).toEqual([
      { sessionId: id, activityId: ACTIVITY.cards, toSolo: false },
    ]);
  });

  it("ends a started two-hand contest abandoned, with no winner, when one leaves", () => {
    const { world } = fresh();
    const { ctx, drafts } = loungeStepCtx(world);
    const id = openSession(ctx, actor(world, JAX), cards(world), tableVenue(world));
    joinSession(ctx, actor(world, TOMAS), id);
    const row = world.state.social.sessions[id];
    if (row === undefined) throw new Error("no row");
    row.startedTick = ctx.tick;
    row.endsAtTick = ctx.tick + 1000;
    leaveSession(ctx, actor(world, TOMAS), id);
    expect(world.state.social.sessions[id]).toBeUndefined();
    const ended = drafts.filter((d) => d.type === "sessionEnded");
    expect(ended).toHaveLength(1);
    expect(ended[0]?.payload).toEqual({
      sessionId: id,
      activityId: ACTIVITY.cards,
      outcome: "abandoned",
      memberIds: [JAX],
    });
  });
});
