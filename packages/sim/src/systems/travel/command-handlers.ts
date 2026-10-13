/**
 * `setCourse` (PLAN §6 W6 item 1): valid only while docked, targeting a different, reachable
 * port. A neighbouring port is the next leg as before (and, while a voyage runs, a detour: the
 * voyage stays and the sim routes on from wherever the ship docks). A port beyond one hop
 * (passengers-and-galaxy §2.3) sets `voyageDestinationId` and makes the first hop of
 * `shortestPath` the leg. Either way this enters `preparingDeparture` (or, while cargo work is
 * open or (§course-plotting) the course has yet to be plotted at the nav terminal, plans the course
 * and waits docked — see `apply`; a course set is always unplotted); the travel system
 * (`travel.ts`) then holds progress there until ramps are closed, cargo is loaded and (if required)
 * the bridge is staffed.
 */
import {
  type AppliedCommand,
  type ApplyCtx,
  type CommandHandler,
  NO_TEMP_REFS,
  type ValidateCtx,
  type Validation,
  causedBy,
  ok,
  reject,
} from "../../core/commands";
import { portGraph } from "../../core/places";
import type { CommandOfKind } from "../../core/types/commands";
import type { MachineId, PortDefId } from "../../core/types/ids";
import { coursePlotRequired } from "./course";
import { impairmentKey } from "./departure-gate";
import { shortestPath } from "./graph";
import { livePassage } from "./in-hand";
import { beginDeparture, carriedVoyageFields, departureWaits, requestRamps } from "./travel";

interface SetCoursePlan {
  /** The leg to fly now: the destination itself, or the first hop towards it. */
  readonly nextHop: PortDefId;
  /** Set when the destination is beyond one hop. */
  readonly voyageDestinationId?: PortDefId;
}

export const setCourse: CommandHandler<"setCourse", SetCoursePlan> = {
  validate(ctx, command): Validation<SetCoursePlan> {
    const { destinationPortId } = command.payload;
    const travel = ctx.state.travel;
    if (travel.stage !== "docked") {
      return reject("preconditionFailed", `setCourse: not docked (stage "${travel.stage}")`);
    }
    if (destinationPortId === travel.portId) {
      return reject("invalidPayload", "setCourse: destination must differ from the current port");
    }
    // §settling-the-errand: the ship leaves a site when the expedition is over and the sim sets
    // the voyage home; a course while it is under way would lift off with the party ashore.
    const expedition = ctx.state.expedition;
    if (expedition !== undefined && expedition.phase !== "resolved") {
      return reject("preconditionFailed", "setCourse: an expedition is under way");
    }
    if (ctx.content.ports[destinationPortId] === undefined) {
      return reject("unknownEntity", `setCourse: unknown port "${destinationPortId}"`);
    }
    // Expeditions A2 call 2: a site is reachable only while it is known (an errand names it).
    const graph = portGraph(ctx.content, ctx.state, "known");
    const route = shortestPath(graph, travel.portId, destinationPortId);
    const nextHop = route?.path[1];
    if (route === undefined || nextHop === undefined) {
      return reject(
        "preconditionFailed",
        `setCourse: no route from "${travel.portId}" to "${destinationPortId}"`,
      );
    }
    // D50: a live passage is the voyage. A far destination that is not where the passenger is
    // bound would quietly replace it; a neighbour is a detour (the voyage stays, §2.3), and the
    // passenger's own port is fine (it is what the offer card itself sends).
    const passage = livePassage(ctx.state);
    if (passage !== undefined && route.path.length > 2 && destinationPortId !== passage.bound) {
      return reject(
        "preconditionFailed",
        `setCourse: a passenger is bound for "${passage.bound}" (job "${passage.job.id}"); only a detour to a neighbouring port is allowed`,
      );
    }
    return ok({
      nextHop,
      ...(route.path.length > 2 ? { voyageDestinationId: destinationPortId } : {}),
    });
  },
  apply(ctx: ApplyCtx, command: CommandOfKind<"setCourse">, plan: SetCoursePlan): AppliedCommand {
    const travel = ctx.state.travel;
    if (travel.stage !== "docked") throw new Error("validated docked travel state vanished");
    // A multi-hop destination starts (or replaces) a voyage; a neighbouring one leaves any
    // running voyage alone, which is what makes it a detour rather than a cancellation.
    if (plan.voyageDestinationId !== undefined) {
      travel.voyageDestinationId = plan.voyageDestinationId;
    }
    // §course-plotting: a new course is an unplotted one (a detour too: it re-raises
    // `courseToPlot`), and with a nav terminal aboard departure prep waits for the plot as it waits
    // for cargo.
    if (departureWaits(ctx) || coursePlotRequired(ctx)) {
      // Stay docked with the course planned; the travel system begins departure prep once
      // nothing holds the ship any more.
      ctx.state.travel = {
        stage: "docked",
        portId: travel.portId,
        plannedDestinationId: plan.nextHop,
        ...(travel.dockedSinceTick === undefined
          ? {}
          : { dockedSinceTick: travel.dockedSinceTick }),
        ...carriedVoyageFields(travel),
      };
      return NO_TEMP_REFS;
    }
    beginDeparture(ctx, plan.nextHop, causedBy(command));
    return NO_TEMP_REFS;
  },
};

