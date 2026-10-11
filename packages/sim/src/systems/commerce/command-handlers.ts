/**
 * Commerce command handlers (PLAN §6 W6 items 3–4): `offerJob`, `acceptContract`, `declineJob`,
 * and (passengers-and-galaxy §4.2) `endPassage`.
 */
import { dayTicks } from "../../core/clock";
import { newActor } from "../../core/command-handlers";
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
import { heldCard } from "../../core/delivery";
import { allocateId } from "../../core/ids";
import { ensureMarket } from "../../core/markets";
import { siteNearPort } from "../../core/places";
import type {
  BoundaryLocation,
  CommandOfKind,
  CommandRejection,
  CommandSource,
  JobDraft,
} from "../../core/types/commands";
import type { PhysicalLocation } from "../../core/types/common";
import type { CrewDef, ItemDef } from "../../core/types/content";
import { STAGING_LIMITS } from "../../core/types/dockside";
import type { EntityId, JobId, TempRef } from "../../core/types/ids";
import {
  type CargoLine,
  ERRAND_KINDS,
  ERRAND_WANTS,
  type Job,
  type JobErrand,
} from "../../core/types/travel";
import { shortestPath } from "../travel/graph";
import { jobBlockingAcceptance } from "../travel/in-hand";
import { portStoreLocation } from "../travel/travel";
import {
  DEFAULT_PITCH_KEY,
  acceptJob,
  cargoClassOf,
  cargoStowageZoneKey,
  checkErrandBand,
  checkPassageBand,
  checkPriceBand,
  clampCargoToMaxCrates,
  dockedAtOrigin,
  freightSpawnLocations,
  issuerLabel,
  normaliseIssuer,
  spawnCargoItem,
  spawnItem,
  surfaceOfferCard,
} from "./jobs";
import { PASSENGER_CREW_DEF_ID, endPassageEarly, spawnPassenger } from "./passage";

/** The job a validated command names; validation guaranteed it exists. */
function validatedJob(ctx: ApplyCtx, jobId: JobId): Job {
  const job = ctx.state.jobs[jobId];
  if (job === undefined) throw new Error("validated job vanished");
  return job;
}

/** The job `jobId` names as the plan, while it is still on offer. */
function offeredJob(
  ctx: ValidateCtx,
  jobId: JobId,
): Validation<ValidateCtx["state"]["jobs"][JobId]> {
  const job = ctx.state.jobs[jobId];
  if (job === undefined) return reject("unknownEntity", `unknown job "${jobId}"`);
  if (job.status !== "offered") {
    return reject("preconditionFailed", `job "${job.id}" is not offered (status "${job.status}")`);
  }
  return ok(job);
}

// ---------------------------------------------------------------------------------------------
// offerJob
// ---------------------------------------------------------------------------------------------

/**
 * Passengers §3.1: a passage's luggage is zero or one line; its count beyond one unit is ignored
 * (the line becomes one piece of luggage). Two lines are a malformed draft and are rejected.
 */
function luggageOf(cargo: readonly CargoLine[]): CargoLine[] {
  const [line] = cargo;
  return line === undefined ? [] : [{ itemDefId: line.itemDefId, count: 1 }];
}

type ErrandDraft = NonNullable<JobDraft["errand"]>;
type Problem = { readonly code: CommandRejection["code"]; readonly reason: string };

const oneOf = (list: readonly string[], value: unknown): boolean =>
  typeof value === "string" && list.includes(value);

/**
 * Expeditions A2 (§6): why an errand draft cannot be offered, or undefined. It returns where it
 * starts (`toPortId === fromPortId`) from a landing site whose near port that port reaches; it
 * names its target (a name a cast entry may carry), names an item exactly when it fetches one (and
 * then wants it `either` way), carries no cargo and nobody rides on it; and its pay is inside the
 * errand band (`checkErrandBand`) unless the narrator named it.
 */
