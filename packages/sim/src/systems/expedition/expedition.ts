/**
 * Expeditions A1 (§8): the expedition system, phase `actions`, registered before work so it runs
 * after spatial and before `work.execute` (registration order within a phase). It owns the
 * phases (`mustering` → `walkingOut` → `approach` → `fight` → `resolved`), hands out the muster
 * (`muster.ts`), runs the fight (`combat.ts`), and resolves it: the outcome and its tally
 * (`expeditionResolved`), the alert stood down `alertClearSeconds` later, thoughts and memories,
 * the `fight` activities cleared and the cast's survivors gone.
 *
 * Gate stub: only an expedition that is on reaches the muster and the combat loop, both no-ops.
 * `orderWithdrawal` (the `withdrawParty` command) is complete.
 *
 * Owner after the gate: W2 of expeditions A1.
 */
import type { EventDraft } from "../../core/types/events";
import type { StepCtx, System } from "../../core/types/pipeline";
import { runCombat } from "./combat";
import { handOutMuster } from "./muster";

export const expeditionSystem: System = {
  name: "expedition.expedition",
  phase: "actions",
  run(ctx) {
    const expedition = ctx.state.expedition;
    if (expedition === undefined || expedition.phase === "resolved") return;
    handOutMuster(ctx);
    runCombat(ctx);
  },
};

/**
 * §8.3 `withdrawWhen`, or the captain's order: every party member still fighting breaks for the
 * ramp foot, and `partyWithdrew` says so once.
 */
export function orderWithdrawal(
  ctx: Pick<StepCtx, "state" | "emit">,
  cause: Pick<EventDraft, "causeIds" | "source"> = { causeIds: [], source: "sim" },
): void {
  const expedition = ctx.state.expedition;
  if (expedition === undefined) return;
  for (const id of expedition.party) {
    const combatant = ctx.state.actors[id]?.combatant;
    if (combatant === undefined) continue;
    if (combatant.state === "steady" || combatant.state === "wavering") {
      combatant.state = "breaking";
    }
  }
  ctx.emit({
    type: "partyWithdrew",
    subjectIds: [...expedition.party],
    ...cause,
    payload: {},
  });
}
