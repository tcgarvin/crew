import { configTicks } from "../../core/clock";
/**
 * Commerce command handlers (PLAN §6 W6 items 3–4): `offerJob`, `acceptContract`, `declineJob`.
 */
import {
  type AppliedCommand,
  type ApplyCtx,
  type CommandHandler,
  NO_TEMP_REFS,
  type Validation,
  ok,
  reject,
} from "../../core/commands";
import { allocateId } from "../../core/ids";
import type { CommandOfKind } from "../../core/types/commands";
import type { DecisionId, JobId } from "../../core/types/ids";
import type { Job } from "../../core/types/travel";
import { commandActor } from "../travel/roster";
import { acceptJob, cargoClassOf, checkPriceBand } from "./jobs";

// ---------------------------------------------------------------------------------------------
// offerJob
// ---------------------------------------------------------------------------------------------

export const offerJob: CommandHandler<"offerJob", null> = {
  validate(ctx, command): Validation<null> {
    const { job } = command.payload;
    const problem = checkPriceBand(ctx, job.fromPortId, job.toPortId, job.cargo, job.pay);
    if (problem !== null) return reject("outOfBounds", `offerJob: ${problem}`);
    for (const line of job.cargo) {
      if (!Number.isInteger(line.count) || line.count < 1) {
        return reject("invalidPayload", "offerJob: cargo count must be a positive integer");
      }
      if (ctx.defs.item(line.itemDefId) === undefined) {
        return reject("unknownEntity", `offerJob: unknown item "${line.itemDefId}"`);
      }
    }
    return ok(null);
  },
  apply(ctx: ApplyCtx, command: CommandOfKind<"offerJob">): AppliedCommand {
    const { job: draft, surface } = command.payload;
    const jobId: JobId = allocateId(ctx.state, "job");
    // Validated by `checkPriceBand` above: every cargo line shares one `CargoClass`.
    const cargoClass = cargoClassOf(ctx, draft.cargo) ?? "general";
    const job: Job = {
      id: jobId,
      origin: command.source === "narrator" ? "narrator" : "portBoard",
      issuer: draft.issuer,
      description: draft.description,
      fromPortId: draft.fromPortId,
      toPortId: draft.toPortId,
      cargo: [...draft.cargo],
      cargoClass,
      pay: draft.pay,
      status: "offered",
      offeredTick: ctx.tick,
      expiresAtTick: ctx.tick + configTicks(ctx.config, ctx.config.commerce.jobOfferTtlSeconds),
      cargoItemIds: [],
      causeCommandId: command.id,
    };
    ctx.state.jobs[jobId] = job;
    ctx.emit({
      type: "jobOffered",
      subjectIds: [jobId],
      causeIds: [command.id],
      source: command.source,
      payload: { jobId },
    });
    if (surface) {
      const decisionId: DecisionId = allocateId(ctx.state, "decision");
      ctx.state.decisions.records[decisionId] = {
        id: decisionId,
        origin: command.source === "narrator" ? "narrator" : "policy",
        perspectiveActorId: commandActor(ctx.state),
        prompt: {
          key: "job.offer",
          params: { issuer: job.issuer, pay: job.pay, from: job.fromPortId, to: job.toPortId },
        },
        left: {
          label: { key: "job.offer.accept", params: {} },
          commands: [{ kind: "acceptContract", payload: { jobId } }],
        },
        right: {
          label: { key: "job.offer.decline", params: {} },
          commands: [{ kind: "declineJob", payload: { jobId } }],
        },
        status: "pending",
        createdTick: ctx.tick,
        jobId,
      };
      ctx.state.decisions.queue.push(decisionId);
    }
    return NO_TEMP_REFS;
  },
};

// ---------------------------------------------------------------------------------------------
// acceptContract
// ---------------------------------------------------------------------------------------------

export const acceptContract: CommandHandler<"acceptContract", null> = {
  validate(ctx, command): Validation<null> {
    const job = ctx.state.jobs[command.payload.jobId];
    if (job === undefined) return reject("unknownEntity", `unknown job "${command.payload.jobId}"`);
    if (job.status !== "offered") {
      return reject(
        "preconditionFailed",
        `job "${job.id}" is not offered (status "${job.status}")`,
      );
    }
    const travel = ctx.state.travel;
    if (travel.stage !== "docked" || travel.portId !== job.fromPortId) {
      return reject("preconditionFailed", `acceptContract: not docked at "${job.fromPortId}"`);
    }
    return ok(null);
  },
  apply(ctx: ApplyCtx, command: CommandOfKind<"acceptContract">): AppliedCommand {
    const job = ctx.state.jobs[command.payload.jobId];
    if (job === undefined) throw new Error("validated job vanished");
    job.status = "accepted";
    job.cargoItemIds = acceptJob(ctx, job);
    ctx.emit({
      type: "jobAccepted",
      subjectIds: [job.id],
      causeIds: [command.id],
      source: command.source,
      payload: { jobId: job.id },
    });
    ctx.state.narrator.lastNarrativeEvent = { tick: ctx.tick, type: "jobAccepted" };
    return NO_TEMP_REFS;
  },
};

// ---------------------------------------------------------------------------------------------
// declineJob
// ---------------------------------------------------------------------------------------------

export const declineJob: CommandHandler<"declineJob", null> = {
  validate(ctx, command): Validation<null> {
    const job = ctx.state.jobs[command.payload.jobId];
    if (job === undefined) return reject("unknownEntity", `unknown job "${command.payload.jobId}"`);
    if (job.status !== "offered") {
      return reject(
        "preconditionFailed",
        `job "${job.id}" is not offered (status "${job.status}")`,
      );
    }
    return ok(null);
  },
  apply(ctx: ApplyCtx, command: CommandOfKind<"declineJob">): AppliedCommand {
    const job = ctx.state.jobs[command.payload.jobId];
    if (job === undefined) throw new Error("validated job vanished");
    job.status = "declined";
    ctx.emit({
      type: "jobDeclined",
      subjectIds: [job.id],
      causeIds: [command.id],
      source: command.source,
      payload: { jobId: job.id },
    });
    return NO_TEMP_REFS;
  },
};
