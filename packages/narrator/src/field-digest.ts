/**
 * The asteroid field, the hull and the damage in the digest (§field-lifecycle,
 * §hull-scars-and-ship-loss; slice 5 calls 14, 15). Pure reads of the snapshot: the leg's field
 * (`WorldState.field`) scheduled, in progress or crossed; the alert; the hull bar with its scars
 * patched and unpatched, which of them came aboard from an earlier leg, the repairs a port allows
 * and whether the ship is leaving with them unfinished; the damage the crew know of against the
 * damage that exists (a `hullScar` or `machineDamaged` problem someone holds a `problem` fact for,
 * or a public one); and who reported on the intercom since the last call.
 */
import {
  type ConfigDef,
  type ContentBundle,
  type DeepReadonly,
  type FieldSeverity,
  type HullScar,
  type Problem,
  type ScriptedImpact,
  type SimEvent,
  describeEvent,
  effectiveMarket,
  scarDamageLeft,
} from "@crew/sim";
import { type State, compartmentName, compartmentPhrase, machineName, portName } from "./lookups";
import { helmHolder, helmOf } from "./watch-digest";

type Field = NonNullable<State["field"]>;
type Scar = DeepReadonly<HullScar>;

/** Intercom reports the digest repeats, newest last. */
export const INTERCOM_LINES_SHOWN = 4;

function seconds(ticks: number, config: ConfigDef): number {
  return Math.round(ticks / config.time.tickRate);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Cargo Hold x2, Galley": rooms named once each, with a count when more than one. */
function roomCounts(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, n]) => (n > 1 ? `${name} x${n}` : name))
    .join(", ");
}

/** "the Main Engine (m3)", "the cargo hold", "engineering", "tile (4, 7)": a scripted target in words. */
function targetPhrase(state: State, content: ContentBundle, impact: ScriptedImpact): string {
  const target = impact.target;
  switch (target.kind) {
    case "machine": {
      const machine = state.machines[target.machineId];
      return machine === undefined
        ? target.machineId
        : `the ${machineName(content, machine)} (${machine.id})`;
    }
    case "compartment":
      return compartmentPhrase(content, state, target.compartmentId);
    case "tile":
      return `tile (${target.x}, ${target.y})`;
    case "actor":
      return state.actors[target.actorId]?.name ?? target.actorId;
  }
}

/** "knockout on the Main Engine (m3) at 30s (large rock)": one scripted impact. */
function scriptedPhrase(state: State, content: ContentBundle, impact: ScriptedImpact): string {
  const effect = impact.effect ?? "a rolled hit";
  const rock = impact.rock === undefined ? "" : ` (${impact.rock} rock)`;
  const fired = impact.firedTick === undefined ? "" : `, landed t${impact.firedTick}`;
  return `${effect} on ${targetPhrase(state, content, impact)} at ${Math.round(impact.atSeconds)}s${rock}${fired}`;
}

function scriptedClause(state: State, content: ContentBundle, field: Field): string {
  if (field.scripted.length === 0) return "";
  const said = field.scripted.map((i) => scriptedPhrase(state, content, i as ScriptedImpact));
  return `; your scripted hits: ${said.join("; ")}`;
}

function severityWord(severity: FieldSeverity): string {
  return `${severity} asteroid field`;
}

/** Who has the helm in the rocks, as the helm-check line says it. */
function helmClause(state: State, content: ContentBundle): string {
  if (helmOf(state, content) === undefined) return "no helm aboard";
  const holder = helmHolder(state, content);
  if (holder === undefined) return "nobody at the helm";
  return `${holder.actor.name} at the helm (piloting ${holder.actor.skills.piloting ?? 0})`;
}

/** Was the field sighted by the helm (noticed before its rocks began), or by its first rock? */
function noticedClause(field: Field): string {
  if (field.noticedAtTick === undefined) return "nobody aboard knows it is there yet";
  return field.noticedAtTick < field.startsAtTick
    ? `sighted by the helm at t${field.noticedAtTick}`
    : `nobody saw it coming: noticed at the first rock, t${field.noticedAtTick}`;
}

function scheduledLine(state: State, content: ContentBundle, config: ConfigDef, field: Field) {
  const due = Math.max(0, seconds(field.startsAtTick - state.tick, config));
  const when =
    state.travel.stage === "transit"
      ? `begins in ~${due}s`
      : `begins once she is in transit, no sooner than ~${due}s from now`;
  const detection =
    field.detection === "unseen"
      ? "unseen (no warning: the first rock is the news)"
      : `rolled (the helm's check ~${Math.round(config.field.warningSeconds)}s before it)`;
  return `field scheduled: ${severityWord(field.severity)}, ${detection}, ${when}${scriptedClause(state, content, field)} [scheduled; nobody aboard knows]`;
}