function errandProblem(ctx: ValidateCtx, job: JobDraft, errand: ErrandDraft): Problem | undefined {
  const invalid = (reason: string): Problem => ({ code: "invalidPayload", reason });
  if (!oneOf(ERRAND_KINDS, errand.kind)) {
    return invalid(`an errand's kind must be one of ${ERRAND_KINDS.join(", ")}`);
  }
  if (job.toPortId !== job.fromPortId) {
    return invalid("an errand comes back where it starts (toPortId must be fromPortId)");
  }
  if (ctx.content.ports[job.fromPortId] === undefined) {
    return { code: "unknownEntity", reason: `unknown port "${job.fromPortId}"` };
  }
  if (ctx.content.ports[errand.siteId] === undefined) {
    return { code: "unknownEntity", reason: `unknown site "${errand.siteId}"` };
  }
  const near = siteNearPort(ctx.content, errand.siteId);
  if (near === undefined) return invalid(`"${errand.siteId}" is a port, not a site`);
  if (shortestPath(ctx.content.ports, job.fromPortId, near) === undefined) {
    return {
      code: "preconditionFailed",
      reason: `no route from "${job.fromPortId}" to "${near}", the site's near port`,
    };
  }
  const target = typeof errand.targetName === "string" ? errand.targetName.trim() : "";
  if (target === "") return invalid("an errand names its target");
  if (target.length > STAGING_LIMITS.nameChars) {
    return invalid(`the target's name is longer than ${STAGING_LIMITS.nameChars} characters`);
  }
  if (errand.kind === "fetchItem") {
    if (errand.itemDefId === undefined) return invalid("a fetchItem names its item");
    if (findItemDef(ctx.content, ctx.state, errand.itemDefId) === undefined) {
      return { code: "unknownEntity", reason: `unknown item "${errand.itemDefId}"` };
    }
  } else if (errand.itemDefId !== undefined) {
    return invalid("only a fetchItem names an item");
  }
  if (!oneOf(ERRAND_WANTS, errand.wants)) {
    return invalid(`an errand wants its target ${ERRAND_WANTS.join(", ")}`);
  }
  if (errand.kind === "fetchItem" && errand.wants !== "either") {
    return invalid('a fetchItem wants its item "either" way');
  }
  if (job.cargo.length > 0) return invalid("an errand carries no cargo");
  if (job.passenger === true || job.roundTrip === true) return invalid("an errand is no passage");
  // §money-levers: a named pay stands in for the band (`namedPayProblem`).
  if (job.payNamed === true) return undefined;
  const band = checkErrandBand(ctx, job.fromPortId, errand.siteId, job.pay);
  return band === null ? undefined : { code: "outOfBounds", reason: band };
}

/** The job's errand as offered: the draft's, trimmed, coming home to `fromPortId`. */
function errandOf(draft: JobDraft, errand: ErrandDraft): JobErrand {
  return {
    kind: errand.kind,
    siteId: errand.siteId,
    targetName: errand.targetName.trim(),
    ...(errand.itemDefId === undefined ? {} : { itemDefId: errand.itemDefId }),
    wants: errand.wants,
    returnToPortId: draft.fromPortId,
  };
}

/**
 * §money-levers: why a named pay (`JobDraft.payNamed`) cannot stand, or undefined. Only the
 * narrator and a scenario name a sum; it is a whole number of credits, positive and at most
 * `config.narrator.maxOfferPay`, and it then replaces the band check.
 */
function namedPayProblem(
  ctx: ValidateCtx,
  source: CommandSource,
  job: JobDraft,
): Problem | undefined {
  if (job.payNamed === undefined) return undefined;
  if (job.payNamed !== true) return { code: "invalidPayload", reason: "payNamed must be true" };
  if (source !== "narrator" && source !== "scenario") {
    return { code: "unauthorized", reason: `a ${source} offer cannot name its pay` };
  }
  const max = ctx.config.narrator.maxOfferPay;
  if (!Number.isInteger(job.pay) || job.pay <= 0) {
    return { code: "invalidPayload", reason: "a named pay is a positive whole number of credits" };
  }
  if (job.pay > max) {
    return { code: "outOfBounds", reason: `a named pay of ${job.pay} is over the cap of ${max}` };
  }
  return undefined;
}

