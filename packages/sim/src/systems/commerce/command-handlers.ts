import { configTicks } from "../../core/clock";
import { newActor } from "../../core/command-handlers";
/**
 * Commerce command handlers (PLAN §6 W6 items 3–4): `offerJob`, `acceptContract`, `declineJob`.
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
import { findCrewDef, findItemDef } from "../../core/defs";
import { allocateId } from "../../core/ids";
import type { BoundaryLocation, CommandOfKind, CommandRejection } from "../../core/types/commands";
import type { PhysicalLocation } from "../../core/types/common";
import type { CrewDef, ItemDef } from "../../core/types/content";
import type {
  CrewDefId,
  DecisionId,
  EntityId,
  ItemDefId,
  JobId,
  TempRef,
} from "../../core/types/ids";
import type { Item } from "../../core/types/ship";
import type { Job } from "../../core/types/travel";
import { commandActor } from "../travel/roster";
import { portStoreLocation } from "../travel/travel";
import {
  DEFAULT_PITCH_KEY,
  acceptJob,
  cargoClassOf,
  cargoStowageZoneKey,
  checkPriceBand,
  issuerLabel,
  normaliseIssuer,
  spawnCargoItem,
} from "./jobs";

// ---------------------------------------------------------------------------------------------
// offerJob
// ---------------------------------------------------------------------------------------------

/**
 * Params for the offer card's `job.offer` template (`@crew/content` renders them): the person,
 * the route, the cargo kind, the urgency and the pitch (its prose, or its key when it has none).
 * D24: pay is deliberately absent, so no card can print it.
 */
function offerPromptParams(job: Job): Record<string, string> {
  const person = job.issuerPerson;
  const firstLine = job.cargo[0];
  const pitch = job.pitch.prose;
  return {
    issuer: job.issuer,
    name: person.name,
    role: person.role,
    ...(person.org === undefined ? {} : { org: person.org }),
    from: job.fromPortId,
    to: job.toPortId,
    ...(firstLine === undefined ? {} : { cargo: firstLine.itemDefId }),
    urgency: job.urgency,
    ...(pitch === undefined || pitch.trim() === "" ? { pitchKey: job.pitch.key } : { pitch }),
  };
}

