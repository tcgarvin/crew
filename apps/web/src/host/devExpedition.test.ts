import { createKernel } from "@crew/sim";
/** Expeditions A1: the dev-only `?expedition=` start. */
import { describe, expect, it } from "vitest";
import { loadWebContent } from "../worker/content";
import { createFullRegistry } from "../worker/registry";
import { devExpeditionCommand, devExpeditionFromSearch, devStartCommand } from "./devExpedition";

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

describe("devStartCommand (expeditions A2: `?errand=`)", () => {
  const { bundle, config, scenarioId } = loadWebContent();

  it("offers an errand to the site on a card, the map's own target, that the kernel takes", () => {
    const command = devStartCommand("?errand=port.harrow_end", bundle, config.values, scenarioId);
    expect(command).toMatchObject({
      source: "scenario",
      kind: "offerJob",
      payload: {
        surface: true,
        job: { errand: { siteId: "port.harrow_end", targetName: "Teodor Lusk", wants: "alive" } },
      },
    });
    if (command === undefined) throw new Error("no command");
    const kernel = createKernel(createFullRegistry());
    const world = kernel.createWorld(scenarioId, 1, bundle, config);
    expect(kernel.enqueueCommand(world, command).status).toBe("accepted");
  });

  it("prefers `?expedition=`, and asks for nothing with neither", () => {
    expect(
      devStartCommand(
        "?expedition=port.boathouse&errand=port.harrow_end",
        bundle,
        config.values,
        scenarioId,
      )?.kind,
    ).toBe("scenarioStartExpedition");
    expect(devStartCommand("", bundle, config.values, scenarioId)).toBeUndefined();
  });
});