function activeLine(
  state: State,
  content: ContentBundle,
  config: ConfigDef,
  field: Field,
  phase: Extract<Field["phase"], { kind: "active" }>,
): string {
  const inFor = seconds(state.tick - phase.enteredTick, config);
  const rocks = `${plural(field.impacts, "rock")} so far, ${plural(field.hullLost, "hull point")} lost`;
  const left = config.field.stuckDriftImpacts - field.stuckImpacts;
  const moving =
    phase.stuckSinceTick === undefined
      ? "under way through it"
      : `STUCK since t${phase.stuckSinceTick} (engines out; drifts clear after ${plural(left, "more rock")} unless the engines come back)`;
  return `field: IN A ${severityWord(field.severity).toUpperCase()} since t${phase.enteredTick} (~${inFor}s), ${noticedClause(field)}; ${rocks}; ${moving}; ${helmClause(state, content)}${scriptedClause(state, content, field)}`;
}

function endedLine(
  state: State,
  content: ContentBundle,
  field: Field,
  phase: Extract<Field["phase"], { kind: "ended" }>,
): string {
  const how = phase.how === "drifted" ? "drifted clear of" : "crossed";
  return `field: ${how} a ${severityWord(field.severity)} at t${phase.endedTick}: ${plural(field.impacts, "rock")}, ${plural(field.hullLost, "hull point")} lost${scriptedClause(state, content, field)}`;
}

/** The leg's field in one line, or undefined when the leg has none. */
export function fieldLine(state: State, content: ContentBundle, config: ConfigDef) {
  const field = state.field;
  if (field === undefined) return undefined;
  switch (field.phase.kind) {
    case "scheduled":
      return scheduledLine(state, content, config, field);
    case "active":
      return activeLine(state, content, config, field, field.phase);
    case "ended":
      return endedLine(state, content, field, field.phase);
  }
}

/** "alert: general alert since t4000 (the rocks)", or undefined off alert. */
export function alertLine(state: State, config: ConfigDef): string | undefined {
  const alert = state.alert;
  if (alert === undefined) return undefined;
  const clears =
    alert.clearsAtTick === undefined
      ? "until the rocks are behind her"
      : `stands down in ~${Math.max(0, seconds(alert.clearsAtTick - state.tick, config))}s`;
  return `alert: general alert since t${alert.sinceTick} (${alert.cause}); ${clears}`;
}

function scarRoom(state: State, content: ContentBundle, scar: Scar): string {
  return compartmentName(content, state, scar.compartmentId);
}

/** The scars that came aboard on an earlier leg than this one's field. */
function carriedScars(state: State): Scar[] {
  const fieldId = state.field?.id;
  return state.hull.scars.filter((scar) => scar.fieldId !== fieldId);
}

/**
 * "hull: 71/100; 2 scars unpatched (Cargo Hold x2), 1 patched (Galley); 1 scar from an earlier
 * leg still costs 3 points: she left port damaged". Always shown: it is what a field is weighed
 * against.
 */
export function hullLine(state: State, content: ContentBundle): string {
  const hull = state.hull;
  const head = `hull: ${Math.round(hull.integrity)}/${hull.max}`;
  if (hull.lostAtTick !== undefined)
    return `${head}: LOST at t${hull.lostAtTick}; the game is over`;
  if (hull.scars.length === 0) return `${head}, unmarked`;
  const unpatched = hull.scars.filter((s) => !s.patched);
  const patched = hull.scars.filter((s) => s.patched);
  const parts = [
    unpatched.length === 0
      ? "no scar unpatched"
      : `${plural(unpatched.length, "scar")} unpatched (${roomCounts(unpatched.map((s) => scarRoom(state, content, s)))})`,
    patched.length === 0
      ? "none patched"
      : `${patched.length} patched, still to plate at a port (${roomCounts(patched.map((s) => scarRoom(state, content, s)))})`,
  ];
  const carried = carriedScars(state);
  if (carried.length > 0 && state.travel.stage !== "docked") {
    const cost = carried.reduce((sum, s) => sum + scarDamageLeft(s), 0);
    parts.push(
      `${plural(carried.length, "scar")} from an earlier leg still ${carried.length === 1 ? "costs" : "cost"} ${plural(Math.round(cost), "point")}: she left port damaged`,
    );
  }
  return `${head}; ${parts.join("; ")}`;
}

function openProblems<K extends Problem["kind"]>(
  state: State,
  kind: K,
): DeepReadonly<Extract<Problem, { kind: K }>>[] {
  return Object.values(state.work.problems).filter(
    (p): p is DeepReadonly<Extract<Problem, { kind: K }>> => p.kind === kind && p.status === "open",
  );
}

