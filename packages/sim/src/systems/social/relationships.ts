/**
 * Relationships (slice 4, call 9): directed affinity in `social.relationships`, sparse.
 *
 * - `moveAffinity(ctx, from, to, delta)`: what `from` feels about `to` moves by `delta`, an
 *   integer, clamped to `±social.affinityRange`; the entry is created on the first move;
 *   `affinityChanged` (trace).
 * - `pruneSocial(ctx)`: drops entries (either side) and rivalries for ids no longer in `actors`.
 *
 * Owner: W2 of ship life slice 4. Gate stubs: both no-ops.
 */
import type { ActorId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";

export function moveAffinity(_ctx: StepCtx, _from: ActorId, _to: ActorId, _delta: number): void {}

export function pruneSocial(_ctx: StepCtx): void {}
