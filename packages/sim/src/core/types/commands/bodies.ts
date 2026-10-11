/**
 * Bodies commands (§strike-lever): the narrator's wound, down or death, through the one damage
 * entry point (`applyDamage`, `systems/bodies/damage.ts`). Handler: `systems/bodies/strike.ts`.
 */
import type { BodyPart, DamageType, WoundSeverity } from "../content";
import type { ActorId } from "../ids";

export interface BodiesCommandPayloads {
  /**
   * D106, the narrator's (and scenario's): one hit on `actorId`, a living person on the ship's
   * floor or the site's. The body rules decide what it does (down, dead, bleeding); a hit never
   * writes `dead` itself. `part` absent draws it as an unaimed hit does; `byActorId` is who did it
   * (a cast member in a fight, a crew member in a brawl), absent for an accident. `how` is one
   * line of what happened, the ticker's line for it off the fight, at most `STRIKE_HOW_MAX`
   * characters.
   */
  strike: {
    readonly actorId: ActorId;
    readonly severity: WoundSeverity;
    readonly type: DamageType;
    readonly part?: BodyPart;
    readonly byActorId?: ActorId;
    readonly how: string;
  };
}
