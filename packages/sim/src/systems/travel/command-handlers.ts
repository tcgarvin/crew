/**
 * `setCourse` (PLAN §6 W6 item 1): valid only while docked, targeting a different port with a
 * known route. Enters `preparingDeparture` (or, while cargo work is open, plans the course and
 * waits docked — see `apply`); the travel system (`travel.ts`) then holds progress
 * there until ramps are closed, cargo is loaded and (if required) the bridge is staffed.
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
import type { CommandOfKind } from "../../core/types/commands";
import type { PortDefId } from "../../core/types/ids";
import { beginDeparture, hasOpenCargoWork } from "./travel";

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
  apply(ctx: ApplyCtx, command: CommandOfKind<"setCourse">): AppliedCommand {
    const travel = ctx.state.travel;
    if (travel.stage !== "docked") throw new Error("validated docked travel state vanished");
    const destinationPortId = command.payload.destinationPortId;
    if (hasOpenCargoWork(ctx)) {
      // Integration 2: freight is still moving through the open ramp; stay docked with the
      // course planned. The travel system begins departure prep once the cargo work is done.
      ctx.state.travel = {
        stage: "docked",
        portId: travel.portId,
        plannedDestinationId: destinationPortId,
      };
      return NO_TEMP_REFS;
    }
    beginDeparture(ctx, destinationPortId, causedBy(command));
    return NO_TEMP_REFS;
  },
};
