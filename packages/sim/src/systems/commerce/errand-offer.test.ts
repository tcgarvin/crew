/**
 * Expeditions A2 gate (§6, plan calls 1, 2, 3 and 6): an errand offered, banded, accepted and
 * flown to. The site world (`expedition/fixtures/site.ts`: docked at `TINY.port`, the test site
 * 10 away) with commerce registered. Pay is banded by the fixture's `priceBands.errand` (3 to 6
 * per unit of distance there and back).
 */
import { describe, expect, it } from "vitest";
import type { TestWorld } from "../../core/fixtures/test-world";
import { tinyEffectiveConfig } from "../../core/fixtures/tiny-content";
import { TINY } from "../../core/fixtures/tiny-content";
import { createKernel } from "../../core/kernel";
import { createRegistry } from "../../core/registry";
import type { Command, JobDraft } from "../../core/types/commands";
import { STAGING_LIMITS } from "../../core/types/dockside";
import type { CommandId, DecisionId, ItemDefId, JobId, PortDefId } from "../../core/types/ids";
import type { Job } from "../../core/types/travel";
import { registerPlannerDefaults } from "../../planner/index";
import { registerBodies } from "../bodies/index";
import { testDamage } from "../expedition/fixtures/damage";
import { SITE, siteContent } from "../expedition/fixtures/site";
import { registerExpedition } from "../expedition/index";
import { registerNeeds } from "../needs/index";
import { registerSpatial } from "../spatial/index";
import { docksideConfig } from "../travel/fixtures-dock";
import { registerTravel } from "../travel/index";
import { ALL_DERIVATIONS, CREW } from "../work/fixtures/crew-deck";
import { registerWork } from "../work/index";
import { type PAY_TIER_FRACTION, errandPay } from "./errand";
import { registerCommerce } from "./index";
import { checkErrandBand } from "./jobs";

function errandWorld(): TestWorld {
  const config = docksideConfig();
  const registry = createRegistry();
  registerSpatial(registry);
  registerTravel(registry);
  registerCommerce(registry);
  registerNeeds(registry);
  registerBodies(registry);
  registerExpedition(registry, { applyDamage: testDamage });
  registerWork(registry, { derivations: ALL_DERIVATIONS });
  registerPlannerDefaults(registry);
  const kernel = createKernel(registry);
  const world = kernel.createWorld(
    CREW.scenario2,
    11,
    siteContent(config),
    tinyEffectiveConfig(config),
  );
  return { registry, kernel, world };
}

let n = 0;
function send(test: TestWorld, command: Omit<Command, "id">) {
  n += 1;
  return test.kernel.enqueueCommand(test.world, {
    ...command,
    id: `cmd:errand:${n}` as CommandId,
  } as Command);
}

/** The errand band from the home port (`TINY.port`): 10 to the site and 10 back. */
const BAND = { min: 60, max: 120 };

function errandDraft(overrides: Partial<JobDraft> = {}): JobDraft {
  return {
    issuer: { name: "Ysolde Maren", role: "grower", org: "Meridian Growers" },
    description: { key: "job.template", params: {} },
    fromPortId: TINY.port,
    toPortId: TINY.port,
    cargo: [],
    pay: 90,
    errand: { kind: "fetchPerson", siteId: SITE.port, targetName: "Corran Vale", wants: "alive" },
    ...overrides,
  };
}

function offer(test: TestWorld, job: JobDraft, surface = false) {
  return send(test, { source: "scenario", kind: "offerJob", payload: { job, surface } });
}

const rejection = (result: ReturnType<typeof offer>) =>
  result.status === "rejected" ? result.rejection : undefined;

const onlyJob = (test: TestWorld): Job => {
  const [job] = Object.values(test.world.state.jobs);
  if (job === undefined) throw new Error("no job was offered");
  return job;
};

