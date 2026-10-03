/**
 * D61 kernel integration on the real authored bundle and every V1 system: a new game starts with
 * the Hub's dock alongside, and a schema-3 save made docked mid-loading (freight still in the
 * warehouse store) restores with its dock, finishes loading through the transfer tiles, leaves
 * with the dock cast off, and arrives with the next port's dock alongside. The travel invariant
 * holds every tick.
 *
 * It lives here, not in `packages/sim`, for the same reason `fullSim.test.ts` does: the kernel
 * package may not depend on `@crew/content`.
 */
import type {
  Command,
  CommandId,
  Kernel,
  NarratorHook,
  PortDefId,
  SaveEnvelope,
  SimEvent,
  World,
} from "@crew/sim";
import {
  checkInvariants,
  createKernel,
  getRenderFrame,
  spatialViolations,
  travelViolations,
  workViolations,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import { loadWebContent } from "./content";
import { createFullRegistry } from "./registry";

const HUB = "port.crossroads_hub" as PortDefId;
const HUB_DOCK = "dock.crossroads_hub";

/** The stand-in narrator of `fullSim.test.ts`: one surfaced freight offer per `jobBoard`. */
function answerHook(world: World, hook: NarratorHook): Omit<Command, "id"> | undefined {
  if (hook.kind !== "jobBoard") return undefined;
  const portId = hook.context.portId as PortDefId;
  const port = world.content.ports[portId];
  if (port === undefined) return undefined;
  for (const template of port.jobTemplates) {
    const line = template.cargo[0];
    const distance = port.routes.find((r) => r.toPortId === template.toPortId)?.distance;
    const cargoClass =
      line === undefined ? undefined : world.content.items[line.itemDefId]?.cargoClass;
    if (line === undefined || distance === undefined || cargoClass === undefined) continue;
    const band = world.config.values.commerce.priceBands[cargoClass];
    return {
      source: "narrator",
      kind: "offerJob",
      payload: {
        job: {
          issuer: { name: "Stand-in Narrator", role: "dispatcher" },
          description: { key: "test.job", params: {} },
          fromPortId: portId,
          toPortId: template.toPortId,
          cargo: [{ itemDefId: line.itemDefId, count: 2 }],
          pay: Math.ceil(band.min * distance * 2),
        },
        surface: true,
      },
    };
  }
  return undefined;
}

let n = 0;

/** Advance tick by tick, answering hooks and accepting every card, checking every invariant. */
function drive(
  kernel: Kernel,
  world: World,
  ticks: number,
  until: (world: World) => boolean,
): SimEvent[] {
  const events: SimEvent[] = [];
  const send = (command: Omit<Command, "id">) => {
    n += 1;
    const result = kernel.enqueueCommand(world, {
      ...command,
      id: `cmd:dockside:${n}` as CommandId,
    } as Command);
    if (result.status !== "accepted") throw new Error(`${command.kind}: ${JSON.stringify(result)}`);
  };
  for (let i = 0; i < ticks; i++) {
    const result = kernel.advance(world, 1);
    events.push(...result.events);
    const violations = [
      ...checkInvariants(world.state),
      ...spatialViolations(world),
      ...workViolations(world),
      ...travelViolations(world),
    ];
    if (violations.length > 0) {
      throw new Error(`tick ${world.state.tick}: ${violations.slice(0, 5).join("; ")}`);
    }
    if (result.halt.kind === "hook") {
      const hook = world.state.narrator.pendingHook;
      if (hook === undefined) throw new Error("hook halt without a pending hook");
      const answer = answerHook(world, hook);
      if (answer !== undefined) send(answer);
      send({ source: "system", kind: "acknowledgeHook", payload: { hookId: hook.id } });
    } else if (result.halt.kind === "decision") {
      const head = world.state.decisions.queue[0];
      if (head === undefined) throw new Error("decision halt without a queued decision");
      send({
        source: "player",
        kind: "resolveDecision",
        payload: { decisionId: head, side: "left" },
      });
    }
    if (until(world)) break;
  }
  return events;
}

/** The envelope as schema 3 wrote it: no `deck.dock`, the ramps shut as they used to shut. */
function asSchema3(envelope: SaveEnvelope): SaveEnvelope {
  const state = structuredClone(envelope.state);
  // biome-ignore lint/performance/noDelete: a schema-3 save has no such key.
  delete state.deck.dock;
  for (const door of Object.values(state.doors)) {
    if (door.kind !== "ramp") continue;
    door.physicalState = "closed";
    door.requestedState = "closed";
  }
  state.schemaVersion = 3;
  return { ...envelope, schemaVersion: 3, state };
}

const loadingOpen = (world: World) =>
  Object.values(world.state.work.problems).some(
    (p) => p.kind === "cargoToLoad" && p.status === "open",
  );

describe("the dock alongside on real content (D61)", { timeout: 20_000 }, () => {
  it("starts a new game with the Hub's dock alongside and its ramps down", () => {
    const { bundle, config, scenarioId } = loadWebContent();
    const kernel = createKernel(createFullRegistry());
    const world = kernel.createWorld(scenarioId, 20261003, bundle, config);
    expect(world.state.travel).toMatchObject({ stage: "docked", portId: HUB });
    const frame = getRenderFrame(world);
    expect(frame.dock?.dockId).toBe(HUB_DOCK);
    expect(frame.actors.every((a) => !a.onDock)).toBe(true);
    const ramps = Object.values(world.state.doors).filter((d) => d.kind === "ramp");
    expect(ramps.map((d) => d.physicalState)).toEqual(["open", "open"]);
    expect(travelViolations(world)).toEqual([]);
  });

  it("restores a schema-3 save docked mid-loading, loads, casts off and docks at the next port", () => {
    const { bundle, config, scenarioId } = loadWebContent();
    const kernel = createKernel(createFullRegistry());
    const world = kernel.createWorld(scenarioId, 20260930, bundle, config);
    drive(kernel, world, 20 * 120, loadingOpen);
    expect(loadingOpen(world)).toBe(true);
    const inStore = Object.values(world.state.items).filter(
      (i) => i.jobId !== undefined && i.location.kind === "inExternalStore",
    );
    expect(inStore.length).toBeGreaterThan(0);

    const restored = kernel.restore(asSchema3(kernel.serialize(world)), bundle);
    expect(restored.state.deck.dock?.dockId).toBe(HUB_DOCK);
    // Nothing moved: the freight is still in the warehouse store.
    for (const item of inStore) {
      expect(restored.state.items[item.id]?.location).toEqual(item.location);
    }
    const events = drive(
      kernel,
      restored,
      20 * 300,
      (w) => w.state.travel.stage === "docked" && w.state.travel.portId !== HUB,
    );
    expect(loadingOpen(restored)).toBe(false);
    const stages = events
      .filter((e): e is Extract<SimEvent, { type: "travelStageChanged" }> => {
        return e.type === "travelStageChanged";
      })
      .map((e) => e.payload.to);
    expect(stages).toContain("departing");
    const travel = restored.state.travel;
    expect(travel.stage).toBe("docked");
    const here = travel.stage === "docked" ? travel.portId : undefined;
    const due = Object.values(bundle.docks ?? {}).find((d) => d.portId === here);
    expect(restored.state.deck.dock?.dockId).toBe(due?.id);
  });
});
