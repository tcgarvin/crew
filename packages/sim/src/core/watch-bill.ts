/**
 * The watch bill at world creation (§sections-and-dayworkers). Lives in core because `createWorld`
 * needs it and core does not import systems; the rest of the watch is `systems/watch/`.
 *
 * Owner: W1 of ship life slice 2.
 */
import type { WatchSection } from "./types/actor";
import type {
  ContentBundle,
  CrewDef,
  DeckDef,
  RoleTag,
  ScenarioDef,
  WatchBillDef,
  WatchSectionDef,
} from "./types/content";
import type { CrewDefId, LocalKey } from "./types/ids";

/** Section keys of a generated bill, in watch order; a fourth watch on is `s4`, `s5`, … */
const GENERATED_SECTION_KEYS: readonly LocalKey[] = ["red", "white", "blue"];

/** Roles that stand no watch of their own: the cook, medic and deckhand keep the day's hours. */
const DAY_ROLES: ReadonlySet<RoleTag> = new Set(["cook", "medic", "deckhand"]);

const isOfficer = (def: CrewDef): boolean =>
  def.roleTags.some((role) => role === "captain" || role === "firstOfficer");

const piloting = (def: CrewDef): number => def.skills.piloting ?? 0;

/** Dayworker by role: every role they hold is a day role (and they hold at least one). */
const dayRole = (def: CrewDef): boolean =>
  def.roleTags.length > 0 && def.roleTags.every((role) => DAY_ROLES.has(role));

const byId = (a: CrewDef, b: CrewDef): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * A bill for a scenario that has none (test fixtures): greedy and pure.
 *
 * 1. Sections: one per helm-qualified crew member (piloting at least `helmSkillMin`), at most
 *    `watchesPerDay`; none if nobody qualifies.
 * 2. Standers: the qualified, non-officers first, then by piloting (highest first), one to each
 *    section in watch order.
 * 3. Engineers are spread one per section in turn, then everyone else not on day hours joins the
 *    smallest section (the earliest on a tie). Qualified crew left over after step 2 join this way.
 * 4. Dayworkers: crew whose every role is a day role (cook, medic, deckhand), and everyone when
 *    there are no sections.
 */
export function generateWatchBill(
  crewDefs: readonly CrewDef[],
  helmSkillMin: number,
  watchesPerDay: number,
): WatchBillDef {
  const qualified = crewDefs
    .filter((def) => piloting(def) >= helmSkillMin && !dayRole(def))
    .sort(
      (a, b) =>
        Number(isOfficer(a)) - Number(isOfficer(b)) || piloting(b) - piloting(a) || byId(a, b),
    );
  const count = Math.min(Math.max(0, Math.floor(watchesPerDay)), qualified.length);
  if (count === 0) return { sections: [], dayworkers: crewDefs.map((def) => def.id) };
  const members: CrewDefId[][] = Array.from({ length: count }, () => []);
  const placed = new Set<CrewDefId>();
  const join = (index: number, def: CrewDef) => {
    members[index]?.push(def.id);
    placed.add(def.id);
  };
  const smallest = (): number =>
    members.reduce((best, list, i) => (list.length < (members[best]?.length ?? 0) ? i : best), 0);
  qualified.slice(0, count).forEach((def, index) => join(index, def));
  const rest = crewDefs.filter((def) => !placed.has(def.id) && !dayRole(def));
  const engineers = rest.filter((def) => def.roleTags.includes("engineer"));
  for (const def of engineers) join(smallest(), def);
  for (const def of rest) if (!placed.has(def.id)) join(smallest(), def);
  const sections: WatchSectionDef[] = members.map((list, index) => ({
    key: GENERATED_SECTION_KEYS[index] ?? `s${index + 1}`,
    members: list,
  }));
  return { sections, dayworkers: crewDefs.filter((def) => !placed.has(def.id)).map((d) => d.id) };
}

/** The deck's helm: its `pilotStation` machine def, if it has one. */
function helmDef(deck: DeckDef, content: Pick<ContentBundle, "machines">) {
  for (const placement of deck.machines) {
    const def = content.machines[placement.machineDefId];
    if (def?.tags.includes("pilotStation") === true) return def;
  }
  return undefined;
}

/**
 * The piloting a helm-stander needs on `deck`: its `pilotStation` machine's `operatorSkill.min`.
 * 0 for a deck with no helm (or a helm that names no requirement): nobody needs to be qualified
 * for a station that is not there.
 */
export function helmSkillMin(deck: DeckDef, content: Pick<ContentBundle, "machines">): number {
  const skill = helmDef(deck, content)?.operation.operatorSkill;
  return skill?.skill === "piloting" ? skill.min : 0;
}

/**
 * The scenario's bill, or a generated one for a scenario without (fixtures). A deck with no helm
 * has no helm watch to stand, so a scenario on one without a bill keeps everyone on day hours
 * (what every helmless fixture meant before watches).
 */
export function resolveWatchBill(
  scenario: ScenarioDef,
  deck: DeckDef,
  content: Pick<ContentBundle, "crew" | "machines">,
  watchesPerDay: number,
): WatchBillDef {
  if (scenario.watchBill !== undefined) return scenario.watchBill;
  if (helmDef(deck, content) === undefined) return { sections: [], dayworkers: scenario.crew };
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
