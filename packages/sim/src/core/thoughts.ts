/**
 * Thoughts and mood (§thoughts). A thought is something on a person's mind for a while; mood is the
 * clamped sum of the live ones, and its only effect yet is work speed (`moodWorkFactor`).
 *
 * `addThought` gives one (a non-stacking key refreshes the one already held; a stacking key adds
 * another) and brings `actor.mood` up to date at once, so a thought had after the needs phase
 * still leaves mood equal to `moodOf` at the end of the tick (`needsViolations`). The needs-phase
 * `moodSystem` (`systems/needs/mood.ts`) prunes expired thoughts and recomputes the rest.
 */
import { dayTicks } from "./clock";
import type { Actor, Thought } from "./types/actor";
import type { DeepReadonly, Tick } from "./types/common";
import type { ConfigDef, ThoughtKey } from "./types/content";
import type { EntityId } from "./types/ids";
import type { StepCtx } from "./types/pipeline";

export type ThoughtCtx = Pick<StepCtx, "content" | "config" | "tick" | "emit">;

/** A thought still counts at `tick` (`expiresAtTick` is the first tick it does not). */
export function thoughtLive(thought: DeepReadonly<Thought>, tick: Tick): boolean {
  return thought.expiresAtTick > tick;
}

/**
 * Give `actor` the thought `key` (about `refId`, if given), from its content def. A def that does
 * not stack refreshes the expiry of the thought with the same key and `refId` when one is held
 * (keeping its value: the value is fixed when first had); otherwise a new thought is added.
 * Throws on a key content lacks.
 */
export function addThought(ctx: ThoughtCtx, actor: Actor, key: ThoughtKey, refId?: EntityId): void {
  const def = ctx.content.thoughts[key];
  if (def === undefined) throw new Error(`addThought: content has no thought "${key}"`);
  const expiresAtTick = ctx.tick + dayTicks(ctx.config, def.durationDays);
  const held = def.stacks
    ? undefined
    : actor.thoughts.find((thought) => thought.key === key && thought.refId === refId);
  if (held === undefined) {
    actor.thoughts.push({
      key,
      value: def.value,
      expiresAtTick,
      ...(refId === undefined ? {} : { refId }),
    });
  } else {
    held.expiresAtTick = Math.max(held.expiresAtTick, expiresAtTick);
  }
  actor.mood = moodOf(actor, ctx.tick);
  ctx.emit({
    type: "thoughtAdded",
    subjectIds: [actor.id],
    causeIds: [],
    source: "sim",
    payload: { actorId: actor.id, key },
  });
}

/** Mood at `tick`: the sum of the live thoughts' values, clamped to [-1, 1]. */
export function moodOf(actor: DeepReadonly<Pick<Actor, "thoughts">>, tick: Tick): number {
  let sum = 0;
  for (const thought of actor.thoughts) {
    if (thoughtLive(thought, tick)) sum += thought.value;
  }
  return Math.min(1, Math.max(-1, sum));
}

/**
 * Work speed multiplier from mood (`config.mood`): `lowWorkSpeed` below `lowBelow`,
 * `highWorkSpeed` above `highAbove`, else 1.
 */
export function moodWorkFactor(
  actor: DeepReadonly<Pick<Actor, "mood">>,
  config: ConfigDef,
): number {
  const { lowBelow, highAbove, lowWorkSpeed, highWorkSpeed } = config.mood;
  if (actor.mood < lowBelow) return lowWorkSpeed;
  if (actor.mood > highAbove) return highWorkSpeed;
  return 1;
}
