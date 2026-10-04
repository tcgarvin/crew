/**
 * Work systems (W4a): execution (phase 3), minimal perception and ambient chat (phase 6), task
 * derivation and claim expiry (phase 7, before the planner).
 */
import type { StepCtx, System } from "../../core/types/pipeline";
import type { TaskDerivationRegistry } from "./derivation";
import { runDerivation } from "./derivation";
import { expireClaims, stepActor } from "./execute";
import type { WorkDeps } from "./steps";

export const DERIVATION_EVERY_TICKS = 10;

export function createExecutionSystem(deps: WorkDeps): System {
  return {
    name: "work.execute",
    phase: "actions",
    run(ctx: StepCtx) {
      for (const actor of Object.values(ctx.state.actors)) {
        if (actor.crew) stepActor(ctx, deps, actor);
      }
    },
  };
}

export function createDerivationSystem(rules: TaskDerivationRegistry): System {
  return {
    name: "work.derivation",
    phase: "planning",
    every: DERIVATION_EVERY_TICKS,
    run(ctx: StepCtx) {
      expireClaims(ctx);
      runDerivation(ctx, rules);
    },
  };
}
