import type { ActivityDef, ActivityDefId, MachineId, WorldState } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { gatheringLine } from "./gathering";

const TICK_RATE = 20;
const TABLE = "machine:table" as MachineId;

const activities = {
  "activity.cards": { label: "playing cards", waitingLabel: "waiting for a game of cards" },
  "activity.vids": { label: "watching a vid", waitingLabel: "putting a vid on" },
} as unknown as Readonly<Record<ActivityDefId, Pick<ActivityDef, "label" | "waitingLabel">>>;

const actors = {
  jax: { name: "Jax Okonkwo" },
  tomas: { name: "Tomas Ruiz" },
  dane: { name: "Dane Whitcross" },
} as unknown as WorldState["actors"];

function state(tick: number, sessions: readonly Readonly<Record<string, unknown>>[]) {
  const rows = Object.fromEntries(
    sessions.map((s, i) => [
      `session:${i + 1}`,
      {
        id: `session:${i + 1}`,
        activityId: "activity.cards",
        venue: { compartmentId: "c:lounge", machineId: TABLE },
        hostId: "jax",
        members: ["jax", "tomas", "dane"],
        openedTick: 100,
        ...s,
      },
    ]),
  );
  return { tick, actors, social: { sessions: rows } } as unknown as Pick<
    WorldState,
    "tick" | "social" | "actors"
  >;
}

describe("gatheringLine (slice 4, call 17)", () => {
  it("names the game at the machine, its players and how long it has run", () => {
    const running = state(100 + 50 * TICK_RATE, [{ startedTick: 100 + 10 * TICK_RATE }]);
    expect(gatheringLine(running, TABLE, activities, TICK_RATE)).toBe(
      "cards: Jax, Tomas, Dane, 40 s in",
    );
  });

  it("says minutes once a game has run a minute", () => {
    const long = state(100 + 400 * TICK_RATE, [{ startedTick: 100 }]);
    expect(gatheringLine(long, TABLE, activities, TICK_RATE)).toBe(
      "cards: Jax, Tomas, Dane, 6 min in",
    );
  });

  it("says how long the host has waited while it gathers", () => {
    const gathering = state(100 + 12 * TICK_RATE, [{ members: ["jax"] }]);
    expect(gatheringLine(gathering, TABLE, activities, TICK_RATE)).toBe(
      "waiting for a game of cards: Jax, 12 s waiting",
    );
  });

  it("is absent for a machine with no session, or a session held elsewhere", () => {
    expect(gatheringLine(state(200, []), TABLE, activities, TICK_RATE)).toBeUndefined();
    const elsewhere = state(200, [
      { venue: { compartmentId: "c:lounge", machineId: "machine:screen" as MachineId } },
      { venue: { compartmentId: "c:lounge", zoneKey: "viewport" } },
    ]);
    expect(gatheringLine(elsewhere, TABLE, activities, TICK_RATE)).toBeUndefined();
  });

  it("refuses a session whose activity the content does not have", () => {
    const bad = state(200, [{ activityId: "activity.nope" as ActivityDefId }]);
    expect(() => gatheringLine(bad, TABLE, activities, TICK_RATE)).toThrow(/activity\.nope/);
  });
});