export const offerJob: CommandHandler<"offerJob", null> = {
  validate(ctx, command): Validation<null> {
    const { job } = command.payload;
    const issuer = normaliseIssuer(job.issuer);
    if (issuer.name === "" || issuer.role === "") {
      return reject("invalidPayload", "offerJob: the issuer needs a name and a role");
    }
    // §offer-cards: an offer is put to the captain in person, at the
    // dock, so a surfaced offer needs the ship docked at its origin. A quiet one may be posted
    // anywhere (scenarios and tests use that).
    if (command.payload.surface && !dockedAtOrigin(ctx.state, job)) {
      return reject(
        "preconditionFailed",
        `offerJob: a surfaced offer is made in person, docked at "${job.fromPortId}"`,
      );
    }
    const passenger = job.passenger === true;
    const roundTrip = job.roundTrip === true;
    if (roundTrip && !passenger) {
      return reject(
        "invalidPayload",
        "offerJob: roundTrip needs passenger (freight has no return)",
      );
    }
    const named = namedPayProblem(ctx, command.source, job);
    if (named !== undefined) return reject(named.code, `offerJob: ${named.reason}`);
    if (job.errand !== undefined) {
      const problem = errandProblem(ctx, job, job.errand);
      if (problem !== undefined) return reject(problem.code, `offerJob: ${problem.reason}`);
    } else if (passenger) {
      if (job.cargo.length > 1) {
        return reject("invalidPayload", "offerJob: a passage carries at most one line of luggage");
      }
      if (findCrewDef(ctx.content, ctx.state, PASSENGER_CREW_DEF_ID) === undefined) {
        return reject("unknownEntity", `offerJob: no "${PASSENGER_CREW_DEF_ID}" crew template`);
      }
      const fare = checkPassageBand(ctx, job.fromPortId, job.toPortId, roundTrip, job.pay);
      if (fare !== null && job.payNamed !== true) return reject("outOfBounds", `offerJob: ${fare}`);
    } else {
      const problem = checkPriceBand(ctx, job.fromPortId, job.toPortId, job.cargo, job.pay);
      if (problem !== null && job.payNamed !== true) {
        return reject("outOfBounds", `offerJob: ${problem}`);
      }
    }
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
    const passenger = draft.passenger === true;
    // Validated by `checkPriceBand` above: every cargo line shares one `CargoClass`. A passage's
    // class is its luggage's (or `general`); its pay was banded by `checkPassageBand` instead.
    const cargoClass = cargoClassOf(ctx, draft.cargo) ?? "general";
    const issuerPerson = normaliseIssuer(draft.issuer);
    // Owner feedback 2026-09-30: freight now spawns as individual crates on acceptance
    // (`acceptJob`), so a haul stays short by capping units here, at offer time.
    // §money-levers: a named pay is the sum the narrator chose, so capping the crates keeps it.
    const clamped = clampCargoToMaxCrates(
      draft.cargo,
      draft.pay,
      ctx.config.commerce.maxCratesPerJob,
    );
    const { cargo, pay } = passenger
      ? { cargo: luggageOf(draft.cargo), pay: draft.pay }
      : { cargo: clamped.cargo, pay: draft.payNamed === true ? draft.pay : clamped.pay };
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
      cargo,
      cargoClass,
      pay,
      status: "offered",
      offeredTick: ctx.tick,
      expiresAtTick: ctx.tick + dayTicks(ctx.config, ctx.config.commerce.jobOfferTtlDays),
      cargoItemIds: [],
      causeCommandId: command.id,
      // `actorId` is a placeholder until acceptance spawns the passenger (`acceptContract`).
      ...(passenger
        ? { passage: { actorId: "" as never, roundTrip: draft.roundTrip === true, leg: "out" } }
        : {}),
      ...(draft.errand === undefined ? {} : { errand: errandOf(draft, draft.errand) }),
    };
    ctx.state.jobs[jobId] = job;
    // §offered-freight, §dock-hand-errands: alongside the origin's dock, commerce's sweep this tick
    // sends a dock hand out with the freight (or sets it out at once at a dock with no warehouse
    // door); an offer made in flight is staged the same way when that dock comes alongside.
    // §offer-cards: validated docked at the origin; the card is held until the captain meets the
    // issuer.
    const decisionId = surface ? surfaceOfferCard(ctx, job) : undefined;
    const held = decisionId !== undefined && heldCard(ctx.state, decisionId) !== undefined;
    ctx.emit({
      type: "jobOffered",
      subjectIds: [jobId],
      causeIds: [command.id],
      source: command.source,
      // §delivered-tick: an offer whose card waits for the meeting is not in the log before it: the
      // card is.
      ...(held ? { significance: "trace" as const } : {}),
      payload: { jobId },
    });
    return NO_TEMP_REFS;
  },
};

// ---------------------------------------------------------------------------------------------
// acceptContract
// ---------------------------------------------------------------------------------------------

