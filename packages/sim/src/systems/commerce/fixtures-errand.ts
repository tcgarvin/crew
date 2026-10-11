/**
 * Expeditions A2 test fixture (W1): an errand end to end, by commands alone. The site world
 * (`expedition/fixtures/site.ts`: the dockside crew deck docked at `TINY.port`, the test site 10
 * away) with commerce registered and the `crew.passenger` template the captive boards as. An
 * errand is offered by a scenario `offerJob`, its card taken, the leg flown, the expedition begun
 * and run, and the ship flown home; every step checks the invariants.
 *
 * Beginning the expedition works before and after the landing start (A2 call 12, W2's
 * `landedForErrand`): when the sim has started one for the errand, its arrival card is answered with
 * the side that adopts the fixture's plan; when it has not, `scenarioStartExpedition` starts it
 * with that plan and the expedition is given the errand's `jobId`, the state the landing start
 * builds. The cast is the site map's `defaultCast` either way (with the errand's name on the
 * target, as `castFor` puts it), so `errandContent` takes the cast a test wants.
 *
 * The real bundle (Harrow End, via Green Meridian) lives in `@crew/content`, which the kernel's
 * tests cannot import; `apps/cli` plays the errand there.
 */
import { createDefLookup } from "../../core/defs";
import type { TestWorld } from "../../core/fixtures/test-world";
import { TINY, tinyEffectiveConfig } from "../../core/fixtures/tiny-content";
import { bodyViolations, checkInvariants, expeditionViolations } from "../../core/invariants";
import { createKernel } from "../../core/kernel";
import { createRegistry } from "../../core/registry";
import { createRngApi } from "../../core/rng";
import type { Command, JobDraft } from "../../core/types/commands";
import type { ConfigDef, ContentBundle, SiteCastEntryDef } from "../../core/types/content";
import type { Decision, NarratorHook } from "../../core/types/decisions";
import type { EventDraft, SimEvent } from "../../core/types/events";
import type { CommandId, DecisionId, JobId, ScenarioDefId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
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
import { travelViolations } from "../travel/invariants";
import { ALL_DERIVATIONS, CREW } from "../work/fixtures/crew-deck";
import { registerWork } from "../work/index";
import { errandPay } from "./errand";
import { registerCommerce } from "./index";
import { commerceViolations } from "./invariants";
import { PASSENGER_CREW_DEF_ID } from "./passage";

/** The plan the fixture's expeditions run: a straight assault, which takes a lone target. */
export const ERRAND_PLAN = "assault-lethal-armed";

/** The issuer's name and the target's (the site's own target is renamed for the errand). */
export const ERRAND_PEOPLE = { issuer: "Ysolde Maren", target: "Corran Vale" } as const;

/** The site's target alone, unarmed and wanting nothing: nobody fights and nobody runs. */
export function loneTarget(cast: readonly SiteCastEntryDef[]): SiteCastEntryDef[] {
  const target = cast.find((entry) => entry.part === "target");
  if (target === undefined) throw new Error("the site's cast has no target");
  return [{ ...target, wants: "nothing" }];
}

/** The site world's content, the passenger template added, the site's cast `cast` if given. */
export function errandContent(
  config: ConfigDef = docksideConfig(),
  cast?: (defaultCast: readonly SiteCastEntryDef[]) => readonly SiteCastEntryDef[],
): ContentBundle {
  const base = siteContent(config);
  const docks = base.docks ?? {};
  const site = docks[SITE.dock];
  if (site === undefined) throw new Error("the site fixture lost its map");
  return {
    ...base,
    crew: {
      ...base.crew,
      [PASSENGER_CREW_DEF_ID]: {
        id: PASSENGER_CREW_DEF_ID,
        name: "Passenger",
        roleTags: [],
        skills: {},
        startingInventory: [],
        bio: "A paying passenger.",
        voice: "Whoever they turn out to be.",
      },
    },
    docks:
      cast === undefined
        ? docks
        : { ...docks, [SITE.dock]: { ...site, defaultCast: [...cast(site.defaultCast ?? [])] } },
    hash: "errand-v1",
  };
}

export interface ErrandWorldOptions {
  readonly seed?: number;
  readonly scenario?: ScenarioDefId;
  /** The site's cast from its default (`loneTarget` makes the take sure). */
  readonly cast?: (defaultCast: readonly SiteCastEntryDef[]) => readonly SiteCastEntryDef[];
}

/** The site world with commerce, docked at `TINY.port`. */
export function errandWorld(opts: ErrandWorldOptions = {}): TestWorld {
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
    opts.scenario ?? CREW.scenario2,
    opts.seed ?? 11,
    errandContent(config, opts.cast),
    tinyEffectiveConfig(config),
  );
  return { registry, kernel, world };
}

