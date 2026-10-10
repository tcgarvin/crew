/**
 * Expeditions A1 (§8.2): morale, the fight's engine. Resolve moves at each combatant's decision for
 * the interval since the last (`config.expedition.morale`'s per-second terms) and at once on what
 * happens to them (a hit, an ally down or dead, a hit landed by their own side, being outflanked,
 * the target taken), with hysteresis between `steady`, `wavering` and `breaking`; the party's
 * `withdrawWhen` is checked here.
 *
 * `dispositionOf`: a cast member's resolve is `resolveTiers[resolve]` times their tie's factor,
 * capped at 1, and their loyalty the tie's; the target and bystanders have no tie (factor 1,
 * loyalty 0). `partyDisposition`: a party member's is `crewResolve.base + perFighting × fighting +
 * perMood × mood + perLeaderAffinity × affinity`, where mood is already in [-1, 1] and affinity to
 * the leader is normalised to [-1, 1] by `social.affinityRange` (0 for the leader).
 *
 * The ladder (W2 decisions, lead's ruling 7): a combatant starts `wavering` when their resolve is
 * already below `waverBelow`, else `steady`. `steady` → `wavering` below `waverBelow`, either →
 * `breaking` below `breakBelow`; `wavering` → `steady` only above `recoverAbove`. `breaking` does
 * not recover within a fight (two minutes at most): who ran, runs.
 *
 * Owner after the gate: W2 of expeditions A1.
 */
import { affinityOf } from "../../core/social";
import type { Actor, Combatant, CombatantState, Disposition } from "../../core/types/actor";
import type { DeepReadonly } from "../../core/types/common";
import type { ConfigDef, SiteCastEntryDef } from "../../core/types/content";
import type { ActorId } from "../../core/types/ids";
import type { ReadonlyWorldState } from "../../core/types/pipeline";
import type { Expedition, WithdrawRule } from "../../core/types/state";

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

type MoraleConfig = ConfigDef["expedition"]["morale"];

/** A cast entry's disposition (§5.2). */
export function dispositionOf(
  entry: SiteCastEntryDef,
  config: Pick<ConfigDef, "expedition">,
): Disposition {
  const e = config.expedition;
  const tied = entry.part === "guard" || entry.part === "ally";
  const tie = tied ? e.tie[entry.tie] : { resolve: 1, loyalty: 0 };
  return {
    part: entry.part,
    resolveBase: clamp01(e.resolveTiers[entry.resolve] * tie.resolve),
    loyalty: tie.loyalty,
    wants: entry.wants,
  };
}

/** A party member's disposition (§8.2), following `leaderId`. */
export function partyDisposition(
  state: DeepReadonly<Pick<ReadonlyWorldState, "actors" | "social">>,
  config: Pick<ConfigDef, "expedition" | "social">,
  actor: DeepReadonly<Actor>,
  leaderId: ActorId,
): Disposition {
  const crew = config.expedition.crewResolve;
  const range = config.social.affinityRange;
  const affinity =
    actor.id === leaderId || state.actors[leaderId] === undefined || range <= 0
      ? 0
      : affinityOf(state, config.social, actor.id, leaderId) / range;
  return {
    part: "ally",
    resolveBase: clamp01(
      crew.base +
        crew.perFighting * (actor.skills.fighting ?? 0) +
        crew.perMood * actor.mood +
        crew.perLeaderAffinity * affinity,
    ),
    loyalty: 1,
    wants: "nothing",
  };
}

/** Where someone with `resolve` starts on the ladder (ruling 7). */
export function initialState(resolve: number, morale: MoraleConfig): CombatantState {
  return resolve < morale.waverBelow ? "wavering" : "steady";
}

/** Can this combatant still act in the fight (not down, dead, gone or given up)? */
export function canAct(combatant: DeepReadonly<Combatant>): boolean {
  return combatant.state === "steady" || combatant.state === "wavering";
}

/** Still in the fight on their feet: acting or running. */
export function upright(combatant: DeepReadonly<Combatant>): boolean {
  return canAct(combatant) || combatant.state === "breaking";
}

/**
 * Move `combatant`'s resolve by `delta` (clamped to [0, 1]) and step the ladder. Returns true when
 * this moved them into `breaking`, so the caller says so once.
 */
export function shiftResolve(combatant: Combatant, delta: number, morale: MoraleConfig): boolean {
  combatant.resolve = clamp01(combatant.resolve + delta);
  return stepLadder(combatant, morale);
}

/** Apply the thresholds; true when they just broke. */
export function stepLadder(combatant: Combatant, morale: MoraleConfig): boolean {
  const { resolve } = combatant;
  switch (combatant.state) {
    case "steady":
      if (resolve < morale.breakBelow) break;
      if (resolve < morale.waverBelow) combatant.state = "wavering";
      return false;
    case "wavering":
      if (resolve < morale.breakBelow) break;
      if (resolve > morale.recoverAbove) combatant.state = "steady";
      return false;
    default:
      return false;
  }
  combatant.state = "breaking";
  return true;
}

/** What one decision's interval does to resolve, per second (§8.2's per-second terms). */
export interface MoraleSituation {
  readonly underFire: boolean;
  readonly inCover: boolean;
  readonly outnumbered: boolean;
  readonly leaderNear: boolean;
}

/** The resolve change over `seconds` in `situation`. */
export function intervalDelta(
  situation: MoraleSituation,
  seconds: number,
  morale: MoraleConfig,
): number {
  let perSecond = 0;
  if (situation.underFire && !situation.inCover) perSecond += morale.underFireNoCoverPerSecond;
  if (situation.outnumbered) perSecond += morale.outnumberedPerSecond;
  if (situation.inCover) perSecond += morale.inCoverPerSecond;
  if (situation.leaderNear) perSecond += morale.leaderNearPerSecond;
  return perSecond * seconds;
}

/**
 * §8.3 `withdrawWhen`: is it time to pull the party back? `firstDown` at the first party member
 * down or dead, `halfDown` once that share of the party is, `never` never.
 */
export function withdrawalDue(
  state: ReadonlyWorldState,
  expedition: DeepReadonly<Expedition>,
  rule: WithdrawRule,
  config: Pick<ConfigDef, "expedition">,
): boolean {
  if (rule === "never" || expedition.party.length === 0) return false;
  const out = expedition.party.filter((id) => {
    const s = state.actors[id]?.combatant?.state;
    return s === "down" || s === "dead";
  }).length;
  const share = config.expedition.withdrawWhen[rule];
  return rule === "firstDown" ? out >= share : out / expedition.party.length >= share;
}
