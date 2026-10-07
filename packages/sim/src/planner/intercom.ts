/**
 * The reporting reflex (D94, slice 5 call 12), pure over the `AgentView`: on alert, someone who
 * has seen damage first-hand that the crew do not all know of walks to the nearest panel they
 * believe working and reports it (`report`, containment class: above the essential work it
 * reports, so a cook mid-repair goes to the panel first). Nothing off alert.
 *
 * What counts as news: an open damage problem (`machineDamaged`, `hullScar`, `machineSymptom`)
 * raised since the alert sounded, still `discovered`, that the actor holds by direct sight. The
 * broadcast makes what it carries `public` (`systems/intercom/report.ts`), which is what ends
 * the reflex: a second witness, or the reporter on their next look, finds nothing left that is
 * not common knowledge, so the same damage is never reported twice. A machine's `machineStatus`
 * alone is not news: a status has no public marker, so reporting it would never end; damage
 * that dims a machine raises a problem of its own (damage's `machineDamaged`, equipment's
 * symptoms), and the report carries the status along with it.
 *
 * Owner: W3 of ship life slice 5.
 */
import type { DeepReadonly, TileCoord } from "../core/types/common";
import type { MachineId } from "../core/types/ids";
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView, AlertView, MachinePlacementView, ProblemView } from "../core/types/view";
import type { ProblemKind } from "../core/types/work";
import type { Candidate, Rejection } from "./candidates";
import { backingOff, personal } from "./common";

/** The problem kinds a report carries (call 12's damage facts). */
export const REPORTED_PROBLEM_KINDS: ReadonlySet<ProblemKind> = new Set<ProblemKind>([
  "machineDamaged",
  "hullScar",
  "machineSymptom",
]);

/** The backoff ref of a report at `panelId` (what `startPersonal` sets when its plan fails). */
export const reportRef = (panelId: MachineId): string => `report:${panelId}`;

/**
 * Damage the actor has seen for themselves on this alert that the crew have not all heard of.
 * Exported for tests; the sim's broadcast applies the same rule to the reporter's truth.
 */
export function unreportedDamage(view: AgentView, alert: AlertView): ProblemView[] {
  return view
    .knownProblems()
    .filter(
      (problem) =>
        REPORTED_PROBLEM_KINDS.has(problem.kind) &&
        problem.visibility === "discovered" &&
        problem.createdTick >= alert.sinceTick &&
        view.fact(problem.id, "problem")?.evidence === "direct",
    );
}

/** A panel's `operate` tile (where the report is made). */
function panelTile(panel: DeepReadonly<MachinePlacementView>): TileCoord | undefined {
  return panel.interactionTiles.find((t) => t.purposes.includes("operate"))?.tile;
}

/** Last seen dead or switched off: the actor will not walk to it. Unseen panels are trusted. */
function believedBroken(view: AgentView, panelId: MachineId): boolean {
  const status = view.fact(panelId, "machineStatus")?.value.status;
  return status === "failed" || status === "off";
}

export function reportCandidate(
  view: AgentView,
  config: PlannerConfig,
): Candidate | Rejection | undefined {
  const alert = view.alert();
  if (alert === undefined) return undefined;
  if (unreportedDamage(view, alert).length === 0) return undefined;
  if (view.self.tile === undefined) return { ref: "report", reason: "offDeck" };
  let best: { panelId: MachineId; ticks: number } | undefined;
  for (const panel of view.schematic.amenities("comm")) {
    if (believedBroken(view, panel.machineId) || backingOff(view, reportRef(panel.machineId))) {
      continue;
    }
    const tile = panelTile(panel);
    const ticks = tile === undefined ? null : view.estimateTravelTicks(tile);
    if (ticks === null) continue;
    if (best === undefined || ticks < best.ticks) best = { panelId: panel.machineId, ticks };
  }
  if (best === undefined) return { ref: "report", reason: "noWorkingPanel" };
  const reportTicks = Math.ceil(config.intercom.reportSeconds * config.time.tickRate);
  return personal(reportRef(best.panelId), "containment", best.ticks + reportTicks, view.tick, {
    kind: "personal",
    activity: "report",
    targetId: best.panelId,
  });
}