let n = 0;

/** Enqueue `command` with a fresh id. */
export function send(test: TestWorld, command: Omit<Command, "id">) {
  n += 1;
  return test.kernel.enqueueCommand(test.world, {
    ...command,
    id: `cmd:errand-w1:${n}` as CommandId,
  } as Command);
}

/** An errand home to `TINY.port` for the target at the site, at the standard tier. */
export function errandDraft(test: TestWorld, overrides: Partial<JobDraft> = {}): JobDraft {
  return {
    issuer: { name: ERRAND_PEOPLE.issuer, role: "grower", org: "Meridian Growers" },
    description: { key: "job.template", params: {} },
    fromPortId: TINY.port,
    toPortId: TINY.port,
    cargo: [],
    pay: errandPay(test.world.config.values, 20, "standard").pay,
    errand: {
      kind: "fetchPerson",
      siteId: SITE.port,
      targetName: ERRAND_PEOPLE.target,
      wants: "alive",
    },
    ...overrides,
  };
}

/** The one job on record. */
export function theJob(test: TestWorld): Job {
  const jobs = Object.values(test.world.state.jobs);
  const [job] = jobs;
  if (job === undefined || jobs.length !== 1) throw new Error(`${jobs.length} jobs on record`);
  return job;
}

/** Every invariant the errand touches. */
export function errandViolations(test: TestWorld): string[] {
  const { world } = test;
  return [
    ...checkInvariants(world.state),
    ...travelViolations(world),
    ...bodyViolations(world),
    ...expeditionViolations(world),
    ...commerceViolations(world),
  ];
}

/** The card side that adopts `planId`, else the left. */
function arrivalSide(card: Decision, planId: string): "left" | "right" {
  const adopts = (side: Decision["left"]) =>
    side.commands.some(
      (c) => c.kind === "adoptPlan" && (c.payload as { planId?: unknown }).planId === planId,
    );
  return !adopts(card.left) && adopts(card.right) ? "right" : "left";
}

export interface RunOptions {
  readonly until?: () => boolean;
  /**
   * How to answer a card at the head of the queue; the default takes the offer, adopts
   * `ERRAND_PLAN` on the arrival card and says "left" to anything else.
   */
  readonly answer?: (card: Decision) => "left" | "right";
  /** Called once for each hook raised, before it is acknowledged. */
  readonly onHook?: (hook: NarratorHook) => void;
  /** Called after every step, with that step's events. */
  readonly onStep?: (events: readonly SimEvent[]) => void;
}

let acks = 0;

/**
 * Advance up to `seconds` in 10-tick steps, acknowledging hooks with no commands and answering
 * cards, until `until` holds; throws on the first invariant broken. Returns the events.
 */
export function runErrand(test: TestWorld, seconds: number, opts: RunOptions = {}): SimEvent[] {
  const { kernel, world } = test;
  const events: SimEvent[] = [];
  const end = world.state.tick + seconds * world.config.values.time.tickRate;
  let lastHook: string | undefined;
  let stalled = 0;
  while (world.state.tick < end) {
    if (opts.until?.() === true) break;
    const result = kernel.advance(world, 10);
    events.push(...result.events);
    stalled = result.ticksAdvanced === 0 ? stalled + 1 : 0;
    if (stalled > 2) throw new Error(`tick ${world.state.tick}: stalled (${result.halt.kind})`);
    const found = errandViolations(test);
    if (found.length > 0) throw new Error(`tick ${world.state.tick}: ${found.join("; ")}`);
    opts.onStep?.(result.events);
    const hook = world.state.narrator.pendingHook;
    const hookId = hook?.id;
    if (hook !== undefined && hook.id !== lastHook) opts.onHook?.(hook);
    lastHook = hookId;
    if (hookId !== undefined) {
      acks += 1;
      kernel.enqueueCommand(world, {
        id: `cmd:errand-w1:ack:${acks}` as CommandId,
        source: "system",
        kind: "acknowledgeHook",
        payload: { hookId },
      });
    }
    answerHead(test, opts.answer);
  }
  return events;
}

function defaultAnswer(card: Decision): "left" | "right" {
  return card.prompt.key === "expedition.arrival" ? arrivalSide(card, ERRAND_PLAN) : "left";
}

