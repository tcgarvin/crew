/**
 * Shared setup for the worker's real-content sim tests: the authored bundle on the full V1
 * registry, and the every-tick check of every invariant those runs assert.
 */
import type { Actor, World } from "@crew/sim";
import {
  checkInvariants,
  commerceViolations,
  createKernel,
  spatialViolations,
  travelViolations,
  workViolations,
} from "@crew/sim";
import { loadWebContent } from "./content";
import { createFullRegistry } from "./registry";

/** A new game of the web client's scenario on the real content, every system registered. */
export function newGame(seed: number) {
  const { bundle, config, scenarioId } = loadWebContent();
  const kernel = createKernel(createFullRegistry());
  const world = kernel.createWorld(scenarioId, seed, bundle, config);
  return { bundle, kernel, world };
}

/** Throws with the first few violations when any invariant (commerce included) fails. */
export function assertInvariants(world: World): void {
  const violations = [
    ...checkInvariants(world.state),
    ...spatialViolations(world),
    ...workViolations(world),
    ...travelViolations(world),
    ...commerceViolations(world),
  ];
  if (violations.length > 0) {
    throw new Error(`tick ${world.state.tick}: ${violations.slice(0, 5).join("; ")}`);
  }
}

export function captainOf(world: World): Actor {
  const captain = Object.values(world.state.actors).find((a) => a.roleTags.includes("captain"));
  if (captain === undefined) throw new Error("no captain");
  return captain;
}
