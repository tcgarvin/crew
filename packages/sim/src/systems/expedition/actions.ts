/**
 * Expeditions A1 (§8.1): the seven actions a combatant can take (`takeCover`, `advance`, `fire`,
 * `melee`, `guardPassage`, `retreat`, `rescue`), each driving movement through
 * `systems/spatial/movement.ts` `requestMove`/`stopMovement` and labelling the `fight` activity.
 *
 * Gate stub: the action names only.
 *
 * Owner after the gate: W2 of expeditions A1.
 */

export const COMBAT_ACTIONS = [
  "takeCover",
  "advance",
  "fire",
  "melee",
  "guardPassage",
  "retreat",
  "rescue",
] as const;
export type CombatAction = (typeof COMBAT_ACTIONS)[number];
