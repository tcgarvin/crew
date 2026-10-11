/**
 * D105 (W1) test fixture: set down at the kernel's test site for an errand (`landing.ts`, the crew
 * of eight, Jon the first officer), the narrator's mark on one side of the arrival card or none,
 * and the captain's answer. An item errand fetches "the strongbox", a crate, so the one who carries
 * it out keeps fighting with their own weapon. Hooks are acknowledged as a host would, the mark
 * queued ahead of the acknowledgement, so it applies with the answer just ahead of it.
 */
import { TINY } from "../../../core/fixtures/tiny-content";
import type { Decision } from "../../../core/types/decisions";
import type { SimEvent } from "../../../core/types/events";
import type { ErrandKind } from "../../../core/types/travel";
import { CREW } from "../../work/fixtures/crew-deck";
import { violations } from "./fight";
import {
  type LandingWorld,
  acknowledge,
  answer,
  flyToSite,
  landingWorld,
  sendAs,
  step,
} from "./landing";

/** The item errand's thing, by the errand's name. */
export const ITEM_NAME = "the strongbox";
export const ITEM_DEF = TINY.crate;

export interface SneakOptions {
  readonly kind: ErrandKind;
  /** The arrival card side the narrator marks to get in unseen; none when absent. */
  readonly mark?: "left" | "right";
  /** The side the captain answers. */
  readonly choose: "left" | "right";
  readonly seed?: number;
}

/** The expedition's arrival card. */
export function arrivalCard(test: LandingWorld): Decision {
  const id = test.world.state.expedition?.cards?.arrival;
  const record = id === undefined ? undefined : test.world.state.decisions.records[id];
  if (record === undefined) throw new Error("no arrival card");
  return record;
}

/** Set down for an errand of `kind`, the arrival card's hook raised and not yet acknowledged. */
export function landedFor(kind: ErrandKind, seed?: number): LandingWorld {
  const test = landingWorld({
    scenario: CREW.scenario8,
    kind,
    ...(seed === undefined ? {} : { seed }),
  });
  const job = test.world.state.jobs[test.jobId];
  if (job?.errand === undefined) throw new Error("the landing fixture lost its errand");
  if (kind === "fetchItem") {
    job.errand = { ...job.errand, targetName: ITEM_NAME, itemDefId: ITEM_DEF };
  }
  flyToSite(test);
  test.kernel.advance(test.world, 1);
  const found = violations(test);
  if (found.length > 0) throw new Error(`landed: ${found.join("; ")}`);
  return test;
}

/**
 * Landed, marked (if asked) and answered: the plan adopted the tick after, that tick's events
 * returned with the world.
 */
export function sneakIn(options: SneakOptions): { test: LandingWorld; events: SimEvent[] } {
  const test = landedFor(options.kind, options.seed);
  const card = arrivalCard(test);
  if (options.mark !== undefined) {
    const planId = card.prompt.params[`${options.mark}Plan`];
    const marked = sendAs(test, {
      source: "narrator",
      kind: "markUnseen",
      payload: { decisionId: card.id, planId: String(planId) },
    });
    if (marked.status !== "accepted") throw new Error(`mark refused: ${JSON.stringify(marked)}`);
  }
  acknowledge(test);
  const answered = answer(test, card.id, options.choose);
  if (answered.status !== "accepted") throw new Error(`refused: ${JSON.stringify(answered)}`);
  const events = step(test, 1);
  if (test.world.state.expedition?.plan === undefined) throw new Error("no plan adopted");
  return { test, events };
}

/**
 * Run to the resolution, invariants checked every tick, answering any card left (a turn card
 * presses on); returns the events. Stops early once `until` holds.
 */
export function runSneak(
  test: LandingWorld,
  seconds = 300,
  until: () => boolean = () => false,
): SimEvent[] {
  const rate = test.world.config.values.time.tickRate;
  const events: SimEvent[] = [];
  const end = test.world.state.tick + seconds * rate;
  const done = () => test.world.state.expedition?.phase === "resolved" || until();
  while (test.world.state.tick < end && !done()) {
    events.push(...step(test, end - test.world.state.tick, done));
    const head = test.world.state.decisions.queue[0];
    if (head === undefined) continue;
    const answered = answer(test, head, "left");
    if (answered.status !== "accepted")
      throw new Error(`card refused: ${JSON.stringify(answered)}`);
  }
  return events;
}
