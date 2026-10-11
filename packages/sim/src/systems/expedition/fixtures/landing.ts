/**
 * Expeditions A2 (W2) test fixture: set down at a site for an errand. The site world (`site.ts`:
 * docked at `TINY.port` with the quay alongside, the test site `SITE.port` near it, an arms locker
 * with three blasters and two batons) with an errand in hand: `inTransit` from `TINY.port` and
 * back, for a target at `SITE.port`, and the course set to the site. `flyToSite` advances travel
 * until the ship is docked there; the expedition starts itself the tick after.
 *
 * The plan asked for the real bundle (Green Meridian and Harrow End); the kernel's tests cannot
 * import `@crew/content` (see `site.ts`), so this is its shape on the kernel's own site: a near
 * port, a leg of the site's authored distance on the known graph, and a site map with a default
 * cast. The real-content episode is the CLI's.
 */
import type { TestWorld } from "../../../core/fixtures/test-world";
import { TINY } from "../../../core/fixtures/tiny-content";
import { allocateId } from "../../../core/ids";
import type { Command } from "../../../core/types/commands";
import type { SimEvent } from "../../../core/types/events";
import type { CommandId, DecisionId, ItemDefId, JobId } from "../../../core/types/ids";
import type { ErrandKind, ErrandWants, Job } from "../../../core/types/travel";
import { CREW } from "../../work/fixtures/crew-deck";
import { violations } from "./fight";
import { SITE, type SiteWorldOptions, siteWorld } from "./site";

/** The errand's target: not the default cast's name, so the rename shows. */
export const TARGET_NAME = "Brannoc Vey";

export interface ErrandOptions {
  readonly wants?: ErrandWants;
  readonly kind?: ErrandKind;
}

export interface LandingOptions extends SiteWorldOptions, ErrandOptions {
  /** Make Jon the first officer (the fixture crew has none), who brings the cards. */
  readonly firstOfficer?: boolean;
}

export interface LandingWorld extends TestWorld {
  readonly jobId: JobId;
}

/** An errand job, as `offerJob` and acceptance leave it once the ship is under way. */
function errandJob(test: TestWorld, options: ErrandOptions): Job {
  const state = test.world.state;
  const id = allocateId(state, "job");
  const kind = options.kind ?? "fetchPerson";
  return {
    id,
    origin: "scenario",
    issuer: "Ysolde Maren, Meridian Growers",
    issuerPerson: { name: "Ysolde Maren", role: "grower", org: "Meridian Growers" },
    pitch: { key: "job.pitch", params: {} },
    urgency: "soon",
    description: { key: "job.template", params: {} },
    fromPortId: TINY.port,
    toPortId: TINY.port,
    cargo: [],
    cargoClass: "general",
    pay: 100,
    status: "inTransit",
    offeredTick: state.tick,
    expiresAtTick: state.tick + 1_000_000,
    cargoItemIds: [],
    errand: {
      kind,
      siteId: SITE.port,
      targetName: kind === "fetchItem" ? "the strongbox" : TARGET_NAME,
      ...(kind === "fetchItem" ? { itemDefId: SITE.baton as ItemDefId } : {}),
      wants: kind === "fetchItem" ? "either" : (options.wants ?? "alive"),
      returnToPortId: TINY.port,
    },
  };
}

/** Put an errand for `SITE.port` in hand (`inTransit`); returns its id. */
export function addErrand(test: TestWorld, options: ErrandOptions = {}): JobId {
  const job = errandJob(test, options);
  test.world.state.jobs[job.id] = job;
  return job.id;
}

let n = 0;

/** Enqueue `command` with a fresh id (its source as given). */
export function sendAs(test: TestWorld, command: Omit<Command, "id">) {
  n += 1;
  return test.kernel.enqueueCommand(test.world, {
    ...command,
    id: `cmd:landing:${n}` as CommandId,
  } as Command);
}

/**
 * The site world with an errand `inTransit` for `SITE.port` and the course set there. (Commerce is
 * not registered: the job is written as acceptance and lift-off leave it, and nothing settles it.)
 */
export function landingWorld(options: LandingOptions = {}): LandingWorld {
  const test = siteWorld(options);
  if (options.firstOfficer !== false) {
    const jon = Object.values(test.world.state.actors).find((a) => a.defId === CREW.jon);
    if (jon === undefined) throw new Error("the fixture crew has no Jon");
    jon.roleTags = [...jon.roleTags, "firstOfficer"];
  }
  const jobId = addErrand(test, options);
  const course = sendAs(test, {
    source: "player",
    kind: "setCourse",
    payload: { destinationPortId: SITE.port },
  });
  if (course.status !== "accepted") throw new Error(`setCourse refused: ${JSON.stringify(course)}`);
  return { ...test, jobId };
}

/** Acknowledge the pending hook, if any. */
export function acknowledge(test: TestWorld): void {
  const hookId = test.world.state.narrator.pendingHook?.id;
  if (hookId === undefined) return;
  sendAs(test, { source: "system", kind: "acknowledgeHook", payload: { hookId } });
}

/** Answer the card on screen. */
export function answer(test: TestWorld, decisionId: DecisionId, side: "left" | "right") {
  return sendAs(test, { source: "player", kind: "resolveDecision", payload: { decisionId, side } });
}

/**
 * Advance one tick at a time for up to `ticks`, acknowledging hooks, checking every invariant the
 * fight touches at each step (unless `check` is false: a long fight checked tick by tick costs
 * seconds); stops once `until` holds or a decision halts the world. Returns the events.
 */
export function step(
  test: TestWorld,
  ticks: number,
  until: () => boolean = () => false,
  check = true,
): SimEvent[] {
  const events: SimEvent[] = [];
  for (let t = 0; t < ticks && !until(); t++) {
    const result = test.kernel.advance(test.world, 1);
    events.push(...result.events);
    const found = check ? violations(test) : [];
    if (found.length > 0) throw new Error(`tick ${test.world.state.tick}: ${found.join("; ")}`);
    if (result.halt.kind === "hook") acknowledge(test);
    else if (result.halt.kind === "decision") break;
  }
  return events;
}

/** Set down at the site: advance travel (hooks acknowledged) until docked there. */
export function flyToSite(test: TestWorld, seconds = 600): SimEvent[] {
  const there = () => {
    const travel = test.world.state.travel;
    return travel.stage === "docked" && travel.portId === SITE.port;
  };
  const events = step(test, seconds * test.world.config.values.time.tickRate, there);
  if (!there()) {
    throw new Error(`not set down at the site: ${JSON.stringify(test.world.state.travel)}`);
  }
  return events;
}
