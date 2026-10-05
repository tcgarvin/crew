/**
 * The cabins system (slice 4, call 14), phase `needs`, every tick: advances a sleep hold's
 * `disturbedTicks` while anyone awake shares the sleeper's compartment
 * (`caches.index.actorsByCompartment`); gives `noBunkOfMyOwn` every `cabins.checkEverySeconds` to
 * crew with no `berths` entry; times out a `privateTalk` not held by `requestedTick +
 * privateTalkWaitSeconds` (`privateTalkMissed`, both steps fail `dependencyPending`).
 *
 * `onWoke(ctx, actor)`, called from `systems/work/execute.ts` `leaveHold` when a sleep hold
 * completes (not when it is interrupted), with the hold still the current step: `ownCabin` when
 * they slept in their own berth in a `cabin`-tagged compartment; `noisyBunkroom` in a `quarters`
 * compartment with `disturbedTicks` past `cabins.noisySeconds`.
 *
 * Owner: W3 of ship life slice 4. Gate stubs: both no-ops.
 */
import type { Actor } from "../../core/types/actor";
import type { StepCtx, System } from "../../core/types/pipeline";

export const cabinsSystem: System = {
  name: "cabins",
  phase: "needs",
  run() {},
};

export function onWoke(_ctx: StepCtx, _actor: Actor): void {}
