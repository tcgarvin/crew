/**
 * §delivery-and-pay, §fragile-cargo: a delivery is paid for the share of its crates that arrived
 * whole, never under `commerce.brokenFloorShare`, and `contractCompleted` says how many were smashed.
 */
import { describe, expect, it } from "vitest";
import { allocateId } from "../../core/ids";
import { tickerLine } from "../../core/render";
import type { ItemId } from "../../core/types/ids";
import type { Job } from "../../core/types/travel";
import { FIX, PORTS, freightTestWorld } from "../travel/fixtures";
import { deliveredPay } from "./jobs";

describe("deliveredPay (§delivery-and-pay)", () => {
  it("pays in full with nothing smashed", () => {
    expect(deliveredPay(300, 6, 0, 0.1)).toBe(300);
  });

  it("pays the share that arrived whole, in whole credits", () => {
    expect(deliveredPay(300, 6, 2, 0.1)).toBe(200);
    expect(deliveredPay(100, 3, 1, 0.1)).toBe(67);
  });

  it("never pays under the floor share, even with every crate smashed", () => {
    expect(deliveredPay(300, 6, 6, 0.1)).toBe(30);
    expect(deliveredPay(300, 6, 6, 0)).toBe(0);
  });

  it("refuses more smashed crates than the job has", () => {
    expect(() => deliveredPay(300, 2, 3, 0.1)).toThrow(/3 broken of 2/);
  });
});

/** A fragile job delivered to the warehouse of the port the ship is docked at, `broken` smashed. */
function delivered(crates: number, broken: number) {
  const test = freightTestWorld();
  const { world, kernel } = test;
  const { state } = world;
  const id = allocateId(state, "job");
  const cargoItemIds = Array.from({ length: crates }, (_, i): ItemId => {
    const itemId = allocateId(state, "item");
    state.items[itemId] = {
      id: itemId,
      defId: FIX.parts,
      stacking: "stack",
      count: 1,
      reserved: 0,
      jobId: id,
      location: { kind: "inExternalStore", portId: PORTS.a, storeKey: "warehouse" },
      ...(i < broken ? { broken: true } : {}),
    };
    return itemId;
  });
  const job: Job = {
    id,
    origin: "scenario",
    issuer: "Ines Oduya, Tiny Freight",
    issuerPerson: { name: "Ines Oduya", role: "dock foreman", org: "Tiny Freight" },
    pitch: { key: "job.pitch", params: {} },
    urgency: "soon",
    description: { key: "job.template", params: {} },
    fromPortId: PORTS.b,
    toPortId: PORTS.a,
    cargo: [{ itemDefId: FIX.parts, count: crates }],
    cargoClass: "fragile",
    pay: 300,
    status: "inTransit",
    offeredTick: 0,
    expiresAtTick: 10_000,
    cargoItemIds,
  };
  state.jobs[id] = job;
  const before = state.money.balance;
  const events = kernel.advance(world, 1).events;
  return { world, job, events, earned: state.money.balance - before };
}

describe("a delivery with smashed crates (§fragile-cargo)", () => {
  it("is paid for the crates that arrived whole, and says how many were smashed", () => {
    const { world, job, events, earned } = delivered(6, 2);
    expect(job.status).toBe("paid");
    expect(earned).toBe(200);
    const completed = events.find((e) => e.type === "contractCompleted");
    expect(completed?.payload).toEqual({ jobId: job.id, brokenCount: 2 });
    const paid = events.find((e) => e.type === "paymentMade");
    expect(paid?.payload).toMatchObject({ amount: 200, jobId: job.id });
    if (completed === undefined) throw new Error("no contractCompleted");
    expect(tickerLine(completed, world.state, world.content)).toBe(
      "Delivered for Ines Oduya, Tiny Freight: 2 crates smashed",
    );
  });

  it("still completes with every crate smashed, at the floor share", () => {
    const { job, events, earned } = delivered(3, 3);
    expect(job.status).toBe("paid");
    expect(earned).toBe(30);
    const completed = events.find((e) => e.type === "contractCompleted");
    expect(completed?.payload).toEqual({ jobId: job.id, brokenCount: 3 });
  });

  it("pays in full with every crate whole", () => {
    const { world, events, earned } = delivered(3, 0);
    expect(earned).toBe(300);
    const completed = events.find((e) => e.type === "contractCompleted");
    if (completed === undefined) throw new Error("no contractCompleted");
    expect(completed.payload).toMatchObject({ brokenCount: 0 });
    expect(tickerLine(completed, world.state, world.content)).toBe(
      "Delivered for Ines Oduya, Tiny Freight",
    );
  });
});