export const acceptContract: CommandHandler<"acceptContract", null> = {
  validate(ctx, command): Validation<null> {
    const offered = offeredJob(ctx, command.payload.jobId);
    if (!offered.ok) return offered;
    const job = offered.plan;
    const travel = ctx.state.travel;
    if (travel.stage !== "docked" || travel.portId !== job.fromPortId) {
      return reject("preconditionFailed", `acceptContract: not docked at "${job.fromPortId}"`);
    }
    // §one-job-in-hand, D50: one job at a time. Offers can wait (the card stays, "Pass" is always
    // open); taking one while another is still under way is refused.
    const inHand = jobBlockingAcceptance(ctx.state);
    if (inHand !== undefined && inHand.id !== job.id) {
      return reject(
        "preconditionFailed",
        `acceptContract: a job is already in hand (job "${inHand.id}", status "${inHand.status}")`,
      );
    }
    return ok(null);
  },
  apply(ctx: ApplyCtx, command: CommandOfKind<"acceptContract">): AppliedCommand {
    const job = validatedJob(ctx, command.payload.jobId);
    job.status = "accepted";
    // Passengers §3.5: the passenger boards at the personnel ramp; luggage spawns as freight.
    if (job.passage !== undefined)
      job.passage.actorId = spawnPassenger(ctx, job, causedBy(command));
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
    const offered = offeredJob(ctx, command.payload.jobId);
    return offered.ok ? ok(null) : offered;
  },
  apply(ctx: ApplyCtx, command: CommandOfKind<"declineJob">): AppliedCommand {
    const job = validatedJob(ctx, command.payload.jobId);
    job.status = "declined";
    job.closedTick = ctx.tick;
    ctx.emit({
      type: "jobDeclined",
      subjectIds: [job.id],
      causeIds: [command.id],
      source: command.source,
      payload: { jobId: job.id },
    });
    // §dock-hand-errands: commerce's sweep this tick sends a dock hand to cart the staged crates
    // back in.
    return NO_TEMP_REFS;
  },
};

// ---------------------------------------------------------------------------------------------
// endPassage (passengers §4.2): the captain puts a passenger off, or leaves one behind.
// ---------------------------------------------------------------------------------------------

export const endPassage: CommandHandler<"endPassage", null> = {
  validate(ctx, command): Validation<null> {
    const job = ctx.state.jobs[command.payload.jobId];
    if (job === undefined) return reject("unknownEntity", `unknown job "${command.payload.jobId}"`);
    if (job.passage === undefined) {
      return reject("preconditionFailed", `endPassage: job "${job.id}" carries no passenger`);
    }
    if (job.passage.endReason !== undefined) {
      return reject("preconditionFailed", `endPassage: passage "${job.id}" already ended`);
    }
    if (job.status !== "accepted" && job.status !== "inTransit" && job.status !== "delivered") {
      return reject("preconditionFailed", `endPassage: job "${job.id}" is ${job.status}`);
    }
    return ok(null);
  },
  apply(ctx: ApplyCtx, command: CommandOfKind<"endPassage">): AppliedCommand {
    const job = validatedJob(ctx, command.payload.jobId);
    endPassageEarly(ctx, job, causedBy(command));
    return NO_TEMP_REFS;
  },
};

// ---------------------------------------------------------------------------------------------
// stockMarket (§market-stock): what a port sells. Narrator and scenario only; never money, never
// aboard.
// ---------------------------------------------------------------------------------------------

