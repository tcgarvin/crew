/**
 * Expeditions A1 (§7.1): the one damage entry point. `applyDamage` picks the part (`hit.part`,
 * else `hit.partTable`, else `config.bodies.partTable`, or `stunPartTable` for a stun hit, on the
 * `failures` stream), writes the wound, adds damage and pain (a stun hit adds `stunPerHit` to
 * `body.stun` instead), recomputes capacities, then commits death (`isDeadBy`) or incapacitation
 * (`incapacityOf`) at once, dropping what is in hand, and emits `wounded` (always), then `died` or
 * `incapacitated`.
 *
 * Gate stub: throws `NotImplementedError`. The combat system's tests install a double until W1
 * lands.
 *
 * Owner: W1 of expeditions A1.
 */
import { NotImplementedError } from "../../core/registry";
import type { BodyPart, DamageType, WoundSeverity } from "../../core/types/content";
import type { ActorId, WoundId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";

/** One hit on a body. */
export interface Hit {
  /** Where it lands; absent, drawn from `partTable` (or the config's tables). */
  readonly part?: BodyPart;
  readonly severity: WoundSeverity;
  readonly type: DamageType;
  /** Who did it, when someone did. */
  readonly byActorId?: ActorId;
  /** Relative weights for where it lands; absent, the config's (`partTable`/`stunPartTable`). */
  readonly partTable?: Readonly<Record<BodyPart, number>>;
}

/** What a hit did: the wound it made and whether it took the person down or killed them. */
export interface DamageResult {
  readonly woundId: WoundId;
  readonly part: BodyPart;
  readonly incapacitated: boolean;
  readonly died: boolean;
}

export function applyDamage(_ctx: StepCtx, _actorId: ActorId, _hit: Hit): DamageResult {
  throw new NotImplementedError("applyDamage (expeditions A1 W1)");
}
