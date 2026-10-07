/**
 * D93, D94: damage response, every tick in the `needs` phase (after cabins): on alert,
 * recreation ends; `compartmentToCheck` raised for each compartment unreported since the last
 * impact while the officer of the watch holds the bridge, and resolved by a report or a scout's
 * arrival; `hullDamaged` raised and revised while docked at a port selling plating; a scar's
 * problem back to routine when the alert clears.
 *
 * Gate stub: nothing.
 *
 * Owner: W2 of ship life slice 5.
 */
import type { System } from "../../core/types/pipeline";

export const damageSystem: System = {
  name: "damage.response",
  phase: "needs",
  run() {},
};
