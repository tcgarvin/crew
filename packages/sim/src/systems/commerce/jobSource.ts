/**
 * Deterministic job source (PLAN §6 W6 item 4: "NullNarrator job source"). While docked, offers
 * one job at a time from the port's `JobTemplateDef`s over the `commerce` rng stream (SD §5.4
 * names it for exactly this), issued as a queued `offerJob` command with `source: "system"`,
 * `surface: true` — the same command path a real narrator would use (see `jobs.ts` module doc),
 * so the game has content offline.
 *
 * Integration 2 (job-board loop fix): the board used to refill whenever fewer than `boardSize`
 * offers were open, and every offer surfaces a decision, so a host that resolves decisions at
 * once saw a fresh offer (and, on accept, a fresh manifest) every tick. The source now stays
 * quiet while:
 *  - an offer at this port is still open, or any job decision is queued (one at a time);
 *  - a job is `accepted` and not yet under way (the ship leaves before the next offer);
 *  - an offer at this port was declined or expired less than `config.commerce.reofferSeconds`
 *    ago;
 *  - a course is already planned from this port.
 */
import { configTicks } from "../../core/clock";
import type { Command, JobDraft, QueuedCommand } from "../../core/types/commands";
import type { JobTemplateDef, PortDef } from "../../core/types/content";
import type { CommandId, PortDefId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import { checkPriceBand } from "./jobs";

/**
 * What the source did this tick: `issued` an offer, stayed `quiet` by the rules above, or found
 * itself free to offer but with `nothing` to offer (no usable template); the `jobBoard` hook is
 * raised only in the last case.
 */
export type JobSourceOutcome = "issued" | "quiet" | "nothing";

function isQuiet(ctx: StepCtx, portId: PortDefId): boolean {
  const travel = ctx.state.travel;
  if (travel.stage !== "docked" || travel.plannedDestinationId !== undefined) return true;
  const decisions = ctx.state.decisions;
  if (decisions.queue.some((id) => decisions.records[id]?.jobId !== undefined)) return true;
  const cooldownTicks = configTicks(ctx.config, ctx.config.commerce.reofferSeconds);
  let offered = 0;
  for (const job of Object.values(ctx.state.jobs)) {
    if (job.status === "accepted") return true;
    if (job.fromPortId !== portId) continue;
    if (job.status === "offered") offered += 1;
    if (
      (job.status === "declined" || job.status === "expired") &&
      job.closedTick !== undefined &&
      ctx.tick - job.closedTick < cooldownTicks
    ) {
      return true;
    }
  }
  if (offered > 0) return true;
  // An offer issued last tick applies this tick's phase 1; guard against a same-tick repeat.
  return ctx.state.commands.queue.some((c) => c.kind === "offerJob");
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

/** Offer at most one job while docked (see the module doc for when it stays quiet). */
export function runJobSource(ctx: StepCtx): JobSourceOutcome {
  const travel = ctx.state.travel;
  if (travel.stage !== "docked") return "quiet";
  const portId = travel.portId;
  if (isQuiet(ctx, portId)) return "quiet";
  const port = ctx.content.ports[portId];
  if (port === undefined || port.jobTemplates.length === 0) return "nothing";
  for (let attempt = 0; attempt < port.jobTemplates.length * 2; attempt++) {
    const template = ctx.rng.weighted(
      "commerce",
      port.jobTemplates.map((t) => ({ item: t, weight: t.weight })),
    );
    const draft = draftFromTemplate(ctx, portId, port, template);
    if (draft === null) continue;
    if (checkPriceBand(ctx, draft.fromPortId, draft.toPortId, draft.cargo, draft.pay) !== null)
      continue;
    enqueueSystemCommand(ctx, {
      id: `cmd:jobsource:${ctx.tick}` as CommandId,
      source: "system",
      kind: "offerJob",
      payload: { job: draft, surface: true },
    });
    return "issued";
  }
  return "nothing";
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
