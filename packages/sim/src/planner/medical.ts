/**
 * Medicine in the planner (§convalescing, §treatment-at-the-medbay-bed, §the-medics-right), pure
 * over the `AgentView`:
 *
 * - `convalesceCandidate`: a crew member aboard with a wound nobody has treated (stun hits aside:
 *   the view leaves them out) goes to the medbay bed's `use` tile and waits there to be treated:
 *   essential while a wound bleeds or one is of a `medical.essentialSeverities` severity, routine
 *   for grazes alone (the wounded problem's rule, `systems/medical/medical.ts` `woundedUrgency`).
 *   Not for a passenger, not on the dock, not in a fight; not while backing off (after giving up
 *   with no kit aboard); not while they believe no `medical` item is aboard (`noMedicine`); and not
 *   while they believe someone else is at the bed (`bedTaken`: someone last seen on its `use`
 *   tile).
 * - `medicalTaskAllowed`: nobody treats or carries themselves (`ownWounds`).
 * - `isMedicalTask`: the task types whose rules these are (a treatment, §extraction's carry and
 *   §the-body-aboard's).
 *   Both are all hands: anyone awake (with the skill, to treat) answers, on duty or not
 *   (`candidates.ts`).
 * - `medicToWaitFor`: the medic's right to a treatment, in place of the generic deference.
 */
import type { TileCoord } from "../core/types/common";
import type { ActorId } from "../core/types/ids";
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView, ProblemView, TaskView, WoundView } from "../core/types/view";
import type { UrgencyClass } from "../core/types/work";
import type { Candidate, Rejection } from "./candidates";
import { backingOff, personal, sameTile } from "./common";

/** The personal activity's ref (and its backoff ref, `backoffRef.personal`). */
const CONVALESCE = "convalesce";

export function isMedicalTask(task: TaskView): boolean {
  return task.type === "treatWounds" || task.type === "carryCasualty" || task.type === "carryBody";
}

export function medicalTaskAllowed(view: AgentView, task: TaskView): boolean {
  return task.target.kind !== "actor" || task.target.actorId !== view.self.id;
}

/**
 * §convalescing: essential while a wound bleeds or is of a severity in
 * `medical.essentialSeverities`, routine for grazes alone.
 */
export function convalesceUrgency(
  untreated: readonly WoundView[],
  config: PlannerConfig,
): UrgencyClass {
  const essential = untreated.some(
    (wound) => wound.bleeding || config.medical.essentialSeverities.includes(wound.severity),
  );
  return essential ? "essentialOperation" : "routineObligation";
}

/**
 * §the-medics-right: the ship's medic the actor leaves a treatment to, if any. Someone below
 * `medical.medicLevel` leaves a `treatWounds` to a crew member on the roster (not themselves, not
 * the patient, not a passenger, not down) at or past it whom they believe awake and available
 * (their latest `actorStatus` sighting, any age; with none, the roster's word that they are up),
 * while the wounded problem is younger than `medical.waitForMedicSeconds`. A bleeding patient
 * never waits, and after that anyone with the skill treats. The highest skill wins, then the
 * roster's order.
 */
export function medicToWaitFor(
  view: AgentView,
  config: PlannerConfig,
  task: TaskView,
  problem: ProblemView,
): ActorId | undefined {
  if (task.type !== "treatWounds" || problem.kind !== "crewWounded") return undefined;
  if (problem.payload.bleeding === true) return undefined;
  const { medicLevel, waitForMedicSeconds } = config.medical;
  if ((view.self.skills.medical ?? 0) >= medicLevel) return undefined;
  if (view.tick - problem.createdTick >= waitForMedicSeconds * config.time.tickRate) {
    return undefined;
  }
  let best: { id: ActorId; level: number } | undefined;
  for (const member of view.roster()) {
    const id = member.actorId;
    if (id === view.self.id || id === problem.payload.actorId) continue;
    if (member.passenger === true || member.down === true) continue;
    const level = member.skills.medical ?? 0;
    if (level < medicLevel) continue;
    const status = view.fact(id, "actorStatus")?.value;
    if (status !== undefined && (status.availability !== "available" || status.asleep)) continue;
    if (best === undefined || level > best.level) best = { id, level };
  }
  return best?.id;
}

/**
 * Does the actor believe a `medical` item is aboard (in hand or on the floor), or know of a
 * treatment of their wounds (the task is derived only with a kit aboard, and the board is public)?
 * Why the task: a kit restocked in port is stowed where the wounded may never have looked.
 */
function knowsMedicine(view: AgentView): boolean {
  if (view.knownItems().some((item) => !item.absent && item.tags.includes("medical"))) return true;
  return view
    .knownTasks()
    .some(
      (task) =>
        task.type === "treatWounds" &&
        task.target.kind === "actor" &&
        task.target.actorId === view.self.id,
    );
}

/** Someone else last seen lying on the bed's `use` tile, and not dead. */
function bedTaken(view: AgentView, tile: TileCoord): boolean {
  return view
    .facts()
    .some(
      (fact) =>
        fact.factType === "actorStatus" &&
        fact.subjectId !== view.self.id &&
        fact.value.availability !== "dead" &&
        fact.value.tile !== undefined &&
        sameTile(fact.value.tile, tile),
    );
}

export function convalesceCandidate(
  view: AgentView,
  config: PlannerConfig,
): Candidate | Rejection | undefined {
  const self = view.self;
  const untreated = self.body.wounds.filter((wound) => !wound.treated);
  if (untreated.length === 0) return undefined;
  if (self.passenger === true || self.onDock === true || self.combatant !== undefined) {
    return undefined;
  }
  const bed = view.schematic.amenities("medBed")[0];
  const tile = bed?.interactionTiles.find((t) => t.purposes.includes("use"))?.tile;
  if (bed === undefined || tile === undefined || self.tile === undefined) return undefined;
  if (backingOff(view, CONVALESCE)) return { ref: CONVALESCE, reason: "backoff" };
  if (!knowsMedicine(view)) return { ref: CONVALESCE, reason: "noMedicine" };
  const atBed = sameTile(self.tile, tile);
  if (!atBed && bedTaken(view, tile)) return { ref: CONVALESCE, reason: "bedTaken" };
  const ticks = atBed ? 0 : view.estimateTravelTicks(tile);
  if (ticks === null) return { ref: CONVALESCE, reason: "unreachableTarget" };
  return personal(CONVALESCE, convalesceUrgency(untreated, config), ticks, view.tick, {
    kind: "personal",
    activity: "convalesce",
    targetId: bed.machineId,
  });
}
