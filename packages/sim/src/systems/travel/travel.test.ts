/**
 * Travel state machine tests (PLAN §6 W6 "Tests"). Only `registerTravel`/`registerCommerce` are
 * registered (no spatial/equipment/power), so ramps start already closed, engines start `on` at
 * full output, and staffing is untested here (no `pilotStation` machine in the fixture).
 */
import { describe, expect, it } from "vitest";
import type { Command } from "../../core/types/commands";
import type { CommandId, HookId } from "../../core/types/ids";
import { FIX, PORTS, advanceThroughHooks, freightTestWorld } from "./fixtures";

let counter = 0;
function cmd<C extends Omit<Command, "id">>(command: C): C & { id: CommandId } {
  counter += 1;
  return { ...command, id: `cmd:travel-test:${counter}` as CommandId };
}

describe("travel state machine", () => {
  it("runs docked -> ... -> docked at the destination with correct stage durations", () => {
    const { world, kernel } = freightTestWorld();
    expect(world.state.travel).toEqual({ stage: "docked", portId: PORTS.a });

    const setCourse = kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "setCourse", payload: { destinationPortId: PORTS.b } }),
    );
    expect(setCourse.status).toBe("accepted");

    const first = kernel.advance(world, 1);
    expect(first.halt).toEqual({ kind: "completed" });
    expect(world.state.travel.stage).toBe("preparingDeparture");

    // prepare(1s) + undock(1s) + depart(1s) = 60 ticks before transit begins.
    kernel.advance(world, 60 - 1);
    expect(world.state.travel).toMatchObject({
      stage: "transit",
      fromPortId: PORTS.a,
      toPortId: PORTS.b,
    });

    // transit: distance 25 / nominalSpeed 5 = 5s = 100 ticks, then approach raises the hook.
    const untilHook = kernel.advance(world, 1000);
    expect(untilHook.halt).toEqual({ kind: "hook" });
    expect(world.state.narrator.pendingHook?.kind).toBe("approachingPort");
    expect(world.state.travel.stage).toBe("approaching");

    const hookId = world.state.narrator.pendingHook?.id as HookId;
    kernel.enqueueCommand(
      world,
      cmd({ source: "system", kind: "acknowledgeHook", payload: { hookId } }),
    );
    // Arrival at B (no job templates there) also raises `jobBoard`; acknowledge that too.
    const after = advanceThroughHooks(kernel, world, 1000);
    expect(after.halt).toEqual({ kind: "completed" });
    expect(world.state.travel).toEqual({ stage: "docked", portId: PORTS.b });
  });

  it("rejects setCourse while not docked", () => {
    const { world, kernel } = freightTestWorld();
    kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "setCourse", payload: { destinationPortId: PORTS.b } }),
    );
    kernel.advance(world, 1);
    expect(world.state.travel.stage).toBe("preparingDeparture");

    const result = kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "setCourse", payload: { destinationPortId: PORTS.c } }),
    );
    expect(result).toMatchObject({ status: "rejected", rejection: { code: "preconditionFailed" } });
  });

  it("rejects setCourse to the current port or an unknown port", () => {
    const { world, kernel } = freightTestWorld();
    expect(
      kernel.enqueueCommand(
        world,
        cmd({ source: "player", kind: "setCourse", payload: { destinationPortId: PORTS.a } }),
      ),
    ).toMatchObject({ status: "rejected" });
    expect(
      kernel.enqueueCommand(
        world,
        cmd({
          source: "player",
          kind: "setCourse",
          payload: { destinationPortId: "port.nope" as never },
        }),
      ),
    ).toMatchObject({ status: "rejected", rejection: { code: "unknownEntity" } });
  });

  it("stalls transit while the engine is off, then resumes from the same progress", () => {
    const { world, kernel } = freightTestWorld();
    kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "setCourse", payload: { destinationPortId: PORTS.b } }),
    );
    kernel.advance(world, 60); // through prepare/undock/depart into transit
    expect(world.state.travel.stage).toBe("transit");

    kernel.advance(world, 20); // 1s of nominal transit: routeProgress should have grown
    const progress = (world.state.travel as { routeProgress: number }).routeProgress;
    expect(progress).toBeGreaterThan(0);

    const engine = Object.values(world.state.machines).find((m) => m.defId === FIX.engine);
    if (engine === undefined) throw new Error("engine missing");
    engine.actualMode = "off";
    kernel.advance(world, 40);
    expect((world.state.travel as { routeProgress: number }).routeProgress).toBe(progress);
    expect((world.state.travel as { drifting: boolean }).drifting).toBe(true);

    engine.actualMode = "on";
    kernel.advance(world, 20);
    const resumed = (world.state.travel as { routeProgress: number }).routeProgress;
    expect(resumed).toBeGreaterThan(progress);
    expect((world.state.travel as { drifting: boolean }).drifting).toBe(false);
  });

  it("survives save/restore mid-transit with identical progress", () => {
    const { world, kernel } = freightTestWorld();
    kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "setCourse", payload: { destinationPortId: PORTS.b } }),
    );
    kernel.advance(world, 90);
    expect(world.state.travel.stage).toBe("transit");
    const before = JSON.parse(JSON.stringify(world.state.travel));

    const saved = JSON.parse(JSON.stringify(kernel.serialize(world)));
    const restored = kernel.restore(saved, world.content);
    expect(restored.state.travel).toEqual(before);

    kernel.advance(world, 10);
    kernel.advance(restored, 10);
    expect(restored.state.travel).toEqual(world.state.travel);
  });
});
