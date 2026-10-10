/** Expeditions A1: the dev-only `?expedition=` start. */
import { describe, expect, it } from "vitest";
import { devExpeditionCommand, devExpeditionFromSearch } from "./devExpedition";

describe("devExpeditionFromSearch", () => {
  it("reads the site and an optional plan", () => {
    expect(devExpeditionFromSearch("?expedition=port.boathouse")).toEqual({
      siteId: "port.boathouse",
    });
    expect(devExpeditionFromSearch("?expedition=port.boathouse&plan=hold-lethal-armed")).toEqual({
      siteId: "port.boathouse",
      plan: "hold-lethal-armed",
    });
  });

  it("asks for nothing without the parameter, or with it empty", () => {
    expect(devExpeditionFromSearch("")).toBeUndefined();
    expect(devExpeditionFromSearch("?expedition=")).toBeUndefined();
    expect(devExpeditionFromSearch("?plan=hold-lethal-armed")).toBeUndefined();
  });
});

describe("devExpeditionCommand", () => {
  it("is the scenario's start command, the plan only when given", () => {
    const command = devExpeditionCommand({ siteId: "port.boathouse" as never });
    expect(command).toMatchObject({
      source: "scenario",
      kind: "scenarioStartExpedition",
      payload: { siteId: "port.boathouse" },
    });
    expect(command.payload).not.toHaveProperty("plan");
  });
});
