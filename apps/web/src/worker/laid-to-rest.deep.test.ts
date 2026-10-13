/**
 * §grief, §the-body-aboard and §laid-to-rest on real content and the full registry: the ship takes
 * a freight job and sails; as it leaves port the narrator's `strike` kills Tomas Ruiz aboard. The living
 * crew grieve him, a crewmate carries his body to the cargo hold, and at the next port he is
 * carried ashore and is no longer aboard. Hooks are acknowledged and cards answered by their left
 * side as they come.
 */
import type { Command, CommandId, ItemDefId, NarratorHook, PortDefId, SimEvent } from "@crew/sim";
import { createKernel } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { loadWebContent } from "./content";
import { createFullRegistry } from "./registry";
import { assertInvariants } from "./testGame";

const CRATE = "item.crate_general" as ItemDefId;
/** Generous: loading, the leg, and docking at the far end. */
const MAX_SECONDS = 20 * 60;
const YIELD_TICKS = 500;

describe("a death aboard (real content)", { timeout: 300_000 }, () => {
  it("is grieved, laid out in the hold, and carried ashore at the next port", async () => {
    const { bundle, config, scenarioId } = loadWebContent();
    const kernel = createKernel(createFullRegistry());
    const world = kernel.createWorld(scenarioId, 20261013, bundle, config);
    const tickRate = world.config.values.time.tickRate;
    let n = 0;
    const send = (command: Omit<Command, "id">) => {
      n += 1;
      const result = kernel.enqueueCommand(world, {
        ...command,
        id: `cmd:rest:${n}` as CommandId,
      } as Command);
      if (result.status !== "accepted") {
        throw new Error(`${command.kind} rejected: ${JSON.stringify(result)}`);
      }
    };
    const tomas = Object.values(world.state.actors).find((a) => a.name === "Tomas Ruiz");
    if (tomas === undefined) throw new Error("no Tomas Ruiz aboard");

    let offered = false;
    /** The first `captainAshore` gets one freight job to the port's farthest neighbour. */
    const answer = (hook: NarratorHook) => {
      if (hook.kind !== "captainAshore" || offered) return;
      const portId = hook.context.portId as PortDefId;
      const route = [...(world.content.ports[portId]?.routes ?? [])].sort(
        (a, b) => b.distance - a.distance,
      )[0];
      if (route === undefined) throw new Error(`${portId} has no routes`);
      const band = world.config.values.commerce.priceBands.general;
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
            cargo: [{ itemDefId: CRATE, count: 2 }],
            pay: Math.ceil(band.min * route.distance * 2),
          },
          surface: true,
        },
      });
    };

    const events: SimEvent[] = [];
    let struck = false;
    while (world.state.tick < MAX_SECONDS * tickRate) {
      if (events.some((e) => e.type === "laidToRest")) break;
      // As the ship clears the port, a grave shot to the head: the narrator has decided he dies.
      if (!struck && world.state.travel.stage === "departing") {
        struck = true;
        send({
          source: "narrator",
          kind: "strike",
          payload: {
            actorId: tomas.id,
            severity: "grave",
            type: "blaster",
            part: "head",
            how: "a coolant line bursts in Tomas Ruiz's face",
          },
        });
      }
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

    expect(struck).toBe(true);
    const died = events.find((e) => e.type === "died");
    expect(died?.type === "died" && died.payload.actorId).toBe(tomas.id);
    // Every living member of the ship's company grieves him.
    const company = Object.values(world.state.actors).filter(
      (a) => a.crew && a.passenger !== true && a.id !== tomas.id && a.availability !== "dead",
    );
    expect(company.length).toBeGreaterThan(0);
    for (const mourner of company) {
      expect(mourner.thoughts.some((t) => t.key === "grieving" && t.refId === tomas.id)).toBe(true);
    }
    // A crewmate laid him out in the cargo hold on the leg.
    const laid = events.find((e) => e.type === "bodyLaidOut");
    if (laid?.type !== "bodyLaidOut") throw new Error("nobody laid the body out");
    expect(laid.payload.actorId).toBe(tomas.id);
    const hold = world.state.compartments[laid.payload.compartmentId];
    expect(hold?.key).toBe("cargoHold");
    // At the next port he was carried ashore and is off the ship.
    const rested = events.find((e) => e.type === "laidToRest");
    if (rested?.type !== "laidToRest") throw new Error("never laid to rest");
    expect(rested.payload.actorId).toBe(tomas.id);
    const travel = world.state.travel;
    expect(travel.stage === "docked" && travel.portId).toBe(rested.payload.portId);
    const body = world.state.actors[tomas.id];
    expect(body?.availability).toBe("dead");
    expect(body?.location).toMatchObject({
      kind: "inExternalStore",
      portId: rested.payload.portId,
    });
    const deadAboard = Object.values(world.state.actors).filter(
      (a) => a.availability === "dead" && a.location.kind !== "inExternalStore",
    );
    expect(deadAboard).toEqual([]);
    expect(
      Object.values(world.state.work.problems).filter(
        (p) => p.kind === "bodyAboard" && p.status === "open",
      ),
    ).toEqual([]);
  });
});
