/**
 * Needs invariants for tests (SD §19.4 style). D74: every berth is a bed on the ship's deck: a
 * placement there whose machine carries `bed` and not `medBed`. Keys being actors and no shared
 * beds are content-free and live in `core/invariants.ts` (`berthViolations`). D79: every mood is
 * in [-1, 1] and is the clamped sum of the live thoughts (`moodOf`).
 */
import { isBerthPlacement } from "../../core/berths";
import { moodOf } from "../../core/thoughts";
import type { World } from "../../core/types/kernel";
import { shipDeckId } from "../../core/world";

/** Rounding slack between a mood summed now and one summed when it was written. */
const MOOD_EPSILON = 1e-9;

export function needsViolations(world: Pick<World, "state" | "content">): string[] {
  return [...moodViolations(world), ...berthViolations(world)];
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
