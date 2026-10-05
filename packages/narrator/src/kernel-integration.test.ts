/**
 * A narrow end-to-end check that narrator commands with their own handlers really do round
 * trip: `translateIntents` builds them from a plan, and the real kernel (with commerce
 * registered, D6's owner for `spawnAtBoundary`) accepts them, not just a mocked snapshot.
 */
import {
  type PortDefId,
  createKernel,
  createRegistry,
  registerCommerce,
  registerTravel,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import type { NarratorPlan, TranslationCtx } from "./contract";
import { FIXTURE_SCENARIO } from "./fixtures";
import { content, emptyPlan } from "./test-support";
import { translateIntents } from "./translate";

describe("translateIntents -> kernel.enqueueCommand (real world)", () => {
  it("accepts a translated stockMarket and applies it to the port's market (D47)", () => {
    const bundle = content();
    const registry = createRegistry();
    registerCommerce(registry);
    const kernel = createKernel(registry);
    const world = kernel.createWorld(FIXTURE_SCENARIO, 7, bundle, {
      values: bundle.config,
      hash: bundle.hash,
    });
    const ctx: TranslationCtx = {
      snapshot: kernel.serialize(world),
      content: bundle,
      hookTick: world.state.tick,
      callId: "call-stock",
    };
    const { commands, dropped } = translateIntents(
      emptyPlan({
        intents: [
          {
            kind: "stockMarket",
            port: "port.green_meridian",
            cargoItem: "item.spare_parts_stack",
            count: "2",
            priceTier: "fair",
          },
        ] as unknown as NarratorPlan["intents"],
      }),
      ctx,
    );
    expect(dropped).toEqual([]);
    const [command] = commands;
    if (command === undefined) throw new Error("no command");
    expect(kernel.enqueueCommand(world, command).status).toBe("accepted");
    kernel.advance(world, 2);
    expect(world.state.markets["port.green_meridian" as never]).toMatchObject({
      "item.spare_parts_stack": { count: 2, price: 150 },
    });
    // Stocking a market never touches the ship's money or stores.
    expect(world.state.money.balance).toBe(bundle.scenarios[FIXTURE_SCENARIO]?.startingMoney);
  });

  it("accepts a translated round-trip passage: the translator's fare is inside the kernel's passenger band (§3.4)", () => {
    const bundle = content();
    const registry = createRegistry();
    registerCommerce(registry);
    const kernel = createKernel(registry);
    const world = kernel.createWorld(FIXTURE_SCENARIO, 7, bundle, {
      values: bundle.config,
      hash: bundle.hash,
    });
    const travel = world.state.travel;
    if (travel.stage !== "docked") throw new Error("expected a new world to start docked");
    const ctx: TranslationCtx = {
      snapshot: kernel.serialize(world),
      content: bundle,
      hookTick: world.state.tick,
      callId: "call-passage",
    };
    const { commands, dropped } = translateIntents(
      emptyPlan({
        intents: [
          {
            kind: "offerJob",
            issuerName: "Halla Thorne",
            issuerRole: "assayer",
            issuerOrg: "",
            pitch: "I need to get to Ossory and back.",
            description: "Passage to Ossory Station and home again.",
            fromPort: travel.portId,
            toPort: "port.ossory_station",
            cargoItem: "item.crate_fragile",
            quantity: "few",
            payTier: "generous",
            urgency: "soon",
            surface: false,
            passenger: true,
            roundTrip: true,
          },
        ] as unknown as NarratorPlan["intents"],
      }),
      ctx,
    );
    expect(dropped).toEqual([]);
    const [command] = commands;
    if (command?.kind !== "offerJob") throw new Error("no offer");
    expect(kernel.enqueueCommand(world, command).status).toBe("accepted");
    kernel.advance(world, 2);
    const job = Object.values(world.state.jobs)[0];
    expect(job).toMatchObject({
      passage: { actorId: "", roundTrip: true, leg: "out" },
      cargo: [{ itemDefId: "item.crate_fragile", count: 1 }],
      pay: command.payload.job.pay,
    });
  });

  it("accepts a translated spawnAtBoundary and surfaceDecision", () => {
    const bundle = content();
    const registry = createRegistry();
    registerCommerce(registry);
    const kernel = createKernel(registry);
    const world = kernel.createWorld(FIXTURE_SCENARIO, 7, bundle, {
      values: bundle.config,
      hash: bundle.hash,
    });

    const ctx: TranslationCtx = {
      snapshot: kernel.serialize(world),
      content: bundle,
      hookTick: world.state.tick,
      callId: "call-real-world",
    };

    const plan: NarratorPlan = emptyPlan({
      intents: [
        {
          kind: "spawnAtBoundary",
          port: "port.kessler_drift",
          store: "warehouse",
          cargoItem: "item.crate_general",
          quantity: "few",
        },
        {
          kind: "surfaceDecision",
          title: "A quiet moment",
          speaker: "",
          situation: "Nothing much is happening, but someone should decide something.",
          left: { label: "Carry on", effect: "none", coursePort: "", talkWith: "", tone: "" },
          right: { label: "Take a break", effect: "none", coursePort: "", talkWith: "", tone: "" },
          leftAftermath: "Everyone goes back to what they were doing.",
          rightAftermath: "The crew down tools for a cup of something hot.",
          beatOfThread: "",
          closesThread: "",
        },
      ] as unknown as NarratorPlan["intents"],
    });

    const { commands, dropped } = translateIntents(plan, ctx);
    expect(dropped).toEqual([]);
    expect(commands.map((c) => c.kind)).toEqual(["spawnAtBoundary", "surfaceDecision"]);

    for (const command of commands) {
      const result = kernel.enqueueCommand(world, command);
      expect(result.status).toBe("accepted");
    }
  });

  it("accepts a translated scheduleHazard once a course is set, and spends the hazard budget (D78)", () => {
    const bundle = content();
    const registry = createRegistry();
    registerTravel(registry);
    const kernel = createKernel(registry);
    const world = kernel.createWorld(FIXTURE_SCENARIO, 7, bundle, {
      values: bundle.config,
      hash: bundle.hash,
    });
    const travel = world.state.travel;
    if (travel.stage !== "docked") throw new Error("expected a new world to start docked");
    world.state.travel = { ...travel, plannedDestinationId: "port.kessler_drift" as PortDefId };
    const budget = world.state.narrator.budget.hazardsRemaining;
    const ctx: TranslationCtx = {
      snapshot: kernel.serialize(world),
      content: bundle,
      hookTick: world.state.tick,
      callId: "call-hazard",
    };
    const { commands, dropped } = translateIntents(
      emptyPlan({
        intents: [
          { kind: "scheduleHazard", hazard: "ionStorm", difficulty: "brutal", window: "later" },
        ] as unknown as NarratorPlan["intents"],
      }),
      ctx,
    );
    expect(dropped).toEqual([]);
    const [command] = commands;
    if (command === undefined) throw new Error("no command");
    expect(kernel.enqueueCommand(world, command).status).toBe("accepted");
    kernel.advance(world, 2);
    expect(world.state.hazards).toMatchObject([
      { kind: "ionStorm", difficulty: bundle.config.hazards.difficulty.brutal },
    ]);
    expect(world.state.narrator.budget.hazardsRemaining).toBe(budget - 1);
  });
});
