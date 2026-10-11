/**
 * Expeditions A2 gate, on the real content and the full registry: an errand makes its site
 * routable (plan calls 1 and 2), the leg to the Boathouse is its authored 20 via Tern's Rest, and
 * setting down there costs no fee and raises no staging call (calls 9, §3.3); lifting off leaves
 * what is on the site's floor behind without reaching for a store the site does not have (call 8).
 * Hooks are acknowledged with no commands and cards answered "left", as `crew beats` does.
 */
import {
  type Command,
  type CommandId,
  type ContentBundle,
  type ItemId,
  type JobDraft,
  type Kernel,
  type PortDefId,
  type SimEvent,
  type World,
  checkInvariants,
  createKernel,
  errandPay,
  getRenderFrame,
  rampFoot,
  siteOf,
  travelViolations,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import { HUB_PORT_ID, createPacingRegistry, loadPacingContent } from "./pacing";

const BOATHOUSE = "port.boathouse" as PortDefId;
const TERNS_REST = "port.terns_rest" as PortDefId;

let counter = 0;
function send(kernel: Kernel, world: World, command: Omit<Command, "id">) {
  counter += 1;
  return kernel.enqueueCommand(world, {
    ...command,
    id: `cmd:errand-gate:${counter}` as CommandId,
  } as Command);
}

/** The default game, started docked at `startPortId`. */
function freshWorld(startPortId: PortDefId = HUB_PORT_ID): { kernel: Kernel; world: World } {
  const { bundle, config, scenarioId } = loadPacingContent();
  const scenario = bundle.scenarios[scenarioId];
  if (scenario === undefined) throw new Error("the default scenario is missing");
  const content: ContentBundle = {
    ...bundle,
    scenarios: { ...bundle.scenarios, [scenarioId]: { ...scenario, startPortId } },
  };
  const kernel = createKernel(createPacingRegistry());
  return { kernel, world: kernel.createWorld(scenarioId, 1, content, config) };
}

/** An errand for Corran Vale at the Boathouse, home to `fromPortId`, at the standard tier. */
function errand(world: World, fromPortId: PortDefId, distance: number): JobDraft {
  return {
    issuer: { name: "Ysolde Maren", role: "grower", org: "Meridian Growers" },
    description: { key: "job.template", params: {} },
    fromPortId,
    toPortId: fromPortId,
    cargo: [],
    pay: errandPay(world.config.values, distance, "standard").pay,
    errand: { kind: "fetchPerson", siteId: BOATHOUSE, targetName: "Corran Vale", wants: "alive" },
  };
}

/** Advance in 10-tick steps, acknowledging hooks and answering cards "left", until `until`. */
function drive(
  kernel: Kernel,
  world: World,
  seconds: number,
  until: (world: World) => boolean,
  onStep: (world: World, events: readonly SimEvent[]) => void = () => {},
): void {
  const end = world.state.tick + seconds * world.config.values.time.tickRate;
  while (world.state.tick < end && !until(world)) {
    const result = kernel.advance(world, 10);
    onStep(world, result.events);
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
}

const healthy = (world: World) => [...checkInvariants(world.state), ...travelViolations(world)];

describe("an errand's site on the graph (expeditions A2, calls 1 and 2)", () => {
  it("routes the Hub to the Boathouse via Tern's Rest only once an errand names it", () => {
    const { kernel, world } = freshWorld();
    const course = { destinationPortId: BOATHOUSE };
    const before = send(kernel, world, { source: "player", kind: "setCourse", payload: course });
    expect(before.status === "rejected" ? before.rejection.reason : undefined).toContain(
      "no route",
    );
    const job = errand(world, HUB_PORT_ID, 2 * (400 + 20));
    const offered = send(kernel, world, {
      source: "scenario",
      kind: "offerJob",
      payload: { job, surface: false },
    });
    expect(offered.status).toBe("accepted");
    kernel.advance(world, 1);
    expect(
      send(kernel, world, { source: "player", kind: "setCourse", payload: course }).status,
    ).toBe("accepted");
    kernel.advance(world, 1);
    const travel = world.state.travel;
    const next = travel.stage === "docked" ? travel.plannedDestinationId : travel.toPortId;
    expect(next).toBe(TERNS_REST);
    expect(travel.voyageDestinationId).toBe(BOATHOUSE);
  });
});

describe("setting down at the Boathouse and lifting off (expeditions A2, §3.3, §3.5)", () => {
  it("flies the authored 20 from Tern's Rest, with no fee and no staging call, and lifts off clean", () => {
    const { kernel, world } = freshWorld(TERNS_REST);
    expect(world.state.travel).toMatchObject({ stage: "docked", portId: TERNS_REST });
    const offered = send(kernel, world, {
      source: "scenario",
      kind: "offerJob",
      payload: { job: errand(world, TERNS_REST, 2 * 20), surface: false },
    });
    expect(offered.status).toBe("accepted");
    kernel.advance(world, 1);
    const [jobId] = Object.keys(world.state.jobs) as (keyof World["state"]["jobs"])[];
    if (jobId === undefined) throw new Error("the errand was not offered");
    for (const command of [
      { source: "scenario", kind: "acceptContract", payload: { jobId } },
      { source: "player", kind: "setCourse", payload: { destinationPortId: BOATHOUSE } },
    ] as const) {
      expect(send(kernel, world, command).status).toBe("accepted");
    }

    const fees = () =>
      Object.values(world.state.money.transactions).filter((t) => t.reason === "fee").length;
    const feesBefore = fees();
    const hooks = new Set<string>();
    let leg: number | undefined;
    const landed = (w: World) =>
      w.state.travel.stage === "docked" && w.state.travel.portId === BOATHOUSE;
    drive(kernel, world, 600, landed, (w) => {
      const travel = w.state.travel;
      if (travel.stage === "transit" && travel.toPortId === BOATHOUSE) leg = travel.routeDistance;
      const hook = w.state.narrator.pendingHook;
      if (hook !== undefined) hooks.add(hook.kind);
    });
    expect(landed(world)).toBe(true);
    expect(siteOf(world.content, world.state)?.dock.id).toBe("dock.boathouse");
    expect(leg).toBe(20);
    expect(hooks.has("stageDock")).toBe(false);
    expect(fees()).toBe(feesBefore);
    expect(getRenderFrame(world).headline).toBe("Set down at The Boathouse");
    expect(healthy(world)).toEqual([]);

    // Lift off with something left lying on the site's floor: it goes nowhere, and nothing throws.
    expect(
      send(kernel, world, {
        source: "player",
        kind: "setCourse",
        payload: { destinationPortId: TERNS_REST },
      }).status,
    ).toBe("accepted");
    drive(kernel, world, 300, (w) => w.state.travel.stage === "undocking");
    expect(world.state.travel.stage).toBe("undocking");
    expect(getRenderFrame(world).headline).toBe(
      "Lifting off from The Boathouse — bound for Tern's Rest",
    );
    const foot = rampFoot(world.content, world.state);
    const presence = world.state.deck.dock;
    const dropped = Object.values(world.state.items).find(
      (item) =>
        item.stacking === "unique" && item.jobId === undefined && item.defId === "item.blaster",
    )?.id as ItemId | undefined;
    if (foot === undefined || presence === undefined || dropped === undefined) {
      throw new Error("no site floor or no blaster to leave on it");
    }
    const item = world.state.items[dropped];
    if (item === undefined) throw new Error("the blaster vanished");
    item.location = { kind: "onDeck", deckId: presence.deckId, x: foot.x + 0.5, y: foot.y + 0.5 };
    const leftBehind: SimEvent[] = [];
    drive(
      kernel,
      world,
      60,
      (w) => w.state.travel.stage === "departing",
      (_w, events) => leftBehind.push(...events.filter((e) => e.type === "leftOnDock")),
    );
    expect(world.state.travel.stage).toBe("departing");
    expect(world.state.deck.dock).toBeUndefined();
    expect(world.state.items[dropped]).toBeUndefined();
    expect(leftBehind.map((e) => e.subjectIds[0])).toEqual([dropped]);
    expect(healthy(world)).toEqual([]);
  }, 60_000);
});
