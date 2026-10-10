/**
 * Expeditions A1 gate: on the real content and the full registry, the default game takes
 * `scenarioStartExpedition` at tick 0 (as `crew expeditions` will) and sets down at the Boathouse
 * with its default cast, and runs clean. The muster and the fight are the workstreams'; here the
 * party waits at the ship.
 */
import {
  type CommandId,
  type PortDefId,
  bodyViolations,
  checkInvariants,
  createKernel,
  expeditionViolations,
  lockerWeapons,
  siteOf,
  travelViolations,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import { createPacingRegistry, loadPacingContent } from "./pacing";

const BOATHOUSE = "port.boathouse" as PortDefId;

describe("the expedition's start on real content (expeditions A1, call 3)", () => {
  it("sets the ship down at the Boathouse at tick 0 with the cast at their posts, and runs clean", () => {
    const { bundle, config, scenarioId } = loadPacingContent();
    const kernel = createKernel(createPacingRegistry());
    const world = kernel.createWorld(scenarioId, 1, bundle, config);
    expect(lockerWeapons(world.state, bundle).map((w) => w.kind)).toEqual([
      "blaster",
      "blaster",
      "blaster",
      "baton",
      "baton",
    ]);
    const result = kernel.enqueueCommand(world, {
      id: "cmd:test:expedition" as CommandId,
      source: "scenario",
      kind: "scenarioStartExpedition",
      payload: { siteId: BOATHOUSE, plan: "assault-lethal-armed" },
    });
    expect(result.status).toBe("accepted");
    kernel.advance(world, 1);
    expect(world.state.travel).toEqual({ stage: "docked", portId: BOATHOUSE });
    expect(siteOf(bundle, world.state)?.dock.id).toBe("dock.boathouse");
    const cast = Object.values(world.state.actors).filter((a) => a.combatant !== undefined);
    expect(cast.map((a) => a.name)).toEqual([
      "Corran Vale",
      "Hesk Marrow",
      "Darrow Finch",
      "Old Pell",
    ]);
    expect(world.state.expedition?.party.length).toBeGreaterThan(0);
    const captain = Object.values(world.state.actors).find((a) => a.roleTags.includes("captain"));
    expect(world.state.expedition?.leaderId).toBe(captain?.id);
    for (let i = 0; i < 6; i++) {
      kernel.advance(world, 100);
      expect(world.state.narrator.pendingHook?.kind).not.toBe("captainAshore");
      expect([
        ...checkInvariants(world.state),
        ...travelViolations(world),
        ...bodyViolations(world),
        ...expeditionViolations(world),
      ]).toEqual([]);
    }
  });
});
