import type { TestWorld } from "../../../core/fixtures/test-world";
/**
 * Expeditions A1 test helpers over the site fixture: start an expedition with a plan, run it to
 * its resolution (acknowledging hooks as a host would), and read back what happened.
 */
import { bodyViolations, checkInvariants, expeditionViolations } from "../../../core/invariants";
import type { SiteCastEntryDef } from "../../../core/types/content";
import type { SimEvent } from "../../../core/types/events";
import type { CommandId } from "../../../core/types/ids";
import { travelViolations } from "../../travel/invariants";
import { SITE, send } from "./site";

let acks = 0;

/** Start the expedition at the test site under `plan` (and `cast`, else the map's). */
export function startExpedition(
  test: TestWorld,
  plan: string | undefined,
  cast?: readonly SiteCastEntryDef[],
) {
  const result = send(test, {
    kind: "scenarioStartExpedition",
    payload: {
      siteId: SITE.port,
      ...(plan === undefined ? {} : { plan }),
      ...(cast === undefined ? {} : { cast }),
    },
  });
  if (result.status !== "accepted") throw new Error(`start refused: ${JSON.stringify(result)}`);
  return result;
}

/** Every invariant the fight touches. */
export function violations(test: TestWorld): string[] {
  return [
    ...checkInvariants(test.world.state),
    ...travelViolations(test.world),
    ...bodyViolations(test.world),
    ...expeditionViolations(test.world),
  ];
}

/**
 * Advance `ticks` (in steps of `step`), acknowledging hooks; returns the events. Stops early
 * once `until` holds. Checks the invariants at every step when `check` is set.
 */
export function run(
  test: TestWorld,
  ticks: number,
  options: {
    readonly until?: () => boolean;
    readonly step?: number;
    readonly check?: boolean;
  } = {},
): SimEvent[] {
  const events: SimEvent[] = [];
  const step = options.step ?? 10;
  for (let t = 0; t < ticks; t += step) {
    const result = test.kernel.advance(test.world, step);
    events.push(...result.events);
    if (options.check === true) {
      const found = violations(test);
      if (found.length > 0) throw new Error(`tick ${test.world.state.tick}: ${found.join("; ")}`);
    }
    const hookId = test.world.state.narrator.pendingHook?.id;
    if (hookId !== undefined) {
      acks += 1;
      test.kernel.enqueueCommand(test.world, {
        id: `cmd:fight:ack:${acks}` as CommandId,
        source: "system",
        kind: "acknowledgeHook",
        payload: { hookId },
      });
    }
    if (options.until?.() === true) break;
  }
  return events;
}

/** Run until the expedition resolves (or `seconds` pass). */
export function runToResolution(test: TestWorld, seconds = 400, check = false): SimEvent[] {
  const rate = test.world.config.values.time.tickRate;
  return run(test, seconds * rate, {
    until: () => test.world.state.expedition?.phase === "resolved",
    check,
  });
}
