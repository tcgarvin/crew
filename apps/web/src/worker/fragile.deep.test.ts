/**
 * §fragile-cargo on real content: the ship takes a fragile job, the crew load it, and on the leg a
 * field's scripted rocks land on the crates' own tile with `field.fragileBreakChance` at 1. The
 * crates are smashed, still delivered, and the delivery pays less than the contract.
 */
import type { Command, CommandId, ItemDefId, NarratorHook, PortDefId, SimEvent } from "@crew/sim";
import { createKernel } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { loadWebContent } from "./content";
import { createFullRegistry } from "./registry";
import { assertInvariants } from "./testGame";

const FRAGILE_CRATE = "item.crate_fragile" as ItemDefId;
const CRATES = 6;
/** Generous: loading, the leg with its field, and unloading at the far end. */
const MAX_SECONDS = 20 * 60;
const YIELD_TICKS = 500;

describe("fragile cargo through a field (real content)", { timeout: 300_000 }, () => {
  it("smashes crates in the hold and docks the pay at delivery", async () => {
    const { bundle, config, scenarioId } = loadWebContent();
    const smashing = {
      ...config,
      values: {
        ...config.values,
        field: { ...config.values.field, fragileBreakChance: { small: 1, large: 1 } },
      },
    };
    const kernel = createKernel(createFullRegistry());
    const world = kernel.createWorld(scenarioId, 20261013, bundle, smashing);
    const tickRate = world.config.values.time.tickRate;
    let n = 0;
    const send = (command: Omit<Command, "id">) => {
      n += 1;
      const result = kernel.enqueueCommand(world, {
        ...command,
        id: `cmd:fragile:${n}` as CommandId,
      } as Command);
      if (result.status !== "accepted") {
        throw new Error(`${command.kind} rejected: ${JSON.stringify(result)}`);
      }
    };

    let offered = false;
    /** The first `captainAshore` gets one fragile job to the port's first neighbour. */
    const answer = (hook: NarratorHook) => {
      if (hook.kind !== "captainAshore" || offered) return;
      const portId = hook.context.portId as PortDefId;
      const route = world.content.ports[portId]?.routes[0];
      if (route === undefined) throw new Error(`${portId} has no routes`);
      const band = world.config.values.commerce.priceBands.fragile;
      offered = true;
      send({
        source: "narrator",
        kind: "offerJob",
        payload: {
          job: {
            issuer: { name: "Stand-in Narrator", role: "dispatcher" },
            description: { key: "test.job", params: {} },
            fromPortId: portId,
            toPortId: route.toPortId,
            cargo: [{ itemDefId: FRAGILE_CRATE, count: CRATES }],
            pay: Math.ceil(band.min * route.distance * CRATES),
          },
          surface: true,
        },
      });
    };

    const events: SimEvent[] = [];
    let fieldScheduled = false;
    while (world.state.tick < MAX_SECONDS * tickRate) {
      const job = Object.values(world.state.jobs)[0];
      if (job?.status === "paid") break;
      // As the leg begins, three rocks aimed at the tile the first crate lies on.
      if (!fieldScheduled && job !== undefined && world.state.travel.stage === "transit") {
        const crate = world.state.items[job.cargoItemIds[0] ?? ("" as never)];
        const at = crate?.location;
        if (at?.kind !== "onDeck") throw new Error(`crate not on deck: ${JSON.stringify(at)}`);
        const target = { kind: "tile", x: Math.floor(at.x), y: Math.floor(at.y) } as const;
        fieldScheduled = true;
        send({
          source: "scenario",
          kind: "scheduleField",
          payload: {
            severity: "light",
            detection: "rolled",
            windowTicks: [0, 0],
            scripted: [0, 5, 10].map((atSeconds) => ({ atSeconds, target, rock: "small" })),
          },
        });
      }
      // Let vitest's worker RPC breathe on a long synchronous run (see apps/cli `yielding.ts`).
      if (world.state.tick % YIELD_TICKS === 0) await new Promise((r) => setTimeout(r, 0));
      const result = kernel.advance(world, 1);
      events.push(...result.events);
      assertInvariants(world);
      if (result.halt.kind === "lost") throw new Error("ship lost");
      if (result.halt.kind === "hook") {
        const hook = world.state.narrator.pendingHook;
        if (hook === undefined) throw new Error("hook halt without a pending hook");
        answer(hook);
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
    }

    const job = Object.values(world.state.jobs)[0];
    if (job === undefined) throw new Error("no job was offered");
    expect(fieldScheduled).toBe(true);
    expect(job.status).toBe("paid");
    const smashed = events.filter((e) => e.type === "cargoBroken");
    expect(smashed.length).toBeGreaterThanOrEqual(1);
    const brokenCount = job.cargoItemIds.filter((id) => world.state.items[id]?.broken).length;
    expect(brokenCount).toBe(smashed.length);
    const completed = events.find((e) => e.type === "contractCompleted");
    expect(completed?.payload).toEqual({ jobId: job.id, brokenCount });
    const paid = events.find((e) => e.type === "paymentMade");
    if (paid?.type !== "paymentMade") throw new Error("no payment");
    expect(paid.payload.amount).toBeLessThan(job.pay);
    const whole = (CRATES - brokenCount) / CRATES;
    const share = Math.max(whole, world.config.values.commerce.brokenFloorShare);
    expect(paid.payload.amount).toBe(Math.round(job.pay * share));
  });
});
