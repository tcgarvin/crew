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

  it("narrator authority is the V1 kinds plus stockMarket, staging-only stageDock, scheduleHazard, scheduleField, requestCall, markUnseen and D106's outcome levers (§narrator-authority, D105, D106)", () => {
    expect([...AUTHORITY.narrator].sort()).toEqual(
      [
        "markUnseen",
        "strike",
        "transact",
        "plantMemory",
        "fallOut",
        "giveThought",
        "reveal",
        "injectFault",
        "offerJob",
        "requestCall",
        "scheduleFault",
        "scheduleField",
        "scheduleHazard",
        "spawnAtBoundary",
        "stageDock",
        "stockMarket",
        "surfaceDecision",
      ].sort(),
    );
    expect(AUTHORITY.narrator).toBe(NARRATOR_COMMAND_KINDS);
  });

  it("starts an expedition only as the scenario; the player chooses its plan and calls it back (expeditions A1)", () => {
    expect(AUTHORITY.scenario).toEqual(
      expect.arrayContaining(["scenarioStartExpedition", "adoptPlan", "withdrawParty"]),
    );
    expect(AUTHORITY.player).toEqual(expect.arrayContaining(["adoptPlan", "withdrawParty"]));
    for (const source of ["player", "narrator", "system"] as const) {
      expect(AUTHORITY[source]).not.toContain("scenarioStartExpedition");
    }
    expect(AUTHORITY.narrator).not.toContain("adoptPlan");
    expect(AUTHORITY.system).not.toContain("adoptPlan");
  });

  it("lets only the narrator and the scenario use the outcome levers (D106)", () => {
    const kinds = [
      "strike",
      "transact",
      "plantMemory",
      "fallOut",
      "giveThought",
      "reveal",
      "injectFault",
    ] as const;
    for (const kind of kinds) {
      expect(AUTHORITY.narrator).toContain(kind);
      expect(AUTHORITY.scenario).toContain(kind);
      expect(AUTHORITY.player).not.toContain(kind);
      expect(AUTHORITY.system).not.toContain(kind);
    }
  });

  it("lets only the narrator and the scenario mark a way in unseen; the player never (D105)", () => {
    expect(AUTHORITY.narrator).toContain("markUnseen");
    expect(AUTHORITY.scenario).toContain("markUnseen");
    expect(AUTHORITY.player).not.toContain("markUnseen");
    expect(AUTHORITY.system).not.toContain("markUnseen");
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
