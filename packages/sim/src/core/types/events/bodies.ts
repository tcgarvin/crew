/**
 * Body events (expeditions A1, §7.1): a wound, someone going down or dying, a wound healed. The
 * bodies system and `applyDamage` emit them (`systems/bodies/`).
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
}

export const BODIES_EVENT_SIGNIFICANCE = {
  wounded: "notable",
  incapacitated: "notable",
  died: "narrative",
  woundHealed: "trace",
} as const satisfies SignificanceCatalog<BodiesEventPayloads>;