describe("the errand's pay (plan call 6)", () => {
  it("is the errand band over the distance there and back, at the tier's point", () => {
    const config = docksideConfig();
    const pay = (tier: keyof typeof PAY_TIER_FRACTION) => errandPay(config, 20, tier);
    expect(pay("low")).toEqual({ pay: 69, min: 60, max: 120 });
    expect(pay("standard").pay).toBe(90);
    expect(pay("generous").pay).toBe(111);
  });

  it("checkErrandBand prices the path to the site and back on the all graph, and nothing else", () => {
    const { world } = errandWorld();
    const ctx = { content: world.content, config: world.config.values, state: world.state };
    expect(checkErrandBand(ctx, TINY.port, SITE.port, BAND.min)).toBeNull();
    expect(checkErrandBand(ctx, TINY.port, SITE.port, BAND.max)).toBeNull();
    expect(checkErrandBand(ctx, TINY.port, SITE.port, BAND.max + 1)).toBe(
      "pay 121 outside errand band [60, 120]",
    );
    // From the far port: 40 there (via the near port) and 40 back.
    expect(checkErrandBand(ctx, TINY.port2, SITE.port, 240)).toBeNull();
    expect(checkErrandBand(ctx, TINY.port2, SITE.port, 239)).toBe(
      "pay 239 outside errand band [240, 480]",
    );
    expect(checkErrandBand(ctx, TINY.port, TINY.port2, 90)).toBe(
      `"${TINY.port2}" is not a landing site`,
    );
    expect(checkErrandBand(ctx, TINY.port, SITE.port, 90.5)).toBe(
      "pay must be a nonnegative integer",
    );
  });
});

describe("offerJob with an errand (expeditions A2, §6)", () => {
  it("accepts an errand home from a site its port reaches, copying it with the way home", () => {
    const test = errandWorld();
    expect(offer(test, errandDraft()).status).toBe("accepted");
    test.kernel.advance(test.world, 1);
    const job = onlyJob(test);
    expect(job.status).toBe("offered");
    expect(job.toPortId).toBe(TINY.port);
    expect(job.cargo).toEqual([]);
    expect(job.passage).toBeUndefined();
    expect(job.errand).toEqual({
      kind: "fetchPerson",
      siteId: SITE.port,
      targetName: "Corran Vale",
      wants: "alive",
      returnToPortId: TINY.port,
    });
  });

  it("accepts a fetchItem that names an item and wants it either way", () => {
    const test = errandWorld();
    const job = errandDraft({
      errand: {
        kind: "fetchItem",
        siteId: SITE.port,
        targetName: "the strongbox papers",
        itemDefId: SITE.blaster,
        wants: "either",
      },
    });
    expect(offer(test, job).status).toBe("accepted");
  });

  it("refuses every malformed errand, each with its reason", () => {
    const test = errandWorld();
    const errand = errandDraft().errand;
    if (errand === undefined) throw new Error("the draft lost its errand");
    const cases: [Partial<JobDraft>, string, string][] = [
      [{ toPortId: TINY.port2 }, "invalidPayload", "comes back where it starts"],
      [{ errand: { ...errand, kind: "rescue" as never } }, "invalidPayload", "kind must be one of"],
      [
        { errand: { ...errand, siteId: "port.nowhere" as PortDefId } },
        "unknownEntity",
        "unknown site",
      ],
      [{ errand: { ...errand, siteId: TINY.port2 } }, "invalidPayload", "is a port, not a site"],
      [{ errand: { ...errand, targetName: "  " } }, "invalidPayload", "names its target"],
      [
        { errand: { ...errand, targetName: "x".repeat(STAGING_LIMITS.nameChars + 1) } },
        "invalidPayload",
        "longer than",
      ],
      [
        { errand: { ...errand, kind: "fetchItem", wants: "either" } },
        "invalidPayload",
        "a fetchItem names its item",
      ],
      [
        {
          errand: {
            ...errand,
            kind: "fetchItem",
            itemDefId: "item.nowhere" as ItemDefId,
            wants: "either",
          },
        },
        "unknownEntity",
        "unknown item",
      ],
      [
        { errand: { ...errand, kind: "fetchItem", itemDefId: SITE.blaster, wants: "alive" } },
        "invalidPayload",
        "either",
      ],
      [{ errand: { ...errand, itemDefId: SITE.blaster } }, "invalidPayload", "only a fetchItem"],
      [{ errand: { ...errand, wants: "maimed" as never } }, "invalidPayload", "wants its target"],
      [{ cargo: [{ itemDefId: TINY.crate, count: 1 }] }, "invalidPayload", "carries no cargo"],
      [{ passenger: true }, "invalidPayload", "no passage"],
      [{ pay: BAND.max + 1 }, "outOfBounds", "outside errand band"],
      [{ pay: BAND.min - 1 }, "outOfBounds", "outside errand band"],
    ];
    for (const [overrides, code, reason] of cases) {
      const refused = rejection(offer(test, errandDraft(overrides)));
      expect(refused?.code, reason).toBe(code);
      expect(refused?.reason, reason).toContain(reason);
    }
    expect(test.world.state.jobs).toEqual({});
  });

  it("refuses an errand whose site's near port its port cannot reach", () => {
    const test = errandWorld();
    const island = "port.test.island" as PortDefId;
    const site = test.world.content.ports[SITE.port];
    if (site === undefined) throw new Error("no site");
    const content = {
      ...test.world.content,
      ports: {
        ...test.world.content.ports,
        [island]: { ...site, id: island, kind: "port" as const, routes: [] },
        [SITE.port]: { ...site, nearPortId: island, routes: [{ toPortId: island, distance: 10 }] },
      },
    };
    const world = test.kernel.createWorld(CREW.scenario2, 11, content, test.world.config);
    const refused = test.kernel.enqueueCommand(world, {
      id: "cmd:errand:island" as CommandId,
      source: "scenario",
      kind: "offerJob",
      payload: { job: errandDraft(), surface: false },
    });
    expect(refused.status === "rejected" ? refused.rejection.code : undefined).toBe(
      "preconditionFailed",
    );
  });
});

