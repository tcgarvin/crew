/**
 * Expeditions A2 W1 on the real content and the full registry: a first errand from the Hub, for
 * Teodor Lusk at Harrow End. Its pay sits in the kernel's band at every tier (130 there and back,
 * via Green Meridian); its offer card's accept side validates whole while the site is known only
 * through the offer (call 1); the course runs via Green Meridian and the leg to the site is the
 * site's authored 20; setting down there costs no fee and raises neither a staging call nor
 * `captainAshore` (calls 9, §3.3). Hooks are acknowledged with no commands and cards answered
 * "left", as `crew beats` does. The fight and the way home are the sim's tests
 * (`systems/expedition/errand.test.ts`) and the episode's.
 */
import {
  type Command,
  type CommandId,
  type JobDraft,
  type Kernel,
  type NarratorHookKind,
  PAY_TIER_FRACTION,
  type PayTier,
  type PortDefId,
  type World,
  checkErrandBand,
  checkInvariants,
  createKernel,
  errandPay,
  travelViolations,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import { HUB_PORT_ID, createPacingRegistry, loadPacingContent } from "./pacing";

const HARROW_END = "port.harrow_end" as PortDefId;
const GREEN_MERIDIAN = "port.green_meridian" as PortDefId;
/** The Hub to Green Meridian (45), on to Harrow End (20), and the same back. */
const THERE_AND_BACK = 2 * (45 + 20);

let counter = 0;
function send(kernel: Kernel, world: World, command: Omit<Command, "id">) {
  counter += 1;
  return kernel.enqueueCommand(world, {
    ...command,
    id: `cmd:errand-harrow:${counter}` as CommandId,
  } as Command);
}

function freshWorld(): { kernel: Kernel; world: World } {
  const { bundle, config, scenarioId } = loadPacingContent();
  const kernel = createKernel(createPacingRegistry());
  return { kernel, world: kernel.createWorld(scenarioId, 1, bundle, config) };
}

function errand(world: World, tier: PayTier = "standard"): JobDraft {
  return {
    issuer: { name: "Ysolde Maren", role: "grower", org: "Meridian Growers" },
    description: { key: "job.template", params: {} },
    fromPortId: HUB_PORT_ID,
    toPortId: HUB_PORT_ID,
    cargo: [],
    pay: errandPay(world.config.values, THERE_AND_BACK, tier).pay,
    errand: { kind: "fetchPerson", siteId: HARROW_END, targetName: "Teodor Lusk", wants: "alive" },
  };
}

/** Advance in 10-tick steps, acknowledging hooks and answering cards "left", until `until`. */
function drive(
  kernel: Kernel,
  world: World,
  seconds: number,
  until: (world: World) => boolean,
  onStep: (world: World) => void = () => {},
): void {
  const end = world.state.tick + seconds * world.config.values.time.tickRate;
  while (world.state.tick < end && !until(world)) {
    const result = kernel.advance(world, 10);
    onStep(world);
    if (result.halt.kind === "hook") {
      const hook = world.state.narrator.pendingHook;
      if (hook === undefined) throw new Error("a hook halt with no pending hook");
      send(kernel, world, {
        source: "system",
        kind: "acknowledgeHook",
        payload: { hookId: hook.id },
      });
    } else if (result.halt.kind === "decision") {
      const head = world.state.decisions.queue[0];
      if (head === undefined) throw new Error("a decision halt with no card queued");
      send(kernel, world, {
        source: "player",
        kind: "resolveDecision",
        payload: { decisionId: head, side: "left" },
      });
    }
  }
}

const healthy = (world: World) => [...checkInvariants(world.state), ...travelViolations(world)];

describe("a first errand from the Hub, to Harrow End (expeditions A2 W1)", () => {
  it("pays inside the kernel's band at every tier", () => {
    const { world } = freshWorld();
    const ctx = { content: world.content, config: world.config.values, state: world.state };
    for (const tier of Object.keys(PAY_TIER_FRACTION) as PayTier[]) {
      const { pay } = errandPay(world.config.values, THERE_AND_BACK, tier);
      expect(checkErrandBand(ctx, HUB_PORT_ID, HARROW_END, pay), tier).toBeNull();
    }
  });

  it("is taken whole off its card, flown via Green Meridian, and set down free and unasked", () => {
    const { kernel, world } = freshWorld();
    expect(world.state.travel).toMatchObject({ stage: "docked", portId: HUB_PORT_ID });
    const offered = send(kernel, world, {
      source: "scenario",
      kind: "offerJob",
      payload: { job: errand(world), surface: true },
    });
    expect(offered.status).toBe("accepted");
    const job = () => Object.values(world.state.jobs)[0];
    // The card, delivered in person if it must be, answered "left": acceptContract then setCourse
    // to the site, both validated before either applies.
    drive(kernel, world, 300, () => job() !== undefined && job()?.status !== "offered");
    expect(["accepted", "inTransit"]).toContain(job()?.status);
    const travel = world.state.travel;
    const next = travel.stage === "docked" ? travel.plannedDestinationId : travel.toPortId;
    expect(next).toBe(GREEN_MERIDIAN);
    expect(travel.voyageDestinationId).toBe(HARROW_END);

    const legs: string[] = [];
    /** Where the ship was docked when each docking fee was taken. */
    const feesAt: string[] = [];
    const hooksAtSite: NarratorHookKind[] = [];
    let seen = Object.keys(world.state.money.transactions).length;
    const atSite = (w: World) =>
      w.state.travel.stage === "docked" && w.state.travel.portId === HARROW_END;
    const watch = (w: World) => {
      const t = w.state.travel;
      if (t.stage === "transit") {
        const leg = `${t.fromPortId}>${t.toPortId}:${t.routeDistance}`;
        if (!legs.includes(leg)) legs.push(leg);
      }
      const transactions = Object.values(w.state.money.transactions);
      for (const tx of transactions.slice(seen)) {
        if (tx.reason === "fee") feesAt.push(t.stage === "docked" ? t.portId : t.stage);
      }
      seen = transactions.length;
      const hook = w.state.narrator.pendingHook;
      if (atSite(w) && hook !== undefined) hooksAtSite.push(hook.kind);
    };
    drive(kernel, world, 900, atSite, watch);
    expect(atSite(world)).toBe(true);
    expect(legs).toEqual([
      `${HUB_PORT_ID}>${GREEN_MERIDIAN}:45`,
      `${GREEN_MERIDIAN}>${HARROW_END}:20`,
    ]);
    // A few seconds set down: long enough for a fee, a staging call or the captain going ashore.
    drive(kernel, world, 10, () => false, watch);
    expect(feesAt).toEqual([GREEN_MERIDIAN]);
    expect(hooksAtSite).not.toContain("stageDock");
    expect(hooksAtSite).not.toContain("captainAshore");
    expect(healthy(world)).toEqual([]);
  }, 60_000);
});
