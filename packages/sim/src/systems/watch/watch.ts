/**
 * The watch system (D77), phase `needs`, every tick: rings the bell when the watch changes.
 *
 * Owner: W1 of ship life slice 2, who adds the helm's bookkeeping here (the `watch` and `relief`
 * posts, vacancy and `helmUnattended`, the long-watch thoughts). Gate B: the bell only.
 */
import { watchIndexAt, watchOfDay } from "../../core/clock";
import type { System } from "../../core/types/pipeline";
import { watchBillOf } from "./bill";

export const watchSystem: System = {
  name: "watch",
  phase: "needs",
  run(ctx) {
    const watchIndex = watchIndexAt(ctx.config, ctx.tick);
    if (watchIndex === ctx.state.watch.lastBellWatch) return;
    ctx.state.watch.lastBellWatch = watchIndex;
    const ofDay = watchOfDay(ctx.config, ctx.tick);
    const sectionKey = watchBillOf(ctx.state).sections.find((s) => s.index === ofDay)?.key;
    ctx.emit({
      type: "bell",
      subjectIds: [],
      causeIds: [],
      source: "sim",
      payload: { watchIndex, ...(sectionKey === undefined ? {} : { sectionKey }) },
    });
  },
};
