/**
 * §going-down-and-death, §grief: dying. One rule for `applyDamage` (a hit that kills) and the
 * bodies system (blood loss): the body goes down for good (`goDown`), `died` is emitted, and the
 * ship's company grieve a crewmate.
 *
 * Grief: when a serving crew member dies (not a passenger, not a site's cast), every other living
 * crew member who is not a passenger, aboard or ashore, has `grieving` about them (`refId` the
 * dead); those whose affinity for them (`affinityOf`, §affinity) is at least
 * `medical.griefCloseAffinity` have it `medical.griefStacksClose` times (the thought stacks).
 */
import { affinityOf } from "../../core/social";
import { addThought } from "../../core/thoughts";
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly } from "../../core/types/common";
import type { ActorId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import { emitSim } from "../work/events";
import { goDown, woundCause } from "./down";

/** Kill `actor` now: down for good, `died` (blamed on `byActorId` when someone did it), grief. */
export function die(ctx: StepCtx, actor: Actor, byActorId: ActorId | undefined): void {
  goDown(ctx, actor, "dead");
  emitSim(ctx, "died", byActorId === undefined ? [actor.id] : [actor.id, byActorId], {
    actorId: actor.id,
    cause: woundCause(actor.body, ctx.config),
    ...(byActorId === undefined ? {} : { byActorId }),
  });
  grieve(ctx, actor);
}

/** A member of the ship's company: crew, not a passenger. */
export const shipsCompany = (actor: DeepReadonly<Pick<Actor, "crew" | "passenger">>): boolean =>
  actor.crew && actor.passenger !== true;

/** §grief: the living crew grieve `dead`, the close among them more. */
export function grieve(ctx: StepCtx, dead: DeepReadonly<Actor>): void {
  if (!shipsCompany(dead)) return;
  const { griefCloseAffinity, griefStacksClose } = ctx.config.medical;
  const mourners = Object.values(ctx.state.actors)
    .filter((a) => a.id !== dead.id && a.availability !== "dead" && shipsCompany(a))
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  for (const mourner of mourners) {
    const close =
      affinityOf(ctx.state, ctx.config.social, mourner.id, dead.id) >= griefCloseAffinity;
    const stacks = close ? griefStacksClose : 1;
    for (let i = 0; i < stacks; i++) addThought(ctx, mourner, "grieving", dead.id);
  }
}
