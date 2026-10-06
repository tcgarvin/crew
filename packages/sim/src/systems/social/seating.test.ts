import { describe, expect, it } from "vitest";
import { dayTicks } from "../../core/clock";
import { affinityOf } from "../../core/social";
import type { TileCoord } from "../../core/types/common";
import type { ActorId, LocalKey, MachineId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import { eatPlan } from "../galley/eat";
import {
  JAX,
  MARA,
  NOOR,
  TOMAS,
  actorOf,
  addServing,
  feels,
  galleyStepCtx,
  onGalleyDeck,
  placeAll,
  socialWorld,
} from "./fixtures/social-world";
import { type SeatOption, seatPreference } from "./seating";

/** The table's four seats: 1 (7,0) and 2 (8,0) north, 3 (7,2) and 4 (8,2) south. */
const SEAT: Readonly<Record<1 | 2 | 3 | 4, TileCoord>> = {
  1: { x: 7, y: 0 },
  2: { x: 8, y: 0 },
  3: { x: 7, y: 2 },
  4: { x: 8, y: 2 },
};

function tableId(world: World): MachineId {
  const table = Object.values(world.state.machines).find((m) => m.placementKey === "table");
  if (table === undefined) throw new Error("no table");
  return table.id;
}

function seat(world: World, n: 1 | 2 | 3 | 4, held = false): SeatOption {
  return {
    target: { machineId: tableId(world), positionKey: `seat_${n}` as LocalKey },
    tile: { ...SEAT[n] },
    held,
  };
}

/** Who eats stands by the counter; the rest where the test says. */
function setUp(where: Readonly<Record<ActorId, TileCoord>>) {
  const fixture = socialWorld();
  const { world } = fixture;
  placeAll(world, {
    [NOOR]: { x: 13, y: 3 },
    [TOMAS]: { x: 12, y: 3 },
    [JAX]: { x: 11, y: 3 },
    [MARA]: { x: 13, y: 1 },
    ...where,
  });
  return fixture;
}

describe("seatPreference (call 11)", () => {
  it("keeps the seat the eater already holds, even beside an enemy", () => {
    const { world } = setUp({ [NOOR]: SEAT[1], [JAX]: SEAT[2] });
    feels(world, NOOR, JAX, -5);
    const { ctx } = galleyStepCtx(world);
    const held = seat(world, 1, true);
    expect(seatPreference(ctx, actorOf(world, NOOR), [held, seat(world, 3)])).toBe(held);
  });

  it("an eater sits beside a friend rather than at the nearest seat", () => {
    const { world } = setUp({ [JAX]: SEAT[4] });
    feels(world, NOOR, JAX, 2);
    const { ctx } = galleyStepCtx(world);
    const choice = seatPreference(ctx, actorOf(world, NOOR), [
      seat(world, 1),
      seat(world, 2),
      seat(world, 3),
    ]);
    expect(choice?.tile).toEqual(SEAT[3]);
  });

  it("a friend still walking to the table counts where they will sit", () => {
    const { world } = setUp({});
    feels(world, NOOR, JAX, 2);
    const jax = actorOf(world, JAX);
    jax.activity = {
      kind: "personal",
      activity: "eat",
      urgency: "routineObligation",
      action: { kind: "eat", stage: "eating", progress: 0, startedTick: 0, interruptible: true },
      sinceTick: 0,
      plan: {
        steps: [{ kind: "moveTo", target: seat(world, 4).target, requested: false }],
        stepIndex: 0,
      },
    };
    const { ctx } = galleyStepCtx(world);
    const choice = seatPreference(ctx, actorOf(world, NOOR), [seat(world, 1), seat(world, 3)]);
    expect(choice?.tile).toEqual(SEAT[3]);
  });

  it("never beside an enemy when another seat is free, and none at all when every seat is", () => {
    const { world } = setUp({ [JAX]: SEAT[2], [TOMAS]: SEAT[4] });
    feels(world, NOOR, JAX, -3);
    const { ctx } = galleyStepCtx(world);
    const noor = actorOf(world, NOOR);
    expect(seatPreference(ctx, noor, [seat(world, 1), seat(world, 3)])?.tile).toEqual(SEAT[3]);
    feels(world, NOOR, TOMAS, -4);
    expect(seatPreference(ctx, noor, [seat(world, 1), seat(world, 3)])).toBeUndefined();
  });

  it("with nobody felt about either way, the nearest (first) seat", () => {
    const { world } = setUp({ [JAX]: SEAT[2] });
    const { ctx } = galleyStepCtx(world);
    const choice = seatPreference(ctx, actorOf(world, NOOR), [seat(world, 1), seat(world, 3)]);
    expect(choice?.tile).toEqual(SEAT[1]);
  });

  it("through the eat plan: beside a friend, and away from an enemy", () => {
    const pick = (affinity: number) => {
      const { world } = setUp({ [JAX]: SEAT[4], [NOOR]: { x: 4, y: 2 } });
      feels(world, NOOR, JAX, affinity);
      const serving = addServing(world, onGalleyDeck({ x: 4, y: 1 }), "good", 4);
      const { ctx } = galleyStepCtx(world);
      const result = eatPlan(ctx, actorOf(world, NOOR), serving.id, undefined);
      if (!("plan" in result)) throw new Error(`eat plan blocked: ${JSON.stringify(result)}`);
      const walk = result.plan.steps.find(
        (step) => step.kind === "moveTo" && "machineId" in step.target,
      );
      return walk?.kind === "moveTo" && "positionKey" in walk.target
        ? walk.target.positionKey
        : undefined;
    };
    expect(pick(3)).toBe("seat_3");
    expect(pick(-3)).not.toBe("seat_3");
  });
});

describe("the captain's table (call 11)", () => {
  it("day 0 beside her highest-affinity crew member, day 1 beside the lowest, each once", () => {
    const { world } = setUp({ [JAX]: SEAT[1], [TOMAS]: SEAT[4] });
    feels(world, MARA, JAX, 5);
    feels(world, MARA, TOMAS, -4);
    const mara = actorOf(world, MARA);
    const free = () => [seat(world, 2), seat(world, 3)];

    world.state.tick = 100;
    const first = galleyStepCtx(world);
    expect(seatPreference(first.ctx, mara, free())?.tile).toEqual(SEAT[2]);
    expect(actorOf(world, JAX).thoughts.map((t) => t.key)).toEqual(["satWithTheCaptain"]);
    expect(affinityOf(world.state, world.config.values.social, MARA, JAX)).toBe(6);
    expect(affinityOf(world.state, world.config.values.social, JAX, MARA)).toBe(1);
    expect(world.state.social.captainsTableDay).toBe(0);
    expect(first.drafts.filter((d) => d.type === "captainsTable").map((d) => d.payload)).toEqual([
      { captainId: MARA, withActorId: JAX },
    ]);

    // Her second meal that day is an ordinary choice: no table, no thought.
    const again = galleyStepCtx(world);
    seatPreference(again.ctx, mara, free());
    expect(again.drafts.filter((d) => d.type === "captainsTable")).toEqual([]);
    expect(actorOf(world, TOMAS).thoughts).toEqual([]);

    world.state.tick = dayTicks(world.config.values, 1) + 100;
    const next = galleyStepCtx(world);
    expect(seatPreference(next.ctx, mara, free())?.tile).toEqual(SEAT[3]);
    expect(actorOf(world, TOMAS).thoughts.map((t) => t.key)).toEqual(["satWithTheCaptain"]);
    expect(affinityOf(world.state, world.config.values.social, MARA, TOMAS)).toBe(-3);
    expect(affinityOf(world.state, world.config.values.social, TOMAS, MARA)).toBe(1);
    expect(world.state.social.captainsTableDay).toBe(1);
  });

  it("nobody at the tables: no captain's table, and the day is still open", () => {
    const { world } = setUp({});
    const { ctx, drafts } = galleyStepCtx(world);
    expect(seatPreference(ctx, actorOf(world, MARA), [seat(world, 1)])?.tile).toEqual(SEAT[1]);
    expect(world.state.social.captainsTableDay).toBe(-1);
    expect(drafts).toEqual([]);
  });

  it("only the captain keeps a table", () => {
    const { world } = setUp({ [JAX]: SEAT[1] });
    const { ctx, drafts } = galleyStepCtx(world);
    seatPreference(ctx, actorOf(world, NOOR), [seat(world, 2)]);
    expect(drafts).toEqual([]);
    expect(world.state.social.captainsTableDay).toBe(-1);
  });
});
