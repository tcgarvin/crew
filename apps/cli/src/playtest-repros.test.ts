/**
 * D80: the playtest's dead ends, reproduced on the real content and the full system stack (the
 * pacing registry), so each stays fixed as the rules move. Cards are answered "left" (hold for
 * repairs) and hooks acknowledged, as `crew beats` does.
 */
import type {
  Command,
  CommandId,
  ItemDefId,
  Kernel,
  MachineId,
  PortDefId,
  SimEvent,
  World,
} from "@crew/sim";
import { createKernel, effectiveMarket } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { createPacingRegistry, loadPacingContent } from "./pacing";

const SPARES = "item.spare_parts_stack" as ItemDefId;
const KESSLER = "port.kessler_drift" as PortDefId;

let counter = 0;
function send(kernel: Kernel, world: World, command: Omit<Command, "id">): void {
  counter += 1;
  const result = kernel.enqueueCommand(world, {
    ...command,
    id: `cmd:repro:${counter}` as CommandId,
  } as Command);
  if (result.status !== "accepted") throw new Error(JSON.stringify(result));
}

function freshWorld(): { kernel: Kernel; world: World } {
  const { bundle, config, scenarioId } = loadPacingContent();
  const kernel = createKernel(createPacingRegistry());
  const world = kernel.createWorld(scenarioId, 1, bundle, config);
  return { kernel, world };
}

/** No spare parts aboard, and none for sale at any port. */
function noSparesAnywhere(world: World): void {
  for (const item of Object.values(world.state.items)) {
    if (item.defId === SPARES) delete world.state.items[item.id];
  }
  for (const portId of Object.keys(world.content.ports) as PortDefId[]) {
    const market = { ...effectiveMarket(world.state, world.content, portId) };
    market[SPARES] = { count: 0, price: 100 };
    world.state.markets[portId] = market;
  }
}

function machineTagged(world: World, tag: string): MachineId {
  const machine = Object.values(world.state.machines).find((m) =>
    world.content.machines[m.defId]?.tags.includes(tag as never),
  );
  if (machine === undefined) throw new Error(`no ${tag} aboard`);
  return machine.id;
}

/** Advance in 10-tick steps, acknowledging hooks and answering cards "left", until `until`. */
function drive(
  kernel: Kernel,
  world: World,
  seconds: number,
  until: (world: World, events: readonly SimEvent[]) => boolean,
): SimEvent[] {
  const all: SimEvent[] = [];
  const end = world.state.tick + seconds * world.config.values.time.tickRate;
  while (world.state.tick < end) {
    const result = kernel.advance(world, 10);
    all.push(...result.events);
    if (until(world, all)) return all;
    if (result.halt.kind === "hook") {
      const hook = world.state.narrator.pendingHook;
      if (hook !== undefined) {
        send(kernel, world, {
          source: "system",
          kind: "acknowledgeHook",
          payload: { hookId: hook.id },
        });
      }
    } else if (result.halt.kind === "decision") {
      const head = world.state.decisions.queue[0];
      if (head !== undefined) {
        send(kernel, world, {
          source: "player",
          kind: "resolveDecision",
          payload: { decisionId: head, side: "left" },
        });
      }
    }
  }
  return all;
}

describe("playtest repros (D80)", () => {
  it("an engine lost mid-leg with no spare aboard limps on to port instead of drifting for good", () => {
    const { kernel, world } = freshWorld();
    noSparesAnywhere(world);
    send(kernel, world, {
      source: "player",
      kind: "setCourse",
      payload: { destinationPortId: KESSLER },
    });
    drive(kernel, world, 300, (w) => w.state.travel.stage === "transit");
    expect(world.state.travel.stage).toBe("transit");
    send(kernel, world, {
      source: "scenario",
      kind: "scenarioInjectFault",
      payload: { machineId: machineTagged(world, "engine"), faultKey: "failed_controller" },
    });
    const events = drive(kernel, world, 600, (w) => w.state.travel.stage === "docked");
    expect(events.some((e) => e.type === "driftingChanged")).toBe(true);
    expect(events.find((e) => e.type === "shipLimping")).toMatchObject({
      payload: { faultKey: "failed_controller", itemDefId: SPARES, need: "part" },
    });
    expect(world.state.travel).toMatchObject({ stage: "docked", portId: KESSLER });
  });
});
