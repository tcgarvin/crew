/**
 * Expeditions A1 (§8.6): labels for the muster and the fight, read by `systems/work/labels.ts`.
 * The muster: "going to the arms locker", "arming", "going ashore to the site". The fight's
 * labels ("in cover", "firing", "advancing", "wavering", "running", "down", "dragging <name>",
 * "surrendered") are the combat system's, written on the `fight` activity's `label` as it decides;
 * `fightLabel` is what reads when none is written.
 *
 * Owner after the gate: W2 of expeditions A1.
 */
import { findItemDef } from "../../core/defs";
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly } from "../../core/types/common";
import type { ActivityStep } from "../../core/types/work";
import type { LabelCtx } from "../work/labels";

/** Does `actor` have a weapon in hand? */
function armed(ctx: LabelCtx, actor: DeepReadonly<Actor>): boolean {
  return Object.values(ctx.state.items).some(
    (item) =>
      item.location.kind === "carriedBy" &&
      item.location.actorId === actor.id &&
      findItemDef(ctx.content, ctx.state, item.defId)?.weapon !== undefined,
  );
}

/** The muster's label by step: to the locker, at it, then down the ramp. */
export function musterLabel(
  ctx: LabelCtx,
  actor: DeepReadonly<Actor>,
  step: DeepReadonly<ActivityStep>,
): string {
  if (step.kind === "work") return "arming";
  return armed(ctx, actor) ? "going ashore to the site" : "going to the arms locker";
}

/** A fighter's label from their combatant state, when the combat system wrote none. */
export function fightLabel(_ctx: LabelCtx, actor: DeepReadonly<Actor>): string {
  switch (actor.combatant?.state) {
    case "wavering":
      return "wavering";
    case "breaking":
    case "fled":
      return "running";
    case "surrendered":
      return "surrendered";
    case "down":
      return "down";
    case "dead":
      return "dead";
    default:
      return "in the fight";
  }
}
