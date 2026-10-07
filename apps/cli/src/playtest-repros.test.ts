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
import { createKernel, effectiveMarket, watchTicks } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { createPacingRegistry, freightDraft, loadPacingContent } from "./pacing";

const SPARES = "item.spare_parts_stack" as ItemDefId;
const KESSLER = "port.kessler_drift" as PortDefId;
const KIT = "item.patch_kit" as ItemDefId;

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
  }, 60_000);

  it("a docked hold ends when the generator's part is not to be had, though it starves the engine", () => {
    const { kernel, world } = freshWorld();
    noSparesAnywhere(world);
    const generator = machineTagged(world, "generator");
    // The battery is flat, so a derated generator starves the engine (output 1/6, no fault).
    for (const machine of Object.values(world.state.machines)) {
      if (machine.roleState.role === "battery") machine.roleState.storedKj = 0;
    }
    send(kernel, world, {
      source: "scenario",
      kind: "scenarioInjectFault",
      payload: { machineId: generator, faultKey: "coil_burnout" },
    });
    send(kernel, world, {
      source: "player",
      kind: "setCourse",
      payload: { destinationPortId: KESSLER },
    });
    const events = drive(kernel, world, 600, (w) => w.state.travel.stage !== "docked");
    expect(world.state.travel.stage).not.toBe("docked");
    const engine = world.state.machines[machineTagged(world, "engine")];
    expect(engine?.faults).toEqual([]);
    expect(engine?.output ?? 1).toBeLessThan(world.config.values.travel.departureMinOutput);
    const told = events.filter((e) => e.type === "departureRepairOutOfReach");
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      payload: { machineId: generator, faultKey: "coil_burnout", itemDefId: SPARES },
    });
  }, 60_000);
});

describe("slice-2 QA repros (D77 addendum)", () => {
  it("a port call in the Blue watch loads its cargo within the watch: cargo is all hands awake", () => {
    const { kernel, world } = freshWorld();
    const watch = watchTicks(world.config.values);
    // Docked at the hub as the Blue watch begins: the first officer and the deckhand on the
    // bill, Red and White and the dayworkers off duty.
    world.state.tick = 2 * watch;
    send(kernel, world, freightDraft(world));
    const offered = drive(kernel, world, 30, (_w, events) =>
      events.some((e) => e.type === "jobOffered"),
    );
    const offer = offered.find((e) => e.type === "jobOffered");
    if (offer?.type !== "jobOffered") throw new Error("no job offered");
    send(kernel, world, {
      source: "scenario",
      kind: "acceptContract",
      payload: { jobId: offer.payload.jobId },
    });
    const accepted = world.state.tick;
    drive(kernel, world, 1, () => false);
    const crates = world.state.jobs[offer.payload.jobId]?.cargoItemIds.length ?? 0;
    expect(crates).toBeGreaterThan(0);
    const events = drive(
      kernel,
      world,
      300,
      (_w, all) =>
        all.filter((e) => e.type === "taskCompleted" && e.payload.haul?.to === "ship").length >=
        crates,
    );
    const firstAboard = events.find(
      (e) => e.type === "taskCompleted" && e.payload.haul?.to === "ship",
    );
    expect(firstAboard).toBeDefined();
    expect((firstAboard?.tick ?? Number.POSITIVE_INFINITY) - accepted).toBeLessThan(
      120 * world.config.values.time.tickRate,
    );
    // All aboard before the Red bell, so it was not the Red watch coming on that loaded.
    expect(world.state.tick).toBeLessThan(3 * watch);
  }, 60_000);
});

describe("patch kits restocked at port (D93)", () => {
  it(
    "a ship short of patch kits at a port that sells them buys back to the scenario's 24 (D93)",
    { timeout: 60_000 },
    () => {
      const { kernel, world } = freshWorld();
      const kitsAboard = (w: World): number =>
        Object.values(w.state.items)
          .filter((i) => i.defId === KIT && i.location.kind === "onDeck")
          .reduce((n, i) => n + (i.stacking === "stack" ? i.count : 1), 0);
      expect(kitsAboard(world)).toBe(24);
      // Three lockers' kits spent on scars underway.
      const spent = Object.values(world.state.items)
        .filter((i) => i.defId === KIT)
        .slice(0, 3);
      for (const item of spent) delete world.state.items[item.id];
      expect(kitsAboard(world)).toBe(18);
      const money = world.state.money.balance;
      const travel = world.state.travel;
      if (travel.stage !== "docked") throw new Error("expected a new world to start docked");
      const price = effectiveMarket(world.state, world.content, travel.portId)[KIT]?.price ?? 0;
      expect(price).toBeGreaterThan(0);
      const events = drive(kernel, world, 300, (w) => kitsAboard(w) >= 24);
      expect(kitsAboard(world)).toBe(24);
      const bought = events.filter((e) => e.type === "partsBought" && e.payload.itemDefId === KIT);
      expect(bought.length).toBeGreaterThan(0);
      expect(world.state.money.balance).toBeLessThanOrEqual(money - 6 * price);
    },
  );
});
