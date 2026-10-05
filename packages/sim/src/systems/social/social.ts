/**
 * The social system (slice 4), phase `needs`, every 100 ticks: `pruneSocial` (a passenger who
 * walked off leaves no relationships behind).
 *
 * Owner: W2 of ship life slice 4. Gate stub: a no-op.
 */
import type { System } from "../../core/types/pipeline";

export const SOCIAL_EVERY_TICKS = 100;

export const socialSystem: System = {
  name: "social",
  phase: "needs",
  every: SOCIAL_EVERY_TICKS,
  run() {},
};