/** The hull plating item ids the content tags `plating`. */
function platingDefs(content: ContentBundle): string[] {
  return Object.values(content.items)
    .filter((def) => def.tags.includes("plating"))
    .map((def) => def.id);
}

/**
 * Docked with unplated damage: what this port allows ("hull plating sold here x4" / "no hull
 * plating here"), what the crew are buying, and, with a course set, that she is about to leave
 * with the repairs unfinished. Undefined in flight or with a whole hull.
 */
export function portRepairLine(state: State, content: ContentBundle): string | undefined {
  const travel = state.travel;
  if (travel.stage !== "docked" || state.hull.scars.length === 0) return undefined;
  const left = state.hull.scars.reduce((sum, s) => sum + scarDamageLeft(s), 0);
  const market = effectiveMarket(state, content, travel.portId);
  const sold = platingDefs(content)
    .map((id) => market[id as keyof typeof market]?.count ?? 0)
    .reduce((sum, n) => sum + n, 0);
  const port = portName(content, travel.portId);
  const plating =
    sold > 0 ? `hull plating sold here x${sold}` : `no hull plating at ${port}: the scars stay`;
  const buying = openProblems(state, "hullDamaged")
    .map((p) => `the crew are buying ${p.payload.count} plates`)
    .join("; ");
  const parts = [
    `repairs at port: ${plural(state.hull.scars.length, "scar")} to plate (${plural(Math.round(left), "hull point")} to win back)`,
    plating,
    ...(buying === "" ? [] : [buying]),
  ];
  if (travel.plannedDestinationId !== undefined) {
    parts.push(
      `LEAVING WITH REPAIRS UNFINISHED: course set for ${portName(content, travel.plannedDestinationId)} with the hull at ${Math.round(state.hull.integrity)}/${state.hull.max}`,
    );
  }
  return parts.join("; ");
}

/** Does anyone aboard know of this problem (public, or held as a `problem` fact)? */
function known(state: State, problem: DeepReadonly<Problem>): boolean {
  if (problem.visibility === "public") return true;
  const key = `${problem.id}/problem`;
  return Object.values(state.actors).some(
    (actor) => (actor.knowledge as Record<string, unknown>)[key] !== undefined,
  );
}

/**
 * "damage known to the crew: a scar in the Galley; the Galley Stove (m5) damaged. damage nobody
 * has seen: a scar in the cargo hold", from the open `hullScar` and `machineDamaged` problems.
 * Undefined when there is no open damage.
 */
export function damageKnowledgeLine(state: State, content: ContentBundle): string | undefined {
  const seen: string[] = [];
  const unseen: string[] = [];
  for (const p of openProblems(state, "hullScar")) {
    const said = `a scar in ${compartmentPhrase(content, state, p.payload.compartmentId)}`;
    (known(state, p) ? seen : unseen).push(said);
  }
  for (const p of openProblems(state, "machineDamaged")) {
    const machine = state.machines[p.payload.machineId];
    const name = machine === undefined ? p.payload.machineId : machineName(content, machine);
    const said = `the ${name} (${p.payload.machineId}) damaged`;
    (known(state, p) ? seen : unseen).push(said);
  }
  if (seen.length === 0 && unseen.length === 0) return undefined;
  const parts = [
    `damage the crew know of: ${seen.join("; ") || "none"}`,
    `damage nobody aboard has seen: ${unseen.join("; ") || "none"}`,
  ];
  return parts.join(". ");
}

/** "intercom t4100: Bettina Solheim on the intercom: the Galley's hit", newest last. */
export function intercomLines(
  events: readonly SimEvent[],
  state: State,
  content: ContentBundle,
): string[] {
  return events
    .filter((e) => e.type === "intercomReport")
    .slice(-INTERCOM_LINES_SHOWN)
    .map((e) => `intercom t${e.tick}: ${describeEvent(e, state as never, content)}`);
}

/**
 * Call 15's lines for the Ship section, in order: the field, the alert, the hull, repairs at
 * port, damage known against damage that exists, and the intercom reports since the last call.
 */
export function fieldDigestLines(
  state: State,
  content: ContentBundle,
  config: ConfigDef,
  events: readonly SimEvent[],
): string[] {
  return [
    fieldLine(state, content, config),
    alertLine(state, config),
    hullLine(state, content),
    portRepairLine(state, content),
    damageKnowledgeLine(state, content),
    ...intercomLines(events, state, content),
  ].filter((line): line is string => line !== undefined);
}

/** The budget section's field line: one per leg, no budget. */
export function fieldBudgetLine(state: State): string {
  if (state.hull.lostAtTick !== undefined) return "fields: none (the ship is lost)";
  return state.field === undefined
    ? "fields: one per leg, none placed on this one"
    : "fields: this leg has its field";
}
