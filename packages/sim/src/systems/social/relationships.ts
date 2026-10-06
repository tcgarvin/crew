/**
 * Relationships (slice 4, call 9; D88): directed memories in `social.relationships`, sparse.
 *
 * - `addMemory(ctx, from, to, key)`: `from` remembers `key` about `to` for the memory's
 *   `durationDays`. Below its `stackLimit` a new one is added; at the limit the one expiring
 *   soonest is refreshed instead, so repetition holds a memory's weight but never grows it.
 *   `affinityChanged` (trace) when `affinityOf` actually moved.
 * - `relationshipOf(ctx, from, to)`: the entry, created empty when absent (chat's `lastChatTick`).
 * - `pruneSocial(ctx)`: drops expired memories, entries (either side) and rivalries naming ids no
 *   longer in `actors`, and entries left with nothing in them.
 *
 * Owner: W2 of ship life slice 4.
 */
import { dayTicks } from "../../core/clock";
import { affinityOf } from "../../core/social";
import type { MemoryKey } from "../../core/types/content";
import type { ActorId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { Relationship } from "../../core/types/state";
import { emitSim } from "../work/events";

type SocialCtx = Pick<StepCtx, "state" | "config" | "emit" | "tick">;

function assertPair(ctx: SocialCtx, from: ActorId, to: ActorId, caller: string): void {
  if (from === to) throw new Error(`${caller}: ${from} cannot feel anything about themselves`);
  for (const id of [from, to]) {
    if (!(id in ctx.state.actors)) throw new Error(`${caller}: ${id} is not an actor`);
  }
}

/** The `from → to` entry, created with no memories when nothing has named the pair yet. */
export function relationshipOf(ctx: SocialCtx, from: ActorId, to: ActorId): Relationship {
  assertPair(ctx, from, to, "relationshipOf");
  const relationships = ctx.state.social.relationships;
  const row = relationships[from] ?? {};
  relationships[from] = row;
  const entry = row[to] ?? { memories: [] };
  row[to] = entry;
  return entry;
}

/**
 * `from` remembers `key` about `to` (see the module comment). Throws on a self-pair or an id not
 * in `actors`: every caller is the sim's own, so either is a bug.
 */
export function addMemory(ctx: SocialCtx, from: ActorId, to: ActorId, key: MemoryKey): void {
  const before = affinityOf(ctx.state, ctx.config.social, from, to);
  const def = ctx.config.social.memories[key];
  const expiresAtTick = ctx.tick + dayTicks(ctx.config, def.durationDays);
  const memories = relationshipOf(ctx, from, to).memories;
  const held = memories.filter((memory) => memory.key === key);
  if (held.length < def.stackLimit) {
    memories.push({ key, expiresAtTick });
  } else {
    const oldest = held.reduce((a, b) => (b.expiresAtTick < a.expiresAtTick ? b : a));
    oldest.expiresAtTick = Math.max(oldest.expiresAtTick, expiresAtTick);
  }
  const after = affinityOf(ctx.state, ctx.config.social, from, to);
  if (after === before) return;
  emitSim(ctx, "affinityChanged", [from, to], {
    fromActorId: from,
    toActorId: to,
    delta: after - before,
    affinity: after,
  });
}

/** Drop expired memories, ids no longer in `actors`, and entries with nothing left in them. */
export function pruneSocial(ctx: Pick<StepCtx, "state" | "tick">): void {
  const { actors, social } = ctx.state;
  for (const [from, row] of Object.entries(social.relationships)) {
    if (!(from in actors)) {
      delete social.relationships[from as ActorId];
      continue;
    }
    for (const [to, entry] of Object.entries(row)) {
      if (!(to in actors)) {
        delete row[to as ActorId];
        continue;
      }
      if (entry.memories.some((memory) => memory.expiresAtTick <= ctx.tick)) {
        entry.memories = entry.memories.filter((memory) => memory.expiresAtTick > ctx.tick);
      }
      if (entry.memories.length === 0 && entry.lastChatTick === undefined) {
        delete row[to as ActorId];
      }
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