describe("the errand's offer card and its course (plan calls 1, 2 and 3)", () => {
  /** Surface the errand's card at home and take it. */
  function takeTheErrand(test: TestWorld): { decisionId: DecisionId; jobId: JobId } {
    expect(offer(test, errandDraft(), true).status).toBe("accepted");
    test.kernel.advance(test.world, 1);
    const decisionId = test.world.state.decisions.queue[0];
    if (decisionId === undefined) throw new Error("the offer card was not queued");
    const card = test.world.state.decisions.records[decisionId];
    expect(card?.prompt.params).toMatchObject({
      errand: "fetchPerson",
      target: "Corran Vale",
      site: SITE.port,
      wants: "alive",
    });
    expect(card?.left.commands).toEqual([
      { kind: "acceptContract", payload: { jobId: onlyJob(test).id } },
      { kind: "setCourse", payload: { destinationPortId: SITE.port } },
    ]);
    const taken = send(test, {
      source: "player",
      kind: "resolveDecision",
      payload: { decisionId, side: "left" },
    });
    expect(taken.status).toBe("accepted");
    test.kernel.advance(test.world, 1);
    return { decisionId, jobId: onlyJob(test).id };
  }

  it("takes the job and sets course for the site in one resolution: both sides validate whole", () => {
    const test = errandWorld();
    const { decisionId } = takeTheErrand(test);
    expect(test.world.state.decisions.records[decisionId]?.status).toBe("resolved");
    // Taken (and, with nothing to load and no course to plot here, already leaving).
    expect(["accepted", "inTransit"]).toContain(onlyJob(test).status);
    const travel = test.world.state.travel;
    const bound = travel.stage === "docked" ? travel.plannedDestinationId : travel.toPortId;
    expect(bound).toBe(SITE.port);
  });

  it("flies the leg to the site at the site's authored distance, and sets down with no staging call", () => {
    const test = errandWorld();
    takeTheErrand(test);
    const hooks = new Set<string>();
    let leg: number | undefined;
    const landed = () => {
      const travel = test.world.state.travel;
      return travel.stage === "docked" && travel.portId === SITE.port;
    };
    for (let i = 0; i < 6000 && !landed(); i++) {
      test.kernel.advance(test.world, 1);
      const travel = test.world.state.travel;
      if (travel.stage === "transit") leg = travel.routeDistance;
      const hook = test.world.state.narrator.pendingHook;
      if (hook !== undefined) {
        hooks.add(hook.kind);
        send(test, { source: "system", kind: "acknowledgeHook", payload: { hookId: hook.id } });
      }
    }
    expect(test.world.state.travel).toMatchObject({ stage: "docked", portId: SITE.port });
    expect(leg).toBe(10);
    expect(hooks.has("stageDock")).toBe(false);
  });

  it("will not set course for a site no errand names", () => {
    const test = errandWorld();
    const refused = send(test, {
      source: "player",
      kind: "setCourse",
      payload: { destinationPortId: SITE.port },
    });
    expect(refused.status === "rejected" ? refused.rejection.reason : undefined).toContain(
      "no route",
    );
  });
});
