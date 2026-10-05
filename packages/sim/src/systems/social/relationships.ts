/**
 * Relationships (slice 4, call 9): directed affinity in `social.relationships`, sparse.
 *
 * - `moveAffinity(ctx, from, to, delta)`: what `from` feels about `to` moves by `delta`, an
 *   integer, clamped to `±social.affinityRange`; the entry is created on the first move;
 *   `affinityChanged` (trace) when the value actually changed.
 * - `relationshipOf(ctx, from, to)`: the entry, created at 0 when absent (chat's `lastChatTick`).
 * - `pruneSocial(ctx)`: drops entries (either side) and rivalries for ids no longer in `actors`.
 *
 * Owner: W2 of ship life slice 4.
 */
import type { ActorId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { Relationship } from "../../core/types/state";
import { emitSim } from "../work/events";

type SocialCtx = Pick<StepCtx, "state" | "config" | "emit">;

function assertPair(ctx: SocialCtx, from: ActorId, to: ActorId, caller: string): void {
  if (from === to) throw new Error(`${caller}: ${from} cannot feel anything about themselves`);
  for (const id of [from, to]) {
    if (!(id in ctx.state.actors)) throw new Error(`${caller}: ${id} is not an actor`);
  }
}

/** The `from → to` entry, created at affinity 0 when nothing has moved it yet. */
export function relationshipOf(ctx: SocialCtx, from: ActorId, to: ActorId): Relationship {
  assertPair(ctx, from, to, "relationshipOf");
  const relationships = ctx.state.social.relationships;
  const row = relationships[from] ?? {};
  relationships[from] = row;
  const entry = row[to] ?? { affinity: 0 };
  row[to] = entry;
  return entry;
}

/**
 * `from`'s feeling about `to` moves by `delta` (an integer; 0 does nothing), clamped to
 * `±social.affinityRange`. Throws on a non-integer delta, a self-pair or an id not in `actors`:
 * every caller is the sim's own, so either is a bug.
 */
export function moveAffinity(ctx: SocialCtx, from: ActorId, to: ActorId, delta: number): void {
  if (!Number.isInteger(delta)) throw new RangeError(`moveAffinity: delta ${delta} is not whole`);
  if (delta === 0) return;
  const entry = relationshipOf(ctx, from, to);
  const range = ctx.config.social.affinityRange;
  const before = entry.affinity;
  entry.affinity = Math.max(-range, Math.min(range, before + delta));
  if (entry.affinity === before) return;
  emitSim(ctx, "affinityChanged", [from, to], {
    fromActorId: from,
    toActorId: to,
    delta: entry.affinity - before,
    affinity: entry.affinity,
  });
}

/** Drop relationship entries and rivalries naming anyone no longer in `actors`. */
export function pruneSocial(ctx: Pick<StepCtx, "state">): void {
  const { actors, social } = ctx.state;
  for (const [from, row] of Object.entries(social.relationships)) {
    if (!(from in actors)) {
      delete social.relationships[from as ActorId];
      continue;
    }
    for (const to of Object.keys(row)) {
      if (!(to in actors)) delete row[to as ActorId];
    }
    if (Object.keys(row).length === 0) delete social.relationships[from as ActorId];
  }
  for (const key of Object.keys(social.rivalries)) {
    const [a, b] = key.split("|");
    if (a === undefined || b === undefined || !(a in actors) || !(b in actors)) {
      delete social.rivalries[key];
    }
  }
}
