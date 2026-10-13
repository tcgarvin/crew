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
  registerField,
  registerTravel,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import type { NarratorPlan, TranslationCtx } from "./contract";
import { FIXTURE_SCENARIO } from "./fixtures";
import { content, emptyPlan } from "./test-support";
import { translateIntents } from "./translate";

describe("translateIntents -> kernel.enqueueCommand (real world)", () => {
  it("accepts a translated stockMarket and applies it to the port's market (§market-lever)", () => {
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
            payCredits: 0,
            urgency: "soon",
            surface: false,
            passenger: true,
            roundTrip: true,
            errandKind: "",
            site: "",
            targetName: "",
            targetItem: "",
            wants: "",
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

  it("accepts a translated scheduleHazard once a course is set, and spends the hazard budget (§hazard-and-field-levers)", () => {
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
          {
            kind: "scheduleHazard",
            hazard: "ionStorm",
            difficulty: "brutal",
            window: "later",
            outcome: "",
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
    expect(world.state.hazards).toMatchObject([
      { kind: "ionStorm", difficulty: bundle.config.hazards.difficulty.brutal },
    ]);
    expect(world.state.narrator.budget.hazardsRemaining).toBe(budget - 1);
  });

  it("accepts a translated scheduleField with scripted hits by name, and the field waits on the leg (§scheduling-a-field)", () => {
    const bundle = content();
    const registry = createRegistry();
    registerTravel(registry);
    registerField(registry);
    const kernel = createKernel(registry);
    const world = kernel.createWorld(FIXTURE_SCENARIO, 7, bundle, {
      values: bundle.config,
      hash: bundle.hash,
    });
    const travel = world.state.travel;
    if (travel.stage !== "docked") throw new Error("expected a new world to start docked");
    world.state.travel = { ...travel, plannedDestinationId: "port.kessler_drift" as PortDefId };
    const ctx: TranslationCtx = {
      snapshot: kernel.serialize(world),
      content: bundle,
      hookTick: world.state.tick,
      callId: "call-field",
    };
    const { commands, dropped } = translateIntents(
      emptyPlan({
        intents: [
          {
            kind: "scheduleField",
            severity: "heavy",
            detection: "unseen",
            window: "soon",
            scripted: [
              { target: "Main Engine", at: "late", rock: "small", effect: "knockout" },
              { target: "Galley", at: "early", rock: "", effect: "" },
            ],
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
    const field = world.state.field;
    expect(field).toMatchObject({
      severity: "heavy",
      detection: "unseen",
      phase: { kind: "scheduled" },
    });
    // Sorted by the second they land: the galley early, the engine late.
    expect(field?.scripted.map((s) => s.target.kind)).toEqual(["compartment", "machine"]);
    expect(field?.scripted[1]).toMatchObject({ rock: "small", effect: "knockout" });
  });

  it("accepts a translated errand at every pay tier, from the Hub to Harrow End, Tern's Rest to the Boathouse and Vesper Gate to the Lazaret (expeditions A2, plan call 6)", () => {
    const bundle = content();
    const scenario = bundle.scenarios[FIXTURE_SCENARIO];
    if (scenario === undefined) throw new Error("no fixture scenario");
    const routes = [
      { from: "port.crossroads_hub", site: "port.harrow_end", target: "Teodor Lusk" },
      { from: "port.terns_rest", site: "port.boathouse", target: "Corran Vale" },
      { from: "port.vesper_gate", site: "port.lazaret", target: "Orrin Sallow" },
    ] as const;
    for (const { from, site, target } of routes) {
      const startedHere = {
        ...bundle,
        scenarios: { ...bundle.scenarios, [FIXTURE_SCENARIO]: { ...scenario, startPortId: from } },
      };
      const registry = createRegistry();
      registerCommerce(registry);
      const kernel = createKernel(registry);
      const world = kernel.createWorld(FIXTURE_SCENARIO, 7, startedHere, {
        values: bundle.config,
        hash: bundle.hash,
      });
      expect(world.state.travel).toMatchObject({ stage: "docked", portId: from });
      const ctx: TranslationCtx = {
        snapshot: kernel.serialize(world),
        content: startedHere,
        hookTick: world.state.tick,
        callId: `call-errand-${from}`,
      };
      const intents = (["low", "standard", "generous"] as const).map((payTier) => ({
        kind: "offerJob",
        issuerName: "Ysolde Maren",
        issuerRole: "grower",
        issuerOrg: "",
        pitch: `Bring ${target} home.`,
        description: `Fetch ${target} back from the site.`,
        fromPort: from,
        toPort: from,
        cargoItem: "",
        quantity: "one",
        payTier,
        payCredits: 0,
        urgency: "soon",
        surface: false,
        passenger: false,
        roundTrip: false,
        errandKind: "fetchPerson",
        site,
        targetName: target,
        targetItem: "",
        wants: payTier === "generous" ? "either" : "alive",
      }));
      const { commands, dropped } = translateIntents(
        emptyPlan({ intents: intents as unknown as NarratorPlan["intents"] }),
        ctx,
      );
      expect(dropped).toEqual([]);
      expect(commands).toHaveLength(3);
      for (const command of commands) {
        const result = kernel.enqueueCommand(world, command);
        expect(result.status === "rejected" ? result.rejection.reason : "accepted").toBe(
          "accepted",
        );
      }
      kernel.advance(world, 2);
      const errands = Object.values(world.state.jobs).map((job) => job.errand);
      expect(errands).toEqual(
        Array.from({ length: 3 }, () =>
          expect.objectContaining({ siteId: site, targetName: target, returnToPortId: from }),
        ),
      );
    }
  });
});
