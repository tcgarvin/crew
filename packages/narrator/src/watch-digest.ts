/**
 * The watch, the helm and mood in the digest (D77-D79). Pure reads of the snapshot's state
 * shapes: sections and duty off `Actor.schedule`, the helm off the actors' current plan steps,
 * mood off `Actor.mood` and `Actor.thoughts`, hazards off `WorldState.hazards` and the
 * `navHazard`/`helmUnattended` events since the last call.
 */
import {
  type ConfigDef,
  type ContentBundle,
  type DeepReadonly,
  type HazardKind,
  type Machine,
  type SimEvent,
  isOnDuty,
  watchOfDay,
  watchTicks,
} from "@crew/sim";
import { type State, machineName } from "./lookups";

type Actor = State["actors"][keyof State["actors"]];

/** D78: how each hazard kind reads in the digest and the capability list. */
export const HAZARD_NAMES: Readonly<Record<HazardKind, string>> = {
  debrisField: "debris field",
  asteroidBelt: "asteroid belt",
  ionStorm: "ion storm",
};

/** D77: "white" → "White", as the ticker's bell line says it. */
export function sectionName(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function seconds(ticks: number, config: ConfigDef): number {
  return Math.round(ticks / config.time.tickRate);
}

/** The ship's helm: the `pilotStation` machine whose def requires an operator. */
export function helmOf(state: State, content: ContentBundle): DeepReadonly<Machine> | undefined {
  return Object.values(state.machines).find((m) => {
    const def = content.machines[m.defId];
    return def?.tags.includes("pilotStation") === true && def.operation.requiresOperator;
  });
}

/** The piloting a helm-stander needs (the helm's `operatorSkill`), 0 when it names none. */
function helmSkillMin(content: ContentBundle, helm: DeepReadonly<Machine>): number {
  const skill = content.machines[helm.defId]?.operation.operatorSkill;
  return skill?.skill === "piloting" ? skill.min : 0;
}

/** The step an actor's plan is on, if they have a plan. */
function currentStep(actor: Actor) {
  const activity = actor.activity;
  if (activity.kind === "idle") return undefined;
  return activity.plan?.steps[activity.plan.stepIndex];
}

/**
 * Who holds the helm, and since when: a crew member whose current step is a `staff` hold on a
 * `staffStation` task at the helm (the watch or a relief for needs). The same rule as the sim's
 * `whoHasTheHelm`, read off the state the snapshot carries.
 */
export function helmHolder(
  state: State,
  content: ContentBundle,
): { readonly actor: Actor; readonly sinceTick: number } | undefined {
  const helm = helmOf(state, content);
  if (helm === undefined) return undefined;
  for (const actor of sortedCrew(state)) {
    const activity = actor.activity;
    if (activity.kind !== "task") continue;
    const step = currentStep(actor);
    if (step?.kind !== "hold" || step.hold !== "staff") continue;
    const task = state.work.tasks[activity.taskId];
    if (task?.type !== "staffStation") continue;
    if (task.target.kind !== "machine" || task.target.machineId !== helm.id) continue;
    return { actor, sinceTick: step.sinceTick };
  }
  return undefined;
}

/** Who stands gangway watch: a crew member holding `gangway` at the airlock. */
function gangwayStanders(state: State): Actor[] {
  return sortedCrew(state).filter((actor) => {
    const step = currentStep(actor);
    return step?.kind === "hold" && step.hold === "gangway";
  });
}

/** Crew aboard the books (not passengers), by actor id. */
function sortedCrew(state: State): Actor[] {
  return Object.values(state.actors)
    .filter((a) => a.crew && a.passenger !== true)
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
}

/** The key of the section standing watch `index` of the day, or undefined if none does. */
function sectionKeyAt(state: State, index: number): string | undefined {
  return sortedCrew(state).find((a) => a.schedule.section?.index === index)?.schedule.section?.key;
}

function isOfficer(actor: Actor): boolean {
  return actor.roleTags.some((role) => role === "captain" || role === "firstOfficer");
}

/** "Jax Okonkwo has the helm (piloting 8) since tick 4000", flagged when below the helm's need. */
function helmPhrase(
  state: State,
  content: ContentBundle,
  config: ConfigDef,
  helm: DeepReadonly<Machine>,
): string {
  const holder = helmHolder(state, content);
  if (holder === undefined) {
    const since = state.watch.helm.unattendedSinceTick;
    const empty =
      since === undefined
        ? ""
        : ` (empty since tick ${since}, ~${seconds(state.tick - since, config)}s)`;
    return `nobody has the helm${empty}`;
  }
  const skill = holder.actor.skills.piloting ?? 0;
  const min = helmSkillMin(content, helm);
  // §2: the unqualified fallback is narrator-visible; it is a story, not an error.
  const unqualified = skill < min ? `, below the helm's ${min}: an unqualified hand` : "";
  return `${holder.actor.name} has the helm (piloting ${skill}${unqualified}) since tick ${holder.sinceTick}`;
}

/**
 * The Ship section's watch line: which section has the watch, who has the helm (underway, or
 * whenever someone holds it), the officer of the watch, who stands the gangway (docked), and
 * the next bell.
 */
export function watchLine(state: State, content: ContentBundle, config: ConfigDef): string {
  if (!sortedCrew(state).some((a) => a.schedule.section !== undefined)) {
    return "watch: no watch bill aboard; everyone works days";
  }
  const index = watchOfDay(config, state.tick);
  const key = sectionKeyAt(state, index);
  const parts = [
    key === undefined
      ? `no section stands this watch (watch ${index + 1} of ${config.time.watchesPerDay})`
      : `${sectionName(key)} section has the watch`,
  ];
  const docked = state.travel.stage === "docked";
  const helm = helmOf(state, content);
  const holder = helm === undefined ? undefined : helmHolder(state, content);
  if (helm !== undefined && (!docked || holder !== undefined)) {
    parts.push(helmPhrase(state, content, config, helm));
  }
  const officers = sortedCrew(state).filter(
    (a) => isOfficer(a) && a.schedule.section?.index === index && a.id !== holder?.actor.id,
  );
  parts.push(`officer of the watch: ${officers.map((a) => a.name).join(", ") || "none"}`);
  if (docked) {
    const gangway = gangwayStanders(state);
    parts.push(
      gangway.length === 0
        ? "nobody on the gangway"
        : `${gangway.map((a) => a.name).join(", ")} on the gangway`,
    );
  }
  const length = watchTicks(config);
  const nextIndex = (index + 1) % config.time.watchesPerDay;
  const nextKey = sectionKeyAt(state, nextIndex);
  const next = nextKey === undefined ? "" : ` (${sectionName(nextKey)} section)`;
  parts.push(`next bell in ~${seconds(length - (state.tick % length), config)}s${next}`);
  return `watch: ${parts.join("; ")}`;
}

/** A crew line's duty tag: "[Red, on watch]", "[dayworker, off duty]". */
export function dutyTag(actor: Actor, tick: number, config: ConfigDef): string {
  const section = actor.schedule.section;
  const onDuty = isOnDuty(actor.schedule, tick, config);
  if (section === undefined) return `[dayworker, ${onDuty ? "on duty" : "off duty"}]`;
  return `[${sectionName(section.key)}, ${onDuty ? "on watch" : "off watch"}]`;
}

/** How many thoughts a crew line names, by weight. */
export const MOOD_THOUGHTS_SHOWN = 3;

/**
 * D79: "mood: low (stood a long watch, double watch)": the mood as a word against
 * `config.mood`, then the live thoughts that weigh most (by |value|, a stacked thought counted
 * once with its total and "x2"), at most `MOOD_THOUGHTS_SHOWN`.
 */
export function moodPhrase(
  actor: Actor,
  tick: number,
  content: ContentBundle,
  config: ConfigDef,
): string {
  const word =
    actor.mood < config.mood.lowBelow
      ? "low"
      : actor.mood > config.mood.highAbove
        ? "high"
        : "steady";
  const byKey = new Map<string, { total: number; count: number }>();
  for (const thought of actor.thoughts) {
    if (thought.expiresAtTick <= tick) continue;
    const entry = byKey.get(thought.key) ?? { total: 0, count: 0 };
    byKey.set(thought.key, { total: entry.total + thought.value, count: entry.count + 1 });
  }
  const top = [...byKey]
    .sort(([a, x], [b, y]) => Math.abs(y.total) - Math.abs(x.total) || a.localeCompare(b))
    .slice(0, MOOD_THOUGHTS_SHOWN)
    .map(([key, { count }]) => {
      const label = content.thoughts[key as keyof ContentBundle["thoughts"]]?.label ?? key;
      return count > 1 ? `${label} x${count}` : label;
    });
  return top.length === 0 ? `mood: ${word}` : `mood: ${word} (${top.join(", ")})`;
}

/** A difficulty number as the tier word the model wrote, or the bare number. */
export function difficultyWord(config: ConfigDef, difficulty: number): string {
  const tier = Object.entries(config.hazards.difficulty).find(([, n]) => n === difficulty);
  return tier === undefined ? `difficulty ${difficulty}` : tier[0];
}

type NavHazard = Extract<SimEvent, { type: "navHazard" }>;

function navHazardLine(
  event: NavHazard,
  state: State,
  content: ContentBundle,
  config: ConfigDef,
): string {
  const p = event.payload;
  const head = `helm check t${event.tick}: ${HAZARD_NAMES[p.kind]} (${difficultyWord(config, p.difficulty)})`;
  const who =
    p.standerId === undefined
      ? "nobody at the helm"
      : `${state.actors[p.standerId]?.name ?? p.standerId} at the helm (piloting ${p.skill})`;
  const machine = p.scrapedMachineId === undefined ? undefined : state.machines[p.scrapedMachineId];
  const scraped =
    machine === undefined
      ? "scraped through"
      : `scraped through; the ${machineName(content, machine)} took a fault`;
  const lost = `lost ${Math.round(p.lostSeconds)}s on the leg`;
  const outcome = {
    clean: "came through clean",
    scrape: scraped,
    delay: lost,
    unattended: `${scraped}, and ${lost}`,
  }[p.outcome];
  return `${head}: ${who}: ${outcome}`;
}

/**
 * D78: the helm's stakes since the last call, and what is still waiting: every `navHazard` with
 * who was at the helm and how it went, every `helmUnattended`, then each scheduled hazard (truth:
 * nobody aboard knows it is coming).
 */
export function helmEventLines(
  events: readonly SimEvent[],
  state: State,
  content: ContentBundle,
  config: ConfigDef,
): string[] {
  const lines: string[] = [];
  for (const event of events) {
    if (event.type === "navHazard") lines.push(navHazardLine(event, state, content, config));
    if (event.type === "helmUnattended") {
      lines.push(
        `helm empty t${event.tick}: nobody at the helm for ${Math.round(event.payload.seconds)}s in transit`,
      );
    }
  }
  const inTransit = state.travel.stage === "transit";
  for (const hazard of [...state.hazards].sort((a, b) => a.fireAtTick - b.fireAtTick)) {
    const due = Math.max(0, seconds(hazard.fireAtTick - state.tick, config));
    // It fires at the first transit tick at or after its moment, so outside transit it waits.
    const when = inTransit
      ? `due in ~${due}s`
      : `due once she is in transit, no sooner than ~${due}s from now`;
    lines.push(
      `hazard scheduled: ${HAZARD_NAMES[hazard.kind]} (${difficultyWord(config, hazard.difficulty)}), ${when} [scheduled; nobody aboard knows]`,
    );
  }
  return lines;
}
