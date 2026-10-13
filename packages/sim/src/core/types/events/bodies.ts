/**
 * Body events (expeditions A1, §7.1): a wound, someone going down or dying, a wound healed. The
 * bodies system and `applyDamage` emit them (`systems/bodies/`); medical emits `woundTreated`
 * and `casualtyCarried` (`systems/medical/`).
 */
import type { BodyPart, DamageType, WoundSeverity } from "../content";
import type { ActorId, WoundId } from "../ids";
import type { SignificanceCatalog } from "./significance";

export interface BodiesEventPayloads {
  /** `actorId` took wound `woundId` to `part`, from `byActorId` when someone did it. */
  wounded: {
    readonly actorId: ActorId;
    readonly woundId: WoundId;
    readonly part: BodyPart;
    readonly severity: WoundSeverity;
    readonly type: DamageType;
    readonly byActorId?: ActorId;
    /** §strike-lever: the narrator's strike off the fight; its `struck` line is the ticker's. */
    readonly narrated?: true;
  };
  /** `actorId` is down: unconscious (blood, pain or stun) or unable to move. */
  incapacitated: {
    readonly actorId: ActorId;
    readonly cause: "blood" | "pain" | "movement" | "stun";
  };
  /** `actorId` died: of a wound at once, or of blood loss later. */
  died: {
    readonly actorId: ActorId;
    readonly cause: "wound" | "blood";
    readonly byActorId?: ActorId;
  };
  /** A wound closed and is gone from the body. */
  woundHealed: { readonly actorId: ActorId; readonly woundId: WoundId };
  /**
   * §treatment-at-the-medbay-bed: `byActorId` treated `actorId`'s open wounds `woundIds` (on
   * `parts`, for the ticker) at the medbay bed.
   */
  woundTreated: {
    readonly actorId: ActorId;
    readonly byActorId: ActorId;
    readonly woundIds: readonly WoundId[];
    readonly parts: readonly BodyPart[];
  };
  /** §extraction: `byActorId` carried the downed `actorId` to the medbay bed and laid them on it. */
  casualtyCarried: { readonly actorId: ActorId; readonly byActorId: ActorId };
  /**
   * §strike-lever: the narrator's `strike` landed on `actorId`, just before the `wounded` (and any
   * `died` or `incapacitated`) it causes. `inFight`: they were in the site's fight, where the
   * fight's own lines tell it; off the fight `how` is the ticker's line.
   */
  struck: {
    readonly actorId: ActorId;
    readonly severity: WoundSeverity;
    readonly type: DamageType;
    readonly how: string;
    readonly inFight: boolean;
    readonly byActorId?: ActorId;
  };
}

export const BODIES_EVENT_SIGNIFICANCE = {
  wounded: "notable",
  incapacitated: "notable",
  died: "narrative",
  woundHealed: "trace",
  woundTreated: "notable",
  casualtyCarried: "notable",
  struck: "narrative",
} as const satisfies SignificanceCatalog<BodiesEventPayloads>;
