/**
 * Expeditions A1 (§8.2): morale, the fight's engine. Resolve moves at each combatant's decision for
 * the interval since the last (`config.expedition.morale`), with hysteresis between `steady`,
 * `wavering` and `breaking`; the party's `withdrawWhen` is checked here.
 *
 * `dispositionOf` is complete at the gate (the start command spawns the cast with it): a cast
 * member's resolve is `resolveTiers[resolve]` times their tie's factor, capped at 1, and their
 * loyalty the tie's; the target and bystanders have no tie (factor 1, loyalty 0). A party member's
 * (`partyDisposition`) is `crewResolve`'s base plus `fighting`, mood and affinity to the leader:
 * the gate gives the base and `fighting`; W2 adds the rest.
 *
 * Owner after the gate: W2 of expeditions A1.
 */
import type { Actor, Disposition } from "../../core/types/actor";
import type { DeepReadonly } from "../../core/types/common";
import type { ConfigDef, SiteCastEntryDef } from "../../core/types/content";

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

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

/** A party member's disposition (§8.2). Gate: `crewResolve.base` and `perFighting` only. */
export function partyDisposition(
  actor: DeepReadonly<Actor>,
  config: Pick<ConfigDef, "expedition">,
): Disposition {
  const crew = config.expedition.crewResolve;
  return {
    part: "ally",
    resolveBase: clamp01(crew.base + crew.perFighting * (actor.skills.fighting ?? 0)),
    loyalty: 1,
    wants: "nothing",
  };
}
