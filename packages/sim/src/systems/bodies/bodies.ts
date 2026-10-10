/**
 * Expeditions A1 (§7.1): the bodies system, phase `needs` after `needs.needs`. Bleeding, blood,
 * pain, stun and healing over time; incapacitation and death re-checked (blood loss kills later
 * than the shot); recovery; the `wounded` thought while a wound is open; and capacities for
 * everyone needs does not step (plan call 5: non-crew, and crew who are not `available`).
 *
 * Gate stub: capacities only, so a whole body stays whole and nothing else changes.
 *
 * Owner: W1 of expeditions A1.
 */
import { applyCapacities } from "../../core/body";
import type { System } from "../../core/types/pipeline";

export const bodiesSystem: System = {
  name: "bodies.bodies",
  phase: "needs",
  run(ctx) {
    for (const actor of Object.values(ctx.state.actors)) {
      // Call 5: needs writes capacities for the crew it steps; this covers everyone else.
      if (actor.crew && actor.availability === "available") continue;
      applyCapacities(actor, ctx.config);
    }
  },
};