export const offerJob: CommandHandler<"offerJob", null> = {
  validate(ctx, command): Validation<null> {
    const { job } = command.payload;
    const issuer = normaliseIssuer(job.issuer);
    if (issuer.name === "" || issuer.role === "") {
      return reject("invalidPayload", "offerJob: the issuer needs a name and a role");
    }
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
    const issuerPerson = normaliseIssuer(draft.issuer);
    const job: Job = {
      id: jobId,
      origin: command.source === "narrator" ? "narrator" : "portBoard",
      issuer: issuerLabel(issuerPerson),
      issuerPerson,
      pitch: draft.pitch ?? { key: DEFAULT_PITCH_KEY, params: {} },
      urgency: draft.urgency ?? "relaxed",
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
        prompt: { key: "job.offer", params: offerPromptParams(job) },
        // Integration 2: accepting also sets course for the job's destination. `setCourse`
        // applies after `acceptContract` in the same resolution, sees the freshly raised
        // `cargoToLoad` problems and holds departure until the freight is aboard.
        left: {
          label: { key: "job.offer.accept", params: {} },
          commands: [
            { kind: "acceptContract", payload: { jobId } },
            { kind: "setCourse", payload: { destinationPortId: job.toPortId } },
          ],
          aftermath: { key: "job.accept.aftermath", params: {} },
        },
        right: {
          label: { key: "job.offer.decline", params: {} },
          commands: [{ kind: "declineJob", payload: { jobId } }],
          aftermath: { key: "job.decline.aftermath", params: {} },
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
    job.closedTick = ctx.tick;
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

// ---------------------------------------------------------------------------------------------
// spawnAtBoundary (D6, review §D.3): commerce owns the external stores this creates into.
// ---------------------------------------------------------------------------------------------

const BOUNDARY_TEMP_REF_PATTERN = /^\$[A-Za-z0-9_]+$/;

/**
 * `BoundaryLocation` excludes on-deck/aboard kinds at the type level (only `portStore` and
 * `jobManifest` exist), so this only rejects a real "not a boundary" location; the `default`
 * branch exists to catch a hand-built/untyped payload that bypassed the type checker.
 */
function checkBoundaryLocation(
  ctx: ValidateCtx,
  location: BoundaryLocation,
): CommandRejection | null {
  switch (location.kind) {
    case "portStore": {
      const port = ctx.content.ports[location.portId];
      if (port === undefined) {
        return {
          code: "unknownEntity",
          reason: `spawnAtBoundary: unknown port "${location.portId}"`,
        };
      }
      if (!port.externalStores.some((s) => s.key === location.storeKey)) {
        return {
          code: "unknownEntity",
          reason: `spawnAtBoundary: port "${location.portId}" has no store "${location.storeKey}"`,
        };
      }
      return null;
    }
    case "jobManifest": {
      const job = ctx.state.jobs[location.jobId];
      if (job === undefined) {
        return {
          code: "unknownEntity",
          reason: `spawnAtBoundary: unknown job "${location.jobId}"`,
        };
      }
      if (job.status !== "accepted") {
        return {
          code: "preconditionFailed",
          reason: `spawnAtBoundary: job "${location.jobId}" is not accepted (status "${job.status}")`,
        };
      }
      return null;
    }
    default:
      return { code: "outOfBounds", reason: "spawnAtBoundary: boundaryOnly" };
  }
}

interface SpawnBoundaryPlan {
  readonly newItemDefs: readonly ItemDef[];
  readonly newCrewDefs: readonly CrewDef[];
  readonly location: BoundaryLocation;
}

export const spawnAtBoundary: CommandHandler<"spawnAtBoundary", SpawnBoundaryPlan> = {
  validate(ctx, command): Validation<SpawnBoundaryPlan> {
    const { defs, spawns, location } = command.payload;
    if (!Array.isArray(spawns) || spawns.length === 0) {
      return reject("invalidPayload", "spawnAtBoundary needs at least one spawn");
    }
    const locationRejection = checkBoundaryLocation(ctx, location);
    if (locationRejection !== null) return { ok: false, rejection: locationRejection };
    if (location.kind === "jobManifest" && spawns.some((s) => s.kind === "npc")) {
      return reject("invalidPayload", "spawnAtBoundary: an npc cannot spawn into a job manifest");
    }

    // New per-game defs (review §C.6): `gen.` namespace, not already known anywhere.
    const newItemIds = new Set<ItemDefId>();
    for (const def of defs.items) {
      if (!def.id.startsWith("gen.")) {
        return reject(
          "invalidPayload",
          `spawnAtBoundary: item def "${def.id}" must be in the "gen." namespace`,
        );
      }
      if (findItemDef(ctx.content, ctx.state, def.id) !== undefined || newItemIds.has(def.id)) {
        return reject("invalidPayload", `spawnAtBoundary: item def "${def.id}" already exists`);
      }
      newItemIds.add(def.id);
    }
    const newCrewIds = new Set<CrewDefId>();
    for (const def of defs.crew) {
      if (!def.id.startsWith("gen.")) {
        return reject(
          "invalidPayload",
          `spawnAtBoundary: crew def "${def.id}" must be in the "gen." namespace`,
        );
      }
      if (findCrewDef(ctx.content, ctx.state, def.id) !== undefined || newCrewIds.has(def.id)) {
        return reject("invalidPayload", `spawnAtBoundary: crew def "${def.id}" already exists`);
      }
      newCrewIds.add(def.id);
    }
    const draftItems = new Map(defs.items.map((d) => [d.id, d] as const));
    const draftCrew = new Map(defs.crew.map((d) => [d.id, d] as const));

    const refs = new Set<TempRef>();
    for (const spawn of spawns) {
      if (!BOUNDARY_TEMP_REF_PATTERN.test(spawn.tempRef)) {
        return reject("invalidPayload", `spawnAtBoundary: bad temp ref "${spawn.tempRef}"`);
      }
      if (refs.has(spawn.tempRef)) {
        return reject("invalidPayload", `spawnAtBoundary: duplicate temp ref "${spawn.tempRef}"`);
      }
      refs.add(spawn.tempRef);
      if (spawn.kind === "item") {
        const def =
          findItemDef(ctx.content, ctx.state, spawn.itemDefId) ?? draftItems.get(spawn.itemDefId);
        if (def === undefined) {
          return reject("unknownEntity", `spawnAtBoundary: unknown item def "${spawn.itemDefId}"`);
        }
        if (!Number.isInteger(spawn.count) || spawn.count < 1) {
          return reject("invalidPayload", "spawnAtBoundary: count must be an integer >= 1");
        }
        if (def.stacking === "unique") {
          if (spawn.count !== 1) {
            return reject(
              "invalidPayload",
              `spawnAtBoundary: unique item "${def.id}" must spawn with count 1`,
            );
          }
        } else if (spawn.count > def.maxStack) {
          return reject(
            "outOfBounds",
            `spawnAtBoundary: count ${spawn.count} exceeds maxStack ${def.maxStack}`,
          );
        }
        if (spawn.count > ctx.config.narrator.maxSpawnsPerCommand) {
          return reject(
            "outOfBounds",
            `spawnAtBoundary: count ${spawn.count} exceeds maxSpawnsPerCommand ${ctx.config.narrator.maxSpawnsPerCommand}`,
          );
        }
      } else {
        const def =
          findCrewDef(ctx.content, ctx.state, spawn.crewDefId) ?? draftCrew.get(spawn.crewDefId);
        if (def === undefined) {
          return reject("unknownEntity", `spawnAtBoundary: unknown crew def "${spawn.crewDefId}"`);
        }
      }
    }

    if (spawns.length > ctx.state.narrator.budget.spawnsRemaining) {
      return reject("budgetExhausted", "spawnAtBoundary: narrator spawn budget exhausted");
    }

    return ok({ newItemDefs: defs.items, newCrewDefs: defs.crew, location });
  },
  apply(
    ctx: ApplyCtx,
    command: CommandOfKind<"spawnAtBoundary">,
    plan: SpawnBoundaryPlan,
  ): AppliedCommand {
    const { state } = ctx;
    for (const def of plan.newItemDefs) state.defs.dynamic.items[def.id] = def;
    for (const def of plan.newCrewDefs) state.defs.dynamic.crew[def.id] = def;

    state.narrator.budget.spawnsRemaining -= command.payload.spawns.length;

    const cause = causedBy(command);
    let job: Job | undefined;
    let physicalLocation: PhysicalLocation;
    let stowageZoneKey = "cargoHold";
    if (plan.location.kind === "portStore") {
      physicalLocation = {
        kind: "inExternalStore",
        portId: plan.location.portId,
        storeKey: plan.location.storeKey,
      };
    } else {
      job = state.jobs[plan.location.jobId];
      if (job === undefined) throw new Error("validated job vanished");
      physicalLocation = portStoreLocation(ctx.defs.port(job.fromPortId));
      stowageZoneKey = cargoStowageZoneKey(ctx) ?? "cargoHold";
    }

    const tempRefs: Record<TempRef, EntityId> = {};
    for (const spawn of command.payload.spawns) {
      if (spawn.kind === "item") {
        const def = ctx.defs.item(spawn.itemDefId);
        let id: EntityId;
        if (job !== undefined) {
          const itemId = spawnCargoItem(
            ctx,
            job,
            def,
            spawn.count,
            def.stacking,
            physicalLocation,
            stowageZoneKey,
            cause,
          );
          job.cargoItemIds.push(itemId);
          id = itemId;
        } else {
          const newId = allocateId(state, "item");
          const item: Item =
            def.stacking === "unique"
              ? {
                  id: newId,
                  defId: def.id,
                  stacking: "unique",
                  location: physicalLocation,
                  condition: 1,
                }
              : {
                  id: newId,
                  defId: def.id,
                  stacking: "stack",
                  location: physicalLocation,
                  count: spawn.count,
                  reserved: 0,
                };
          state.items[newId] = item;
          ctx.caches.dirty.inventory = true;
          ctx.emit({
            ...cause,
            type: "entitySpawned",
            subjectIds: [newId],
            payload: { entityId: newId, defId: def.id },
          });
          id = newId;
        }
        tempRefs[spawn.tempRef] = id;
      } else {
        const def = ctx.defs.crew(spawn.crewDefId);
        const id = allocateId(state, "actor");
        state.actors[id] = newActor(id, def, physicalLocation);
        ctx.emit({
          ...cause,
          type: "entitySpawned",
          subjectIds: [id],
          payload: { entityId: id, defId: def.id },
        });
        tempRefs[spawn.tempRef] = id;
      }
    }
    return { tempRefs };
  },
};
