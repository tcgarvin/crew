/**
 * Thoughts and mood (D79). Owner: W3 of ship life slice 2. Gate B stub: `addThought` appends a
 * thought from its def (W3 adds the non-stacking refresh), `moodOf` is the clamped sum of the
 * thoughts held (W3 counts only unexpired ones; the needs-phase `moodSystem` prunes), and
 * `moodWorkFactor` is 1 until W3 wires `config.mood`.
 */
import { dayTicks } from "./clock";
import type { Actor } from "./types/actor";
import type { DeepReadonly } from "./types/common";
import type { ConfigDef, ThoughtKey } from "./types/content";
import type { EntityId } from "./types/ids";
import type { StepCtx } from "./types/pipeline";

export type ThoughtCtx = Pick<StepCtx, "content" | "config" | "tick" | "emit">;

/** Give `actor` the thought `key` (about `refId`, if given). Throws on a key content lacks. */
export function addThought(ctx: ThoughtCtx, actor: Actor, key: ThoughtKey, refId?: EntityId): void {
  const def = ctx.content.thoughts[key];
  if (def === undefined) throw new Error(`addThought: content has no thought "${key}"`);
  actor.thoughts.push({
    key,
    value: def.value,
    expiresAtTick: ctx.tick + dayTicks(ctx.config, def.durationDays),
    ...(refId === undefined ? {} : { refId }),
  });
  ctx.emit({
    type: "thoughtAdded",
    subjectIds: [actor.id],
    causeIds: [],
    source: "sim",
    payload: { actorId: actor.id, key },
  });
}

/** Mood: the sum of the thoughts' values, clamped to [-1, 1]. */
export function moodOf(actor: DeepReadonly<Pick<Actor, "thoughts">>): number {
  const sum = actor.thoughts.reduce((total, thought) => total + thought.value, 0);
  return Math.min(1, Math.max(-1, sum));
}

/** Work speed multiplier from mood. Stub: 1 (W3 applies `config.mood`). */
export function moodWorkFactor(
  _actor: DeepReadonly<Pick<Actor, "mood">>,
  _config: ConfigDef,
): number {
  return 1;
}
