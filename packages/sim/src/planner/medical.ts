/**
 * Medicine in the planner (§convalescing, §treatment-at-the-medbay-bed), pure over the `AgentView`:
 *
 * - `convalesceCandidate`: a crew member aboard with a wound nobody has treated (stun hits aside:
 *   the view leaves them out) goes to the medbay bed's `use` tile and waits there to be treated:
 *   essential while a wound bleeds, routine after. Not for a passenger, not on the dock, not in a
 *   fight; not while backing off (after giving up with no kit aboard); not while they believe no
 *   `medical` item is aboard (`noMedicine`); and not while they believe someone else is at the bed
 *   (`bedTaken`: someone last seen on its `use` tile).
 * - `medicalTaskAllowed`: nobody treats their own wounds (`ownWounds`).
 * - `isMedicalTask`: the task type whose rules these are. A treatment is all hands: anyone awake
 *   with the skill answers it, on duty or not (`candidates.ts`).
 */
import type { TileCoord } from "../core/types/common";
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView, TaskView } from "../core/types/view";
import type { Candidate, Rejection } from "./candidates";
import { backingOff, personal, sameTile } from "./common";

/** The personal activity's ref (and its backoff ref, `backoffRef.personal`). */
const CONVALESCE = "convalesce";

export function isMedicalTask(task: TaskView): boolean {
  return task.type === "treatWounds";
}

export function medicalTaskAllowed(view: AgentView, task: TaskView): boolean {
  return task.target.kind !== "actor" || task.target.actorId !== view.self.id;
}

/** Does the actor believe a `medical` item is aboard (in hand or on the floor)? */
function knowsMedicine(view: AgentView): boolean {
  return view.knownItems().some((item) => !item.absent && item.tags.includes("medical"));
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
  _config: PlannerConfig,
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
  const bleeding = untreated.some((wound) => wound.bleeding);
  return personal(
    CONVALESCE,
    bleeding ? "essentialOperation" : "routineObligation",
    ticks,
    view.tick,
    { kind: "personal", activity: "convalesce", targetId: bed.machineId },
  );
}
