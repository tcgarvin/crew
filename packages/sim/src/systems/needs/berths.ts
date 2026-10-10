/**
 * §berth-assignment: the berth rule as a needs-stage system. `assignBerths` (`core/berths.ts`) runs
 * every tick so that a passenger coming aboard, a crew member the narrator adds, a death or a
 * departure is settled within a tick, with no event to hook. It is a no-op once everyone is
 * berthed.
 */
import { assignBerths } from "../../core/berths";
import type { System } from "../../core/types/pipeline";
import { shipDeckId } from "../../core/world";

export const berthsSystem: System = {
  name: "needs.berths",
  phase: "needs",
  run(ctx) {
    const deck = ctx.content.decks[shipDeckId(ctx.state)];
    if (deck === undefined) throw new Error("needs.berths: the ship's deck is not in content");
    assignBerths(ctx.state, deck, ctx.content);
  },
};