// ---------------------------------------------------------------------------------------------
// §departure-gate options
// ---------------------------------------------------------------------------------------------

/** Both gate options need a planned departure: docked with a course set, or preparing to leave. */
function checkDeparturePlanned(
  ctx: ValidateCtx,
  machineId: MachineId,
  kind: string,
): Validation<null> {
  const travel = ctx.state.travel;
  const planned =
    (travel.stage === "docked" && travel.plannedDestinationId !== undefined) ||
    travel.stage === "preparingDeparture";
  if (!planned) {
    return reject(
      "preconditionFailed",
      `${kind}: no departure is planned (stage "${travel.stage}")`,
    );
  }
  if (ctx.state.machines[machineId] === undefined) {
    return reject("unknownEntity", `${kind}: unknown machine "${machineId}"`);
  }
  return ok(null);
}

export const holdDepartureForRepairs: CommandHandler<"holdDepartureForRepairs", null> = {
  validate(ctx, command): Validation<null> {
    return checkDeparturePlanned(ctx, command.payload.machineId, "holdDepartureForRepairs");
  },
  apply(ctx: ApplyCtx, command: CommandOfKind<"holdDepartureForRepairs">): AppliedCommand {
    let travel = ctx.state.travel;
    if (travel.stage === "preparingDeparture") {
      // §buying-parts: "hold for repairs" means wait *docked* (§departure-gate): back to the dock
      // with the course kept and the ramps open, so the crew can buy the part the repair is waiting
      // on from the port's market. The hold lifts into `beginDeparture` again once nothing is
      // impaired.
      const { fromPortId, toPortId } = travel;
      travel = {
        stage: "docked",
        portId: fromPortId,
        plannedDestinationId: toPortId,
        // §course-plotting: prep only began on a plotted course, and it is the same course.
        ...(coursePlotRequired(ctx) ? { coursePlotted: true as const } : {}),
        ...carriedVoyageFields(travel),
      };
      ctx.state.travel = travel;
      requestRamps(ctx, "open");
      ctx.emit({
        ...causedBy(command),
        type: "travelStageChanged",
        subjectIds: [],
        payload: { from: "preparingDeparture", to: "docked" },
      });
    }
    travel.holdForRepairs = true;
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete travel.departureRiskAccepted;
    ctx.emit({
      ...causedBy(command),
      type: "departureHeld",
      subjectIds: [command.payload.machineId],
      locationRef: { kind: "machine", machineId: command.payload.machineId },
      payload: { machineId: command.payload.machineId },
    });
    return NO_TEMP_REFS;
  },
};

export const acceptDepartureRisk: CommandHandler<"acceptDepartureRisk", null> = {
  validate(ctx, command): Validation<null> {
    return checkDeparturePlanned(ctx, command.payload.machineId, "acceptDepartureRisk");
  },
  apply(ctx: ApplyCtx, command: CommandOfKind<"acceptDepartureRisk">): AppliedCommand {
    const travel = ctx.state.travel;
    travel.departureRiskAccepted = true;
    // §2.3: remembered for the voyage, against the impaired set as it is now.
    travel.acceptedImpairmentKey = impairmentKey(ctx);
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete travel.holdForRepairs;
    ctx.emit({
      ...causedBy(command),
      type: "departureRiskAccepted",
      subjectIds: [command.payload.machineId],
      locationRef: { kind: "machine", machineId: command.payload.machineId },
      payload: { machineId: command.payload.machineId },
    });
    return NO_TEMP_REFS;
  },
};