/** Answer the card at the head of the queue, if one is pending there. */
function answerHead(test: TestWorld, answer: RunOptions["answer"]): void {
  const { records, queue } = test.world.state.decisions;
  const head: DecisionId | undefined = queue[0];
  const card = head === undefined ? undefined : records[head];
  if (card === undefined || card.status !== "pending") return;
  const side = (answer ?? defaultAnswer)(card);
  const result = send(test, {
    source: "player",
    kind: "resolveDecision",
    payload: { decisionId: card.id, side },
  });
  if (result.status !== "accepted") {
    throw new Error(`card ${card.prompt.key} refused: ${JSON.stringify(result)}`);
  }
}

/** Offer the errand (surfaced: its card comes up at once) and take it. Returns its id. */
export function takeErrand(test: TestWorld, draft: JobDraft = errandDraft(test)): JobId {
  const offered = send(test, {
    source: "scenario",
    kind: "offerJob",
    payload: { job: draft, surface: true },
  });
  if (offered.status !== "accepted") throw new Error(`offer refused: ${JSON.stringify(offered)}`);
  const job = () => theJob(test);
  const taken = () => Object.values(test.world.state.jobs).some((j) => j.status !== "offered");
  runErrand(test, 30, { until: taken });
  if (job().status !== "accepted" && job().status !== "inTransit") {
    throw new Error(`the errand was not taken (${job().status})`);
  }
  return job().id;
}

const dockedAt = (test: TestWorld, portId: string) => {
  const travel = test.world.state.travel;
  return travel.stage === "docked" && travel.portId === portId;
};

/** Fly the leg to the site; returns the events on the way. */
export function flyToSite(test: TestWorld, opts: RunOptions = {}): SimEvent[] {
  const events = runErrand(test, 300, { ...opts, until: () => dockedAt(test, SITE.port) });
  if (!dockedAt(test, SITE.port)) throw new Error("the ship never set down at the site");
  return events;
}

/**
 * Begin the expedition for `jobId` at the site the ship is set down at, under `ERRAND_PLAN`: the
 * landing start's when it has run (its arrival card adopts the plan in `runErrand`), else by
 * scenario command with the site's cast and the target renamed, given the errand's `jobId`.
 */
export function beginExpedition(test: TestWorld, jobId: JobId): void {
  runErrand(test, 0.5);
  const started = test.world.state.expedition;
  if (started !== undefined && started.phase !== "resolved" && started.jobId === jobId) return;
  const site = test.world.content.docks?.[SITE.dock];
  const targetName = test.world.state.jobs[jobId]?.errand?.targetName;
  if (site === undefined || targetName === undefined) throw new Error("no site or no errand");
  const cast = (site.defaultCast ?? []).map((entry) =>
    entry.part === "target" ? { ...entry, name: targetName } : entry,
  );
  const result = send(test, {
    source: "scenario",
    kind: "scenarioStartExpedition",
    payload: { siteId: SITE.port, plan: ERRAND_PLAN, cast },
  });
  if (result.status !== "accepted") throw new Error(`start refused: ${JSON.stringify(result)}`);
  test.kernel.advance(test.world, 1);
  const expedition = test.world.state.expedition;
  if (expedition === undefined) throw new Error("the expedition did not start");
  expedition.jobId = jobId;
}

/** Run the expedition to its resolution. */
export function fightIt(test: TestWorld, opts: RunOptions = {}): SimEvent[] {
  const resolved = () => test.world.state.expedition?.phase === "resolved";
  const events = runErrand(test, 400, {
    ...opts,
    until: () => resolved() || opts.until?.() === true,
  });
  if (!resolved() && opts.until === undefined) throw new Error("the expedition never resolved");
  return events;
}

/** Fly home to `TINY.port` and run until the job closes (paid or failed) there. */
export function flyHome(test: TestWorld, jobId: JobId, opts: RunOptions = {}): SimEvent[] {
  const closed = () => {
    const status = test.world.state.jobs[jobId]?.status;
    return dockedAt(test, TINY.port) && (status === "paid" || status === "failed");
  };
  const events = runErrand(test, 600, { ...opts, until: closed });
  if (!closed()) throw new Error("the ship never came home to a closed job");
  return events;
}

/** A step context over the world as it stands, its events collected (for direct calls in tests). */
export function stepCtxOf(test: TestWorld): { ctx: StepCtx; drafts: EventDraft[] } {
  const { world } = test;
  const drafts: EventDraft[] = [];
  const ctx = {
    state: world.state,
    caches: world.caches,
    content: world.content,
    defs: createDefLookup(world.content, world.state),
    config: world.config.values,
    rng: createRngApi(world.state),
    tick: world.state.tick + 1,
    elapsedTicks: 1,
    dirty: world.caches.dirty,
    emit: (draft: EventDraft) => {
      drafts.push(draft);
    },
  } satisfies StepCtx;
  return { ctx, drafts };
}
