/**
 * Needs invariants for tests (SD §19.4 style). §berth-assignment: every berth is a bed on the
 * ship's deck: a placement there whose machine carries `bed` and not `medBed`. Keys being actors
 * and no shared beds are content-free and live in `core/invariants.ts` (`berthViolations`).
 * §mood-and-work-speed: every mood is in [-1, 1] and is the clamped sum of the live thoughts
 * (`moodOf`). §memories: every memory's key is config's and none is held past its stack limit
 * (expiries and actor keys are `core/invariants.ts`'s), every
 * rivalry row is a well-formed tally under a well-formed key, and the captain's table day is a
 * whole day or -1.
 */
import { isBerthPlacement } from "../../core/berths";
import { moodOf } from "../../core/thoughts";
import type { MemoryKey } from "../../core/types/content";
import type { World } from "../../core/types/kernel";
import { shipDeckId } from "../../core/world";

/** Rounding slack between a mood summed now and one summed when it was written. */
const MOOD_EPSILON = 1e-9;

export function needsViolations(world: Pick<World, "state" | "content" | "config">): string[] {
  return [...moodViolations(world), ...berthViolations(world), ...socialViolations(world)];
}

function moodViolations({ state }: Pick<World, "state">): string[] {
  const out: string[] = [];
  for (const actor of Object.values(state.actors)) {
    if (!Number.isFinite(actor.mood) || actor.mood < -1 || actor.mood > 1) {
      out.push(`actors.${actor.id}.mood ${actor.mood} is outside [-1, 1]`);
      continue;
    }
    const expected = moodOf(actor, state.tick);
    if (Math.abs(actor.mood - expected) > MOOD_EPSILON) {
      out.push(`actors.${actor.id}.mood ${actor.mood} is not its thoughts' ${expected}`);
    }
  }
  return out;
}

function berthViolations(world: Pick<World, "state" | "content">): string[] {
  const { state, content } = world;
  const entries = Object.entries(state.berths);
  if (entries.length === 0) return [];
  const deckId = shipDeckId(state);
  const deck = content.decks[deckId];
  if (deck === undefined) return [`berths: ship deck ${deckId} is not in content`];
  const out: string[] = [];
  for (const [actorId, key] of entries) {
    const placement = deck.machines.find((p) => p.key === key);
    if (placement === undefined) {
      out.push(`berths.${actorId} "${key}" is no placement on ${deckId}`);
    } else if (!isBerthPlacement(content, placement)) {
      out.push(`berths.${actorId} "${key}" is not a bed`);
    }
  }
  return out;
}

function socialViolations({ state, config }: Pick<World, "state" | "config">): string[] {
  const out: string[] = [];
  const memories = config.values.social.memories;
  for (const [from, row] of Object.entries(state.social.relationships)) {
    for (const [to, relationship] of Object.entries(row)) {
      const counts = new Map<string, number>();
      for (const memory of relationship.memories) {
        counts.set(memory.key, (counts.get(memory.key) ?? 0) + 1);
      }
      for (const [key, count] of counts) {
        const def = memories[key as MemoryKey];
        if (def === undefined || count > def.stackLimit) {
          out.push(`social.relationships.${from}.${to} holds ${count} of ${key}`);
        }
      }
    }
  }
  for (const [key, rivalry] of Object.entries(state.social.rivalries)) {
    out.push(...rivalryViolations(key, rivalry));
  }
  const day = state.social.captainsTableDay;
  if (!Number.isInteger(day) || day < -1) out.push(`social.captainsTableDay is ${day}`);
  return out;
}

/**
 * A rivalry key is `<a>|<b>|<activityId>` with `a < b`; wins and losses are whole and not
 * negative, and the streak is a run no longer than that side's count.
 */
function rivalryViolations(
  key: string,
  rivalry: World["state"]["social"]["rivalries"][string],
): string[] {
  const out: string[] = [];
  const where = `social.rivalries.${key}`;
  const [a, b, activityId] = key.split("|");
  if (a === undefined || b === undefined || activityId === undefined || !(a < b)) {
    out.push(`${where} is not "<a>|<b>|<activity>" with a < b`);
  }
  const { wins, losses, streak } = rivalry;
  if (!Number.isInteger(wins) || wins < 0) out.push(`${where}.wins is ${wins}`);
  if (!Number.isInteger(losses) || losses < 0) out.push(`${where}.losses is ${losses}`);
  if (!Number.isInteger(streak) || streak > wins || -streak > losses) {
    out.push(`${where}.streak ${streak} does not fit ${wins}–${losses}`);
  }
  return out;
}
