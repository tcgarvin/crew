/**
 * The watch bill at world creation (D77). Lives in core because `createWorld` needs it and core
 * does not import systems; the rest of the watch is `systems/watch/`.
 *
 * Owner: W1 of ship life slice 2 (`generateWatchBill`). Gate B stub: everyone is a dayworker,
 * which is what a fixture without a bill meant before watches (one duty rule for all).
 */
import type { WatchSection } from "./types/actor";
import type { ContentBundle, CrewDef, DeckDef, ScenarioDef, WatchBillDef } from "./types/content";
import type { CrewDefId } from "./types/ids";

/**
 * A bill for a scenario that has none (test fixtures): greedy, one helm-qualified member
 * (piloting at least `helmSkillMin`) per section, engineers spread, the rest by role, at most
 * `watchesPerDay` sections. Pure. Stub: no sections, everyone a dayworker.
 */
export function generateWatchBill(
  crewDefs: readonly CrewDef[],
  _helmSkillMin: number,
  _watchesPerDay: number,
): WatchBillDef {
  return { sections: [], dayworkers: crewDefs.map((def) => def.id) };
}

/**
 * The piloting a helm-stander needs on `deck`: its `pilotStation` machine's `operatorSkill.min`.
 * 0 for a deck with no helm (or a helm that names no requirement): nobody needs to be qualified
 * for a station that is not there.
 */
export function helmSkillMin(deck: DeckDef, content: Pick<ContentBundle, "machines">): number {
  for (const placement of deck.machines) {
    const def = content.machines[placement.machineDefId];
    if (def?.tags.includes("pilotStation") !== true) continue;
    const skill = def.operation.operatorSkill;
    return skill?.skill === "piloting" ? skill.min : 0;
  }
  return 0;
}

/** The scenario's bill, or a generated one for a scenario without (fixtures). */
export function resolveWatchBill(
  scenario: ScenarioDef,
  deck: DeckDef,
  content: Pick<ContentBundle, "crew" | "machines">,
  watchesPerDay: number,
): WatchBillDef {
  if (scenario.watchBill !== undefined) return scenario.watchBill;
  const defs = scenario.crew.map((id) => {
    const def = content.crew[id];
    if (def === undefined) throw new Error(`Scenario "${scenario.id}": unknown crew "${id}"`);
    return def;
  });
  return generateWatchBill(defs, helmSkillMin(deck, content), watchesPerDay);
}

/** Each sectioned crew def's section (index = place in the bill). Dayworkers are absent. */
export function sectionsByCrewDef(bill: WatchBillDef): ReadonlyMap<CrewDefId, WatchSection> {
  const out = new Map<CrewDefId, WatchSection>();
  bill.sections.forEach((section, index) => {
    for (const member of section.members) {
      if (out.has(member)) {
        throw new Error(`Watch bill lists "${member}" in two sections`);
      }
      out.set(member, { key: section.key, index });
    }
  });
  return out;
}
