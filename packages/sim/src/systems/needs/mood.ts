/**
 * Mood (D79), phase `needs`, every tick: drop every actor's expired thoughts and write
 * `actor.mood` from the live ones (`core/thoughts.ts` `moodOf`). `addThought` keeps mood current
 * between runs; this is where thoughts wear off.
 */
import { moodOf, thoughtLive } from "../../core/thoughts";
import type { System } from "../../core/types/pipeline";

export const moodSystem: System = {
  name: "needs.mood",
  phase: "needs",
  run(ctx) {
    for (const actor of Object.values(ctx.state.actors)) {
      if (actor.thoughts.some((thought) => !thoughtLive(thought, ctx.tick))) {
        actor.thoughts = actor.thoughts.filter((thought) => thoughtLive(thought, ctx.tick));
      }
      const mood = moodOf(actor, ctx.tick);
      if (actor.mood !== mood) actor.mood = mood;
    }
  },
};
