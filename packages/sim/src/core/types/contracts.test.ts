import { describe, expect, it } from "vitest";
import { exampleWorldState } from "../fixtures/example-world";
import { AUTHORITY, NARRATOR_COMMAND_KINDS } from "./commands/authority";
import { EVENT_SIGNIFICANCE } from "./events";
import { PHASES } from "./pipeline";
import { URGENCY_CLASSES } from "./work";

describe("W0 contracts", () => {
  it("WorldState example survives a JSON round-trip unchanged", () => {
    const state = exampleWorldState();
    expect(JSON.parse(JSON.stringify(state))).toStrictEqual(state);
  });

  it("narrator authority is exactly the four V1 command kinds", () => {
    expect([...AUTHORITY.narrator].sort()).toEqual(
      ["offerJob", "scheduleFault", "spawnAtBoundary", "surfaceDecision"].sort(),
    );
    expect(AUTHORITY.narrator).toBe(NARRATOR_COMMAND_KINDS);
  });

  it("no source other than scenario may spawn inside the ship or set needs", () => {
    for (const source of ["player", "narrator", "system"] as const) {
      expect(AUTHORITY[source]).not.toContain("scenarioSpawn");
      expect(AUTHORITY[source]).not.toContain("scenarioSetNeeds");
      expect(AUTHORITY[source]).not.toContain("scenarioInjectFault");
    }
  });

  it("pins the SD §5.2 phase order and the five SD §15.2 urgency classes", () => {
    expect(PHASES).toHaveLength(8);
    expect(PHASES[0]).toBe("inputs");
    expect(PHASES[6]).toBe("planning");
    expect(URGENCY_CLASSES).toHaveLength(5);
  });

  it("has a default significance for the SD §19.3 events and the narrator/decision events", () => {
    for (const type of [
      "enteredCompartment",
      "taskSelected",
      "actionFailed",
      "faultObserved",
      "faultDiagnosed",
      "machineDerated",
      "doorJammed",
      "breachChanged",
      "woundCreated",
      "treatmentApplied",
      "actorIncapacitated",
      "actorDied",
      "reportDelivered",
      "cargoTransferred",
      "contractCompleted",
      "policyDecisionNeeded",
      "narratorHookRaised",
      "decisionPending",
      "decisionResolved",
      "paymentMade",
    ] as const) {
      expect(EVENT_SIGNIFICANCE[type]).toMatch(/^(trace|notable|narrative)$/);
    }
  });
});
