/**
 * Expeditions A1 (§7.1): going down. One rule for `applyDamage` and the bodies system: someone
 * incapacitated or dead stops what they were doing, stops where they are, and lets go of what is
 * in their hands (it lands on the deck at their tile, as a hauler's cargo does).
 *
 * Owner: W1 of expeditions A1.
 */
import type { Actor, Body } from "../../core/types/actor";
import type { DeepReadonly } from "../../core/types/common";
import type { ConfigDef } from "../../core/types/content";
import type { StepCtx } from "../../core/types/pipeline";
import { tileOf } from "../spatial/movement";
import { releaseReservations } from "../spatial/reservations";
import { abortActivity } from "../work/execute";
import { seeItem } from "../work/facts";
import { touchInventory } from "../work/steps";

/** Take `actor` down: `incapacitated` or `dead`. */
export function goDown(ctx: StepCtx, actor: Actor, to: "incapacitated" | "dead"): void {
  abortActivity(ctx, actor, "incapacitated");
  // A route mid-segment would only be cut at the next tile centre, and spatial moves nobody who
  // is not available: they fall where they are.
  if (actor.movement.kind === "moving") {
    releaseReservations(ctx.caches, actor.id);
    actor.movement = { kind: "stationary" };
  }
  actor.availability = to;
  dropWhatIsInHand(ctx, actor);
}

/** Items carried or held in the hands go on the deck at their tile; off deck, they stay put. */
function dropWhatIsInHand(ctx: StepCtx, actor: Actor): void {
  const location = actor.location;
  if (location.kind !== "onDeck") return;
  const tile = tileOf(location);
  let dropped = false;
  for (const item of Object.values(ctx.state.items)) {
    const held = item.location;
    const inHand =
      (held.kind === "carriedBy" && held.actorId === actor.id) ||
      (held.kind === "equippedBy" && held.actorId === actor.id && held.slot === "hands");
    if (!inHand) continue;
    item.location = { kind: "onDeck", deckId: location.deckId, x: tile.x + 0.5, y: tile.y + 0.5 };
    seeItem(actor, item.id, item.location, ctx.tick);
    dropped = true;
  }
  if (dropped) touchInventory(ctx);
}

/** What killed a dead body: a head or torso past tolerance is the wound; otherwise blood. */
export function woundCause(
  body: DeepReadonly<Body>,
  config: Pick<ConfigDef, "bodies">,
): "wound" | "blood" {
  const { tolerance } = config.bodies;
  return body.parts.head.damage >= tolerance.head || body.parts.torso.damage >= tolerance.torso
    ? "wound"
    : "blood";
}
