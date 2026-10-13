/**
 * §fragile-cargo: a rock in a compartment smashes the fragile crates of a live freight job lying
 * there, each at `field.fragileBreakChance` by rock. General freight, a paid job's crates and
 * crates in another room are untouched.
 */
import { describe, expect, it } from "vitest";
import { allocateId } from "../../core/ids";
import { tickerLine } from "../../core/render";
import type { ItemDefId, ItemId, JobId } from "../../core/types/ids";
import type { WorldState } from "../../core/types/state";
import type { Job } from "../../core/types/travel";
import { FIX, PORTS } from "../travel/fixtures";
import {
  FIELD,
  compartment,
  fieldWorld,
  fieldWorldViolations,
  ofType,
  runUntil,
  scheduleField,
  underWay,
} from "./fixtures/field-deck";

/** A freight job of `cargoClass` carrying a one-unit crate at each `xs` on row 2 of the deck. */
function addJob(
  state: WorldState,
  status: Job["status"],
  cargoClass: Job["cargoClass"],
  xs: readonly number[],
): Job {
  const itemDefId: ItemDefId = cargoClass === "fragile" ? FIX.parts : FIX.crate;
  const id = allocateId(state, "job");
  const cargoItemIds = xs.map((x): ItemId => {
    const itemId = allocateId(state, "item");
    state.items[itemId] = {
      id: itemId,
      defId: itemDefId,
      stacking: "stack",
      count: 1,
      reserved: 0,
      jobId: id,
      location: { kind: "onDeck", deckId: FIELD.deck, x: x + 0.5, y: 2.5 },
    };
    return itemId;
  });
  const job: Job = {
    id,
    origin: "narrator",
    issuer: "Ines Oduya, Tiny Freight",
    issuerPerson: { name: "Ines Oduya", role: "dock foreman", org: "Tiny Freight" },
    pitch: { key: "job.pitch", params: {} },
    urgency: "soon",
    description: { key: "job.template", params: {} },
    fromPortId: PORTS.a,
    toPortId: PORTS.b,
    cargo: [{ itemDefId, count: xs.length }],
    cargoClass,
    pay: 300,
    status,
    offeredTick: 0,
    expiresAtTick: 10_000,
    cargoItemIds,
  };
  state.jobs[id] = job;
  return job;
}

/**
 * A ship under way carrying: a live fragile job with two crates in the hold (x 4, 6) and one in
 * engineering (x 10), a general crate in the hold, and a paid fragile job's crate in the hold. One
 * small rock is scripted into the hold.
 */
function holdStruck(chance: number) {
  const test = fieldWorld({ field: { fragileBreakChance: { small: chance, large: chance } } });
  underWay(test);
  const { state } = test.world;
  const fragile = addJob(state, "inTransit", "fragile", [4, 6, 10]);
  const general = addJob(state, "inTransit", "general", [5]);
  const paid = addJob(state, "paid", "fragile", [7]);
  const hold = compartment(test.world, "hold");
  const field = scheduleField(test, {
    severity: "light",
    detection: "rolled",
    windowTicks: [0, 0],
    scripted: [
      { atSeconds: 0, target: { kind: "compartment", compartmentId: hold }, rock: "small" },
    ],
  });
  const events = runUntil(test, 30, () => field.scripted[0]?.firedTick !== undefined);
  return { test, events, hold, fragile, general, paid };
}

const brokenOf = (state: WorldState, job: Job) =>
  job.cargoItemIds.map((id) => state.items[id]?.broken === true);

describe("fragile cargo in the rocks (§fragile-cargo)", { timeout: 30_000 }, () => {
  it("at chance 1 smashes only the live fragile job's crates in the struck room", () => {
    const { test, events, hold, fragile, general, paid } = holdStruck(1);
    const { state } = test.world;
    // The third crate is in engineering, which was not struck.
    expect(brokenOf(state, fragile)).toEqual([true, true, false]);
    expect(brokenOf(state, general)).toEqual([false]);
    expect(brokenOf(state, paid)).toEqual([false]);
    const smashed = ofType(events, "cargoBroken");
    expect(smashed.map((e) => e.payload)).toEqual([
      { jobId: fragile.id, itemId: fragile.cargoItemIds[0], compartmentId: hold },
      { jobId: fragile.id, itemId: fragile.cargoItemIds[1], compartmentId: hold },
    ]);
    const first = smashed[0];
    if (first === undefined) throw new Error("no cargoBroken");
    expect(first.significance).toBe("notable");
    expect(tickerLine(first, state, test.world.content)).toBe(
      "A crate of fragile electronics is smashed in the hold",
    );
    expect(fieldWorldViolations(test.world)).toEqual([]);
  });

  it("at chance 0 smashes nothing", () => {
    const { test, events } = holdStruck(0);
    expect(ofType(events, "cargoBroken")).toEqual([]);
    expect(Object.values(test.world.state.items).some((item) => item.broken === true)).toBe(false);
  });
});
