/**
 * `setCourse` (PLAN §6 W6 item 1): valid only while docked, targeting a different port with a
 * known route. Enters `preparingDeparture`; the travel system (`travel.ts`) then holds progress
 * there until ramps are closed, cargo is loaded and (if required) the bridge is staffed.
 */
import {
  type AppliedCommand,
  type ApplyCtx,
  type CommandHandler,
  NO_TEMP_REFS,
  type ValidateCtx,
  type Validation,
  ok,
  reject,
} from "../../core/commands";
import type { CommandOfKind } from "../../core/types/commands";
import type { PortDefId } from "../../core/types/ids";

function findRoute(
  ctx: Pick<ValidateCtx, "content">,
  fromPortId: PortDefId,
  toPortId: PortDefId,
): number | undefined {
  const port = ctx.content.ports[fromPortId];
  return port?.routes.find((r) => r.toPortId === toPortId)?.distance;
}

interface SetCoursePlan {
  readonly distance: number;
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
    if (ctx.content.ports[destinationPortId] === undefined) {
      return reject("unknownEntity", `setCourse: unknown port "${destinationPortId}"`);
    }
    const distance = findRoute(ctx, travel.portId, destinationPortId);
    if (distance === undefined) {
      return reject(
        "preconditionFailed",
        `setCourse: no route from "${travel.portId}" to "${destinationPortId}"`,
      );
    }
    return ok({ distance });
  },
  apply(ctx: ApplyCtx, command: CommandOfKind<"setCourse">, plan: SetCoursePlan): AppliedCommand {
    const travel = ctx.state.travel;
    if (travel.stage !== "docked") throw new Error("validated docked travel state vanished");
    ctx.state.travel = {
      stage: "preparingDeparture",
      fromPortId: travel.portId,
      toPortId: command.payload.destinationPortId,
      stageProgress: 0,
      routeProgress: 0,
      routeDistance: plan.distance,
      drifting: false,
      stageStartedTick: ctx.tick,
    };
    ctx.emit({
      type: "travelStageChanged",
      subjectIds: [],
      causeIds: [command.id],
      source: command.source,
      payload: { from: "docked", to: "preparingDeparture" },
    });
    return NO_TEMP_REFS;
  },
};