export const stockMarket: CommandHandler<"stockMarket", null> = {
  validate(ctx, command): Validation<null> {
    const { portId, itemDefId, count, price } = command.payload;
    if (ctx.content.ports[portId] === undefined) {
      return reject("unknownEntity", `stockMarket: unknown port "${portId}"`);
    }
    if (findItemDef(ctx.content, ctx.state, itemDefId) === undefined) {
      return reject("unknownEntity", `stockMarket: unknown item "${itemDefId}"`);
    }
    const max = ctx.config.commerce.market.maxStockPerCommand;
    if (!Number.isInteger(count) || count < 0) {
      return reject("invalidPayload", "stockMarket: count must be an integer >= 0");
    }
    if (count > max) {
      return reject("outOfBounds", `stockMarket: count ${count} exceeds maxStockPerCommand ${max}`);
    }
    if (!Number.isInteger(price) || price < 1) {
      return reject("invalidPayload", "stockMarket: price must be an integer >= 1");
    }
    return ok(null);
  },
  apply(ctx: ApplyCtx, command: CommandOfKind<"stockMarket">): AppliedCommand {
    const { portId, itemDefId, count, price } = command.payload;
    const market = ensureMarket(ctx.state, ctx.content, portId);
    market[itemDefId] = { count, price };
    ctx.emit({
      ...causedBy(command),
      type: "marketStocked",
      subjectIds: [],
      locationRef: { kind: "port", portId },
      payload: { portId, itemDefId, count, price },
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
function checkBoundaryLocation(ctx: ValidateCtx, location: BoundaryLocation): Validation<null> {
  switch (location.kind) {
    case "portStore": {
      const port = ctx.content.ports[location.portId];
      if (port === undefined) {
        return reject("unknownEntity", `spawnAtBoundary: unknown port "${location.portId}"`);
      }
      if (!port.externalStores.some((s) => s.key === location.storeKey)) {
        return reject(
          "unknownEntity",
          `spawnAtBoundary: port "${location.portId}" has no store "${location.storeKey}"`,
        );
      }
      return ok(null);
    }
    case "jobManifest": {
      const job = ctx.state.jobs[location.jobId];
      if (job === undefined) {
        return reject("unknownEntity", `spawnAtBoundary: unknown job "${location.jobId}"`);
      }
      if (job.status !== "accepted") {
        return reject(
          "preconditionFailed",
          `spawnAtBoundary: job "${location.jobId}" is not accepted (status "${job.status}")`,
        );
      }
      return ok(null);
    }
    default:
      return reject("outOfBounds", "spawnAtBoundary: boundaryOnly");
  }
}

/** New per-game defs (review §C.6): `gen.` namespace, not already known anywhere. */
function checkNewDefs<Id extends string>(
  kind: "item" | "crew",
  defs: readonly { readonly id: Id }[],
  findKnown: (id: Id) => unknown,
): Validation<null> {
  const seen = new Set<Id>();
  for (const def of defs) {
    if (!def.id.startsWith("gen.")) {
      return reject(
        "invalidPayload",
        `spawnAtBoundary: ${kind} def "${def.id}" must be in the "gen." namespace`,
      );
    }
    if (findKnown(def.id) !== undefined || seen.has(def.id)) {
      return reject("invalidPayload", `spawnAtBoundary: ${kind} def "${def.id}" already exists`);
    }
    seen.add(def.id);
  }
  return ok(null);
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
    const locationCheck = checkBoundaryLocation(ctx, location);
    if (!locationCheck.ok) return locationCheck;
    if (location.kind === "jobManifest" && spawns.some((s) => s.kind === "npc")) {
      return reject("invalidPayload", "spawnAtBoundary: an npc cannot spawn into a job manifest");
    }

    // New per-game defs (review §C.6): `gen.` namespace, not already known anywhere.
    const itemDefsCheck = checkNewDefs("item", defs.items, (id) =>
      findItemDef(ctx.content, ctx.state, id),
    );
    if (!itemDefsCheck.ok) return itemDefsCheck;
    const crewDefsCheck = checkNewDefs("crew", defs.crew, (id) =>
      findCrewDef(ctx.content, ctx.state, id),
    );
    if (!crewDefsCheck.ok) return crewDefsCheck;
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
        } else if (location.kind === "portStore" && spawn.count > def.maxStack) {
          // A job-manifest spawn no longer becomes one stack of `count` (see `apply` below: it
          // spawns `count` individual unit crates), so `maxStack` does not bound it; only the
          // `maxSpawnsPerCommand` check below does.
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

    // §narrator-lever-budgets: advice, never a refusal; it may go below zero.
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
      // An npc never spawns into a manifest (validated), so this is only where a manifest npc
      // would have gone; manifest items get their own spots below.
      physicalLocation = portStoreLocation(ctx.defs.port(job.fromPortId));
      stowageZoneKey = cargoStowageZoneKey(ctx) ?? "cargoHold";
    }

    const tempRefs: Record<TempRef, EntityId> = {};
    for (const spawn of command.payload.spawns) {
      if (spawn.kind === "item") {
        const def = ctx.defs.item(spawn.itemDefId);
        let id: EntityId;
        if (job !== undefined) {
          // Owner feedback 2026-09-30: a narrator manifest spawn is `spawn.count` individual
          // crates, not one stack, so loading reads one unit at a time (see `jobs.ts` `acceptJob`,
          // which spawns the same way for the deterministic job source's manifests).
          // §offered-freight: on the origin's staging area when its dock is alongside, else in its
          // store.
          const locations = freightSpawnLocations(ctx, job.fromPortId, spawn.count);
          const ids = locations.map((location) =>
            spawnCargoItem(ctx, job, def, 1, def.stacking, location, stowageZoneKey, cause),
          );
          job.cargoItemIds.push(...ids);
          const [firstId] = ids;
          if (firstId === undefined) {
            throw new Error("spawnAtBoundary: validated count >= 1 produced no items");
          }
          id = firstId;
        } else {
          id = spawnItem(ctx, def, spawn.count, def.stacking, physicalLocation, cause, {});
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
