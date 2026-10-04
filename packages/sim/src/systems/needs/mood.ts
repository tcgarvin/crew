/**
 * Mood (D79), phase `needs`, every tick: prune expired thoughts and write `actor.mood` from the
 * live ones (`core/thoughts.ts` `moodOf`).
 *
 * Owner: W3 of ship life slice 2. Gate B stub: nothing yet (nothing raises a thought before W1
 * and W3), so every mood stays where it was spawned.
 */
import type { System } from "../../core/types/pipeline";

export const moodSystem: System = {
  name: "needs.mood",
  phase: "needs",
  run() {},
};
