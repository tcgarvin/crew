/**
 * The infirmary in the digest (§ship-life-lines, §medicine): the Ship section's `infirmary:` line
 * (who lies in the medbay bed, who is treating or carrying someone there, med kits aboard against
 * `medical.reserve`), the `crewWounded` problem line and the `bodyAboard` one (§the-body-aboard).
 * Pure reads of the snapshot through `@crew/sim`'s own `medBedOf`, `onTheBed` and
 * `medicalUnitsAboard`, so the digest counts what the treatment draws on.
 */
import {
  type ConfigDef,
  type ContentBundle,
  type DeepReadonly,
  type Problem,
  type ProblemId,
  type TaskType,
  medBedOf,
  medicalUnitsAboard,
  onTheBed,
} from "@crew/sim";
import { type State, compartmentNameAt, shipDeckOf } from "./lookups";

/** Who holds a `type` task of `problemId` (one problem, so one patient), by name. */
function holdersOf(state: State, problemId: ProblemId, type: TaskType): string[] {
  const names: string[] = [];
  for (const task of Object.values(state.work.tasks)) {
    if (task.problemId !== problemId || task.type !== type) continue;
    if (task.claimState.kind !== "claimed") continue;
    for (const claimId of task.claimState.claimIds) {
      const owner = state.work.claims[claimId]?.ownerActorId;
      if (owner !== undefined) names.push(state.actors[owner]?.name ?? owner);
    }
  }
  return names.sort();
}

type Wounded = DeepReadonly<Extract<Problem, { kind: "crewWounded" }>>;

function openWounded(state: State): Wounded[] {
  return Object.values(state.work.problems)
    .filter((p): p is Wounded => p.kind === "crewWounded" && p.status === "open")
    .sort((a, b) => a.createdTick - b.createdTick || a.id.localeCompare(b.id));
}

function kitsPhrase(units: number): string {
  if (units === 0) return "no med kits aboard";
  return `${units} med ${units === 1 ? "kit" : "kits"} aboard`;
}

/** Who is seeing to the patient of `problem`, or that nobody is and why. */
function careWords(state: State, content: ContentBundle, config: ConfigDef, problem: Wounded) {
  const medics = holdersOf(state, problem.id, "treatWounds");
  if (medics.length > 0) return `${medics.join(", ")} treating`;
  const carriers = holdersOf(state, problem.id, "carryCasualty");
  if (carriers.length > 0) return `${carriers.join(", ")} carrying them to the medbay`;
  const short = medicalUnitsAboard(state, content) < config.medical.kitsPerTreatment;
  return short ? "nobody treating yet, no kits aboard" : "nobody treating yet";
}

/**
 * §medicine: "Priya Kessler is wounded; Oyelaran Abiodun treating", or "...; nobody treating yet,
 * no kits aboard".
 */
export function crewWoundedDetail(
  state: State,
  content: ContentBundle,
  config: ConfigDef,
  problem: Wounded,
): string {
  const patient = state.actors[problem.payload.actorId];
  const name = patient?.name ?? problem.payload.actorId;
  return `${name} is wounded; ${careWords(state, content, config, problem)}`;
}

type BodyAboard = DeepReadonly<Extract<Problem, { kind: "bodyAboard" }>>;

/**
 * §the-body-aboard: "Tomas Ruiz's body, to be laid out in Cargo Hold; Jax Okonkwo carrying it", or
 * "...; nobody carrying it yet".
 */
export function bodyAboardDetail(
  state: State,
  content: ContentBundle,
  problem: BodyAboard,
): string {
  const name = state.actors[problem.payload.actorId]?.name ?? problem.payload.actorId;
  const { x, y } = problem.payload.tile;
  const room = compartmentNameAt(content, shipDeckOf(state), x, y) ?? "its resting place";
  const carriers = holdersOf(state, problem.id, "carryBody");
  const who = carriers.length > 0 ? `${carriers.join(", ")} carrying it` : "nobody carrying it yet";
  return `${name}'s body, to be laid out in ${room}; ${who}`;
}

/**
 * The Ship section's infirmary line, only while someone lies in the medbay bed, someone aboard is
 * wounded, or the kits are under the reserve: "infirmary: Priya Kessler in the bed, Oyelaran
 * Abiodun treating; 1 med kit aboard (the ship keeps 2)". A deck with no medbay bed has none.
 */
export function infirmaryLine(
  state: State,
  content: ContentBundle,
  config: ConfigDef,
): string | undefined {
  const bed = medBedOf(state, content);
  if (bed === undefined) return undefined;
  const lying = Object.values(state.actors)
    .filter((a) => a.availability !== "dead" && onTheBed(state, bed, a))
    .map((a) => a.name)
    .sort();
  const wounded = openWounded(state);
  const units = medicalUnitsAboard(state, content);
  const reserve = config.medical.reserve;
  if (lying.length === 0 && wounded.length === 0 && units >= reserve) return undefined;
  const parts: string[] = [];
  parts.push(lying.length === 0 ? "the bed is empty" : `${lying.join(", ")} in the bed`);
  const care = wounded.flatMap((p) => holdersOf(state, p.id, "treatWounds")).sort();
  if (care.length > 0) parts.push(`${care.join(", ")} treating`);
  return `infirmary: ${parts.join(", ")}; ${kitsPhrase(units)} (the ship keeps ${reserve})`;
}
