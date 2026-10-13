/**
 * Who sees a crew member hurt, and what it does to them (§strike-lever, §accidents-aboard): crew
 * who see a crewmate wounded take `sawCrewHurt` with them. In the fight that is the party on their
 * feet on the site floor with a line of sight, as for a shot's hit (`combat.ts`); aboard, the crew
 * on their feet in the same room.
 */
import { addThought } from "../../core/thoughts";
import type { Actor } from "../../core/types/actor";
import type { CompartmentId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import { groundOf, onSite, tileOfActor } from "../expedition/ground";
import { lineOfSight } from "../expedition/los";
import { upright } from "../expedition/morale";

type WitnessCtx = Pick<StepCtx, "state" | "content" | "caches">;

/** The room `actorId` stands in aboard, by the actor index. */
export function roomOf(ctx: WitnessCtx, actorId: Actor["id"]): CompartmentId | undefined {
  const index = ctx.caches.index.actorsByCompartment;
  for (const [room, ids] of Object.entries(index)) {
    if (ids.includes(actorId)) return room as CompartmentId;
  }
  return undefined;
}

/** The crew who see `hurt` hit (see the module comment). */
export function witnesses(ctx: WitnessCtx, hurt: Actor): Actor[] {
  const others = Object.values(ctx.state.actors).filter(
    (a) => a.id !== hurt.id && a.crew && a.passenger !== true && a.availability === "available",
  );
  const ground = hurt.combatant === undefined ? undefined : groundOf(ctx);
  if (ground !== undefined) {
    const at = tileOfActor(ctx.state, hurt);
    if (at === undefined) return [];
    return others.filter((friend) => {
      const c = friend.combatant;
      if (c?.side !== "us" || !upright(c) || !onSite(ctx, friend)) return false;
      const from = tileOfActor(ctx.state, friend);
      return from !== undefined && lineOfSight(ground.berth, from, at);
    });
  }
  const room = roomOf(ctx, hurt.id);
  if (room === undefined) return [];
  const here = ctx.caches.index.actorsByCompartment[room] ?? [];
  return others.filter((friend) => here.includes(friend.id));
}

/**
 * Every witness of `hurt`'s wound takes `sawCrewHurt` about them. Only a crew member's wound is
 * felt, and only when the content has the thought.
 */
export function witnessHurt(ctx: StepCtx, hurt: Actor): void {
  if (ctx.content.thoughts.sawCrewHurt === undefined) return;
  if (!hurt.crew || hurt.passenger === true) return;
  for (const friend of witnesses(ctx, hurt)) addThought(ctx, friend, "sawCrewHurt", hurt.id);
}
