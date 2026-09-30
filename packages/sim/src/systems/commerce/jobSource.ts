import type { Command, JobDraft, QueuedCommand } from "../../core/types/commands";
/**
 * Deterministic job source (PLAN §6 W6 item 4: "NullNarrator job source"). While docked with
 * fewer than `config.commerce.boardSize` offered jobs at this port, generates 1–2 from the port's
 * `JobTemplateDef`s over the `commerce` rng stream (SD §5.4 names it for exactly this) and issues
 * them as queued `offerJob` commands with `source: "system"`, `surface: true` — the same command
 * path a real narrator would use (see `jobs.ts` module doc), so the game has content offline.
 */
import type { JobTemplateDef, PortDef } from "../../core/types/content";
import type { CommandId, PortDefId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import { checkPriceBand } from "./jobs";

const MAX_JOBS_PER_TICK = 2;

function offeredJobsAtPort(ctx: Pick<StepCtx, "state">, portId: PortDefId): number {
  return Object.values(ctx.state.jobs).filter(
    (j) => j.status === "offered" && j.fromPortId === portId,
  ).length;
}

function draftFromTemplate(
  ctx: Pick<StepCtx, "content" | "config" | "rng">,
  fromPortId: PortDefId,
  fromPort: PortDef,
  template: JobTemplateDef,
): JobDraft | null {
  const distance = fromPort.routes.find((r) => r.toPortId === template.toPortId)?.distance;
  if (distance === undefined || template.cargo.length === 0) return null;
  const cargo = template.cargo.map((line) => ({
    itemDefId: line.itemDefId,
    count: ctx.rng.int("commerce", line.countMin, line.countMax),
  }));
  const firstLine = cargo[0];
  if (firstLine === undefined) return null;
  const cargoClass = ctx.content.items[firstLine.itemDefId]?.cargoClass;
  if (cargoClass === undefined) return null;
  const band = ctx.config.commerce.priceBands[cargoClass];
  const units = cargo.reduce((sum, l) => sum + l.count, 0);
  const min = Math.ceil(band.min * distance * units);
  const max = Math.floor(band.max * distance * units);
  const pay = max < min ? min : ctx.rng.int("commerce", min, max);
  return {
    issuer: template.issuer,
    description: { key: "job.template", params: { template: template.key } },
    fromPortId,
    toPortId: template.toPortId,
    cargo,
    pay,
  };
}

/** Generate up to `MAX_JOBS_PER_TICK` offers and enqueue them as `offerJob` commands. */
export function runJobSource(ctx: StepCtx): void {
  const travel = ctx.state.travel;
  if (travel.stage !== "docked") return;
  const portId = travel.portId;
  const port = ctx.content.ports[portId];
  if (port === undefined || port.jobTemplates.length === 0) return;
  const boardSize = ctx.config.commerce.boardSize;
  let existing = offeredJobsAtPort(ctx, portId);
  let issued = 0;
  let attempts = 0;
  while (
    existing < boardSize &&
    issued < MAX_JOBS_PER_TICK &&
    attempts < port.jobTemplates.length * 2
  ) {
    attempts += 1;
    const template = ctx.rng.weighted(
      "commerce",
      port.jobTemplates.map((t) => ({ item: t, weight: t.weight })),
    );
    const draft = draftFromTemplate(ctx, portId, port, template);
    if (draft === null) continue;
    if (checkPriceBand(ctx, draft.fromPortId, draft.toPortId, draft.cargo, draft.pay) !== null)
      continue;
    enqueueSystemCommand(ctx, {
      id: `cmd:jobsource:${ctx.tick}:${issued}` as CommandId,
      source: "system",
      kind: "offerJob",
      payload: { job: draft, surface: true },
    });
    existing += 1;
    issued += 1;
  }
}

/**
 * Push a command straight onto `state.commands.queue`, to apply next tick through the normal
 * `applyDueCommands` -> `offerJob` handler path (which revalidates it). W6 decision: a system
 * running inside the pipeline has a `StepCtx`, not the `World`/`KernelRegistry` that
 * `enqueueCommand` (core/commands.ts) needs, so it inserts directly rather than calling it; the
 * insertion order matches `enqueueCommand`'s (`(applyAtTick, seq)`).
 */
function enqueueSystemCommand(ctx: StepCtx, command: Command): void {
  const queue = ctx.state.commands.queue;
  const applyAtTick = ctx.tick + 1;
  const queued = { ...command, applyAtTick, seq: ctx.state.commands.nextSeq } as QueuedCommand;
  ctx.state.commands.nextSeq += 1;
  let insertAt = queue.length;
  while (insertAt > 0 && (queue[insertAt - 1] as QueuedCommand).applyAtTick > applyAtTick) {
    insertAt -= 1;
  }
  queue.splice(insertAt, 0, queued);
}
