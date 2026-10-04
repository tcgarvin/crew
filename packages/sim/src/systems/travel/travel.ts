/**
 * Travel state machine (SD §17.1, PLAN §6 W6 item 1).
 *
 * `docked -> preparingDeparture -> undocking -> departing -> transit -> approaching -> docking ->
 * docked`. Runs every tick in the "equipment" phase (PHASES[3]) alongside power/equipment, since
 * travel progress depends on the engine's output the same way a machine's does.
 *
 * Dockside (D61): travel owns the dock's lifetime. The port's dock map (if content has one) is
 * grafted alongside at the start of `docking` and cast off at the end of `undocking`; departure
 * prep keeps the ramps down and calls everyone on the dock aboard before raising them
 * (`ashore.ts`).
 */
import { configTicks } from "../../core/clock";
import { dockForPort, dockedPortOf, isOnDock } from "../../core/docks";
import { raiseHookIfIdle } from "../../core/hooks";
import { allocateId } from "../../core/ids";
import { affordableUnits } from "../../core/markets";
import type { PortDef } from "../../core/types/content";
import type { EventDraft } from "../../core/types/events";
import type { DeckDefId, DoorId, MachineId, PortDefId, ProblemId } from "../../core/types/ids";
import type { ReadonlyWorldState, StepCtx, System } from "../../core/types/pipeline";
import type { Machine } from "../../core/types/ship";
import type {
  DepartureGateFlags,
  DockStaging,
  TravelStage,
  TravelState,
  VoyageFields,
} from "../../core/types/travel";
import type { ProblemOfKind } from "../../core/types/work";
import { shipDeckId } from "../../core/world";
import { attachDock, detachDock } from "../spatial/dock";
import { syncRampPassability } from "../spatial/geometry";
import { clearDock, endRecall, peopleAshore, recallAshore } from "./ashore";
import { departureCleared } from "./departure-gate";
import { nextHop } from "./graph";
import { dismissLocals, dressDockAlongside } from "./locals";
import { stageDockIfDue, stagingAnswered } from "./staging";
import { portStoreLocation } from "./stores";
import { operateTiles } from "./tasks";

export { portStoreLocation } from "./stores";

/** Travel away from the dock: the stage objects that carry route progress. */
export type InFlight = Extract<TravelState, { stage: Exclude<TravelStage, "docked"> }>;

// ---------------------------------------------------------------------------------------------
// Propulsion
// ---------------------------------------------------------------------------------------------

/**
 * `W6 decision`: propulsion factor is the mean `output` of every `on` machine tagged `engine`
 * (0 for `standby`/`off`); `output` already folds in power/heat/fault derating (SD §9), so travel
 * does not re-derive it. A ship with no engine machine (test fixtures) is treated as unconstrained
 * (factor 1) rather than permanently drifting.
 */
function propulsionFactor(ctx: Pick<StepCtx, "state" | "content">): number {
  const engines = Object.values(ctx.state.machines).filter(
    (m) => ctx.content.machines[m.defId]?.tags.includes("engine") === true,
  );
  if (engines.length === 0) return 1;
  const sum = engines.reduce((acc, m) => acc + (m.actualMode === "on" ? m.output : 0), 0);
  return sum / engines.length;
}

// ---------------------------------------------------------------------------------------------
// Ramps and staffing (departure/docking preconditions)
// ---------------------------------------------------------------------------------------------

/**
 * V1 is single-ship/single-deck (common.ts W0 decision); the one deck the ship uses: the world's
 * (`shipDeckId`), not the bundle's first, which may hold other footprints.
 */
export function theDeckId(ctx: Pick<StepCtx, "state">): DeckDefId {
  return shipDeckId(ctx.state);
}

function rampDoorIds(ctx: Pick<StepCtx, "state" | "content">): DoorId[] {
  const deckId = theDeckId(ctx);
  return Object.values(ctx.state.doors)
    .filter((d) => d.deckId === deckId && d.kind === "ramp")
    .map((d) => d.id);
}

/**
 * Request every ramp door to `state`; the door system (W3) drives the physical transition.
 * Planning stops routing across a ramp the moment it is asked up (Dockside spike), so the nav
 * cache is told now rather than at the door system's next run.
 */
export function requestRamps(
  ctx: Pick<StepCtx, "state" | "content" | "caches">,
  state: "open" | "closed",
): void {
  for (const doorId of rampDoorIds(ctx)) {
    const door = ctx.state.doors[doorId];
    if (door !== undefined) door.requestedState = state;
  }
  syncRampPassability(ctx.state, ctx.caches);
}

function rampsClosed(ctx: Pick<StepCtx, "state" | "content">): boolean {
  const doorIds = rampDoorIds(ctx);
  return doorIds.every((id) => ctx.state.doors[id]?.physicalState === "closed");
}

/** A `pilotStation`-tagged machine whose def requires an operator: V1's "bridge console". */
function bridgeConsole(ctx: Pick<StepCtx, "state" | "content">): Machine | undefined {
  return Object.values(ctx.state.machines).find((m) => {
    const def = ctx.content.machines[m.defId];
    return def?.tags.includes("pilotStation") && def.operation.requiresOperator === true;
  });
}

/**
 * V1 staffing check (thin, per PLAN §6 item 1): any crew actor within 1 tile of one of the
 * console's `operate` interaction positions. W4 will replace this with a real claimed
 * `stationToStaff` task.
 */
function isStaffed(
  ctx: Pick<StepCtx, "state" | "content">,
  console_: Machine | undefined,
): boolean {
  if (console_ === undefined) return true;
  const positions = operateTiles(ctx, console_.id);
  if (positions.length === 0) return true;
  const deckId = theDeckId(ctx);
  return Object.values(ctx.state.actors).some((actor) => {
    const location = actor.location;
    // Passengers §3.2: a passenger standing by the console is not staffing it.
    if (!actor.crew || actor.passenger === true) return false;
    if (location.kind !== "onDeck" || location.deckId !== deckId) return false;
    return positions.some(
      (p) => Math.abs(location.x - (p.x + 0.5)) <= 1 && Math.abs(location.y - (p.y + 0.5)) <= 1,
    );
  });
}

// ---------------------------------------------------------------------------------------------
// stationToStaff problem bookkeeping
// ---------------------------------------------------------------------------------------------

/** Open (or revise) `stationToStaff` while unstaffed; resolve it once staffed. Owner: travel. */
function updateStaffingProblem(ctx: StepCtx, machineId: MachineId, staffed: boolean): void {
  const dedupeKey = `stationToStaff:${machineId}`;
  const existing = Object.values(ctx.state.work.problems).find(
    (p) => p.dedupeKey === dedupeKey && p.status === "open",
  ) as ProblemOfKind<"stationToStaff"> | undefined;
  if (staffed) {
    if (existing !== undefined) existing.status = "resolved";
    return;
  }
  if (existing !== undefined) return;
  const id = allocateId(ctx.state, "problem") as ProblemId;
  ctx.state.work.problems[id] = {
    id,
    kind: "stationToStaff",
    payload: { machineId },
    owner: "travel",
    visibility: "public",
    dedupeKey,
    status: "open",
    createdTick: ctx.tick,
    revision: 1,
    baseUrgency: "essentialOperation",
    location: { kind: "machine", machineId },
  };
}

/** Is the bridge staffed (or does it need nobody)? Keeps its `stationToStaff` problem in step. */
function checkStaffing(ctx: StepCtx): boolean {
  const console_ = bridgeConsole(ctx);
  const staffed = isStaffed(ctx, console_);
  if (console_ !== undefined) updateStaffingProblem(ctx, console_.id, staffed);
  return staffed;
}

// ---------------------------------------------------------------------------------------------
// Stage durations
// ---------------------------------------------------------------------------------------------

function stageDurationTicks(
  ctx: StepCtx,
  stage: Exclude<TravelStage, "docked" | "transit">,
): number {
  const t = ctx.config.travel;
  const seconds = {
    preparingDeparture: t.prepareDepartureSeconds,
    undocking: t.undockSeconds,
    departing: t.departSeconds,
    approaching: t.approachSeconds,
    docking: t.dockSeconds,
  }[stage];
  return configTicks(ctx.config, seconds);
}

const STAGE_ORDER: readonly Exclude<TravelStage, "docked">[] = [
  "preparingDeparture",
  "undocking",
  "departing",
  "transit",
  "approaching",
  "docking",
];

function nextStage(stage: InFlight["stage"]): TravelStage {
  return STAGE_ORDER[STAGE_ORDER.indexOf(stage) + 1] ?? "docked";
}

function emitStageChanged(ctx: StepCtx, from: TravelStage, to: TravelStage): void {
  ctx.emit({
    type: "travelStageChanged",
    subjectIds: [],
    causeIds: [],
    source: "sim",
    payload: { from, to },
  });
}

function findRoute(port: PortDef, toPortId: PortDefId): number | undefined {
  return port.routes.find((r) => r.toPortId === toPortId)?.distance;
}

// ---------------------------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------------------------

/**
 * D63: freight of a job taken at the port alongside (`accepted`, or `inTransit` once departure
 * prep has begun) still lying on the dock, i.e. not yet loaded. Its `cargoToLoad` is normally
 * open too; this holds the ship even if that work were gone, since a crate on the dock is left
 * behind when the dock goes.
 */
function acceptedFreightOnDock(ctx: Pick<StepCtx, "state" | "content">): boolean {
  const portId = dockedPortOf(ctx.state.travel);
  if (ctx.state.deck.dock === undefined || portId === undefined) return false;
  return Object.values(ctx.state.jobs).some(
    (job) =>
      (job.status === "accepted" || job.status === "inTransit") &&
      job.fromPortId === portId &&
      job.cargoItemIds.some((itemId) => {
        const location = ctx.state.items[itemId]?.location;
        return location !== undefined && isOnDock(ctx.content, ctx.state, location);
      }),
  );
}

/** Open freight work of `kinds`, or accepted freight on the dock (D63). */
function hasOpenFreightWork(
  ctx: Pick<StepCtx, "state" | "content">,
  kinds: readonly ("cargoToLoad" | "cargoToUnload")[],
): boolean {
  return (
    Object.values(ctx.state.work.problems).some(
      (p) => p.status === "open" && (kinds as readonly string[]).includes(p.kind),
    ) || acceptedFreightOnDock(ctx)
  );
}

/** Freight still to load: open `cargoToLoad` work, or accepted freight on the dock (D63). */
function hasOpenLoading(ctx: Pick<StepCtx, "state" | "content">): boolean {
  return hasOpenFreightWork(ctx, ["cargoToLoad"]);
}

/** Open freight work (either direction) that must finish before the ship may leave. */
function hasOpenCargoWork(ctx: Pick<StepCtx, "state" | "content">): boolean {
  return hasOpenFreightWork(ctx, ["cargoToLoad", "cargoToUnload"]);
}

/**
 * D47 at a waypoint: an open `partsNeeded` the crew could answer at this port's market (stock
 * and money allow at least one unit), i.e. one that derives a runnable `buyParts` task. The
 * voyage waits for it, so a stalled repair can buy its part on the way through.
 */
function hasRunnableBuyPartsWork(ctx: Pick<StepCtx, "state" | "content">): boolean {
  const travel = ctx.state.travel;
  if (travel.stage !== "docked") return false;
  return Object.values(ctx.state.work.problems).some(
    (p) =>
      p.kind === "partsNeeded" &&
      p.status === "open" &&
      affordableUnits(ctx.state, ctx.content, travel.portId, p.payload.itemDefId, p.payload.count) >
        0,
  );
}

/**
 * Passengers §3.3: the ship is docked and a passenger keeps it there: a round-trip passenger
 * ashore at this port whose passage has not ended (the voyage home waits for them, course kept,
 * ramps open), or one walking down the ramp to leave (`Actor.disembarking`, §3.5/§4.2). Returns
 * their name, for the headline.
 */
export function waitingForPassenger(
  state: Pick<ReadonlyWorldState, "travel" | "jobs" | "actors">,
): string | undefined {
  const travel = state.travel;
  if (travel.stage !== "docked") return undefined;
  for (const job of Object.values(state.jobs)) {
    const passage = job.passage;
    if (passage === undefined) continue;
    const actor = state.actors[passage.actorId];
    if (actor?.disembarking === true) return actor.name;
    if (passage.leg !== "ashore" || passage.endReason !== undefined) continue;
    if (job.toPortId !== travel.portId) continue;
    return actor?.name ?? job.issuerPerson.name;
  }
  return undefined;
}

/**
 * A decision card is queued for the captain (any origin), or (D70) one is on its way to them in
 * person: the ship does not leave while someone is walking over with word.
 */
function hasPendingDecision(ctx: Pick<StepCtx, "state">): boolean {
  const { records, queue, held } = ctx.state.decisions;
  return held.length > 0 || queue.some((id) => records[id]?.status === "pending");
}

/**
 * What keeps a ship with a course set docked: freight still moving through the open ramp
 * (Integration 2), a passenger ashore or walking off (passengers §3.3: the ship never leaves them
 * quietly, only through the overdue card or `endPassage`), or (D70) a card on its way to the
 * captain in person. Departure prep begins the first tick none of them applies.
 */
export function departureWaits(ctx: Pick<StepCtx, "state" | "content">): boolean {
  return (
    hasOpenCargoWork(ctx) ||
    waitingForPassenger(ctx.state) !== undefined ||
    ctx.state.decisions.held.length > 0
  );
}

/**
 * Passengers-and-galaxy §2.3: what holds the ship at an intermediate port of a voyage. Cargo
 * work, a purchasable part, a hold for repairs and a pending card each keep it docked; the
 * travel system plans the next hop the first tick none of them applies.
 */
function voyageHeldAtWaypoint(ctx: Pick<StepCtx, "state" | "content">): boolean {
  return (
    hasOpenCargoWork(ctx) ||
    hasRunnableBuyPartsWork(ctx) ||
    ctx.state.travel.holdForRepairs === true ||
    hasPendingDecision(ctx) ||
    waitingForPassenger(ctx.state) !== undefined
  );
}

/**
 * The fields a fresh stage object inherits from the previous one: the voyage, and the gate's
 * "leave anyway" answer with the impairment set it was answered for (asked once per voyage).
 */
export function carriedVoyageFields(
  travel: Readonly<DepartureGateFlags & VoyageFields>,
): DepartureGateFlags & VoyageFields {
  return {
    ...(travel.voyageDestinationId === undefined
      ? {}
      : { voyageDestinationId: travel.voyageDestinationId }),
    ...(travel.departureRiskAccepted === true ? { departureRiskAccepted: true } : {}),
    ...(travel.acceptedImpairmentKey === undefined
      ? {}
      : { acceptedImpairmentKey: travel.acceptedImpairmentKey }),
  };
}

/** Enter `preparingDeparture` from `docked` towards `toPortId` (shared with `setCourse`). */
export function beginDeparture(
  ctx: Pick<StepCtx, "state" | "content" | "emit" | "tick">,
  toPortId: PortDefId,
  cause: Pick<EventDraft, "causeIds" | "source"> = { causeIds: [], source: "sim" },
): void {
  const travel = ctx.state.travel;
  if (travel.stage !== "docked") return;
  const fromPort = ctx.content.ports[travel.portId];
  const distance = fromPort === undefined ? undefined : findRoute(fromPort, toPortId);
  ctx.state.travel = {
    stage: "preparingDeparture",
    fromPortId: travel.portId,
    toPortId,
    stageProgress: 0,
    routeProgress: 0,
    routeDistance: distance ?? 0,
    drifting: false,
    stageStartedTick: ctx.tick,
    // D36: "leave anyway" answered while docked still covers the departure it was asked for,
    // and (§2.3) the rest of the voyage.
    ...carriedVoyageFields(travel),
  };
  ctx.emit({
    ...cause,
    type: "travelStageChanged",
    subjectIds: [],
    payload: { from: "docked", to: "preparingDeparture" },
  });
}

/**
 * Docked at an intermediate port of a voyage with no course planned: plan the next hop on the
 * shortest path from *here* (a detour re-routes from wherever it ended up) once nothing holds
 * the ship. A voyage whose destination is no longer reachable is dropped rather than stranding
 * the ship with a course it can never plan.
 */
function continueVoyageIfFree(ctx: StepCtx): void {
  const travel = ctx.state.travel;
  if (travel.stage !== "docked" || travel.plannedDestinationId !== undefined) return;
  const voyage = travel.voyageDestinationId;
  if (voyage === undefined || voyage === travel.portId) return;
  const hop = nextHop(ctx.content.ports, travel.portId, voyage);
  if (hop === undefined) {
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete travel.voyageDestinationId;
    return;
  }
  if (voyageHeldAtWaypoint(ctx)) return;
  travel.plannedDestinationId = hop;
}

function advanceTravel(ctx: StepCtx): void {
  const travel = ctx.state.travel;
  if (travel.stage === "docked") {
    continueVoyageIfFree(ctx);
    // Integration 2: a course set while freight was still moving waits here, docked with the
    // ramp open, until the last crate is aboard (or ashore), then departure prep begins.
    const planned = travel.plannedDestinationId;
    if (planned !== undefined) {
      // Owner feedback 2026-09-30: `stationToStaff` used to open only once `preparingDeparture`
      // began (below), so the pilot did not start walking to the console until every crate was
      // aboard — a `preparingDeparture` stage that then sat stalled on `!staffed` for as long as
      // the walk takes. Raising it as soon as a course is planned lets the pilot head there while
      // loading still runs; the `essentialOperation` urgency already outranks the haul's
      // `routineObligation`, so this does not starve the hauling crew.
      //
      // `resolved` is deliberately gated on cargo also being done, not just on `isStaffed(ctx)`:
      // resolving the instant the pilot arrives would complete their `staffStation` task and end
      // the `hold` (SD §14.4 completion is checked against truth), freeing them to wander back to
      // hauling — then the ship goes unstaffed again and someone has to walk back, repeatedly,
      // until the loading crew runs out of crates to distract them with. Keeping the problem open
      // (so the claim and the hold persist) until the ship is actually ready to leave means a
      // pilot who gets there early just stays there.
      //
      // Passengers §3.3: while the ship waits for a passenger ashore (or walking off) the station
      // is not wanted yet: an open problem here would have the pilot arrive, "resolve" it, wander
      // off and be sent back for the whole stay. It is treated as settled until they are aboard.
      const console_ = bridgeConsole(ctx);
      if (console_ !== undefined) {
        const waiting = waitingForPassenger(ctx.state) !== undefined;
        updateStaffingProblem(
          ctx,
          console_.id,
          waiting || (isStaffed(ctx, console_) && !hasOpenCargoWork(ctx)),
        );
      }
    }
    if (planned === undefined || departureWaits(ctx)) return;
    // D36: the departure gate asks (once) before prep begins when an engine/generator is impaired.
    if (departureCleared(ctx)) beginDeparture(ctx, planned);
    return;
  }

  if (travel.stage === "preparingDeparture") {
    // D63: loading includes accepted freight still lying on the dock (cargo work, so it blocks
    // as cargo work does), and the call aboard waits until it is done: the loading crew are out
    // on the dock fetching it and must not be called back from it.
    const openCargo = hasOpenLoading(ctx);
    // D61: the ramps stay down while anyone is on the dock (or walking onto it, or out through
    // the gate, D63), and while freight is still being loaded with a dock alongside; otherwise
    // they come up. Under the ramp rules (D59) nobody else ever lowers them, so raising one early
    // strands whoever is out.
    const ashore = peopleAshore(ctx);
    const holdRamps = ashore.length > 0 || (openCargo && ctx.state.deck.dock !== undefined);
    requestRamps(ctx, holdRamps ? "open" : "closed");
    const staffed = checkStaffing(ctx);
    // Loading crew may be out on the dock fetching freight; the call waits for the cargo.
    if (ashore.length === 0) endRecall(travel);
    else if (!openCargo) recallAshore(ctx, travel, ashore);
    // D36: a course set with no cargo work enters this stage straight from `setCourse`, so the
    // departure gate is also checked here; a hold stalls the stage like any other precondition.
    if (!departureCleared(ctx)) return;
    if (openCargo || !staffed) return; // stalled: preconditions unmet
    if (ashore.length > 0) return; // stalled: waiting for everyone to come aboard (D61)
    // Ramps retract during prep (Dockside §2.4), so their closing runs alongside the timer; the
    // stage only waits on them if it would otherwise end with a ramp still down.
    if (!rampsClosed(ctx)) {
      advanceStageTimer(ctx, travel, travel.stage);
      return;
    }
  }

  if (travel.stage === "docking" && !checkStaffing(ctx)) return; // stalled

  if (travel.stage === "transit") {
    const factor = propulsionFactor(ctx);
    const drifting = factor <= 0;
    if (drifting !== travel.drifting) {
      travel.drifting = drifting;
      ctx.emit({
        type: "driftingChanged",
        subjectIds: [],
        causeIds: [],
        source: "sim",
        payload: { drifting },
      });
    }
    const secondsElapsed = ctx.elapsedTicks / ctx.config.time.tickRate;
    travel.routeProgress = Math.min(
      travel.routeDistance,
      travel.routeProgress + secondsElapsed * ctx.config.travel.nominalSpeed * factor,
    );
    travel.stageProgress =
      travel.routeDistance === 0 ? 1 : travel.routeProgress / travel.routeDistance;
    // D66: the staging call is raised before the end-of-route check, so a leg that starts inside
    // the lead distance (or has none) raises it this tick rather than costing one.
    stageDockIfDue(ctx, travel);
    if (travel.routeProgress < travel.routeDistance) return;
    // D66: held at the end of the route until the staging call has been answered.
    if (!stagingAnswered(ctx.state, ctx.content, travel)) return;
    advanceStage(ctx);
    return;
  }

  // Timer-driven stages: preparingDeparture, undocking, departing, approaching, docking.
  if (advanceStageTimer(ctx, travel, travel.stage) >= 1) advanceStage(ctx);
}

/** Run the current timed stage's clock; returns the new progress (capped at 1). */
function advanceStageTimer(
  ctx: StepCtx,
  travel: InFlight,
  stage: Exclude<TravelStage, "docked" | "transit">,
): number {
  const durationTicks = stageDurationTicks(ctx, stage);
  const increment = durationTicks === 0 ? 1 : ctx.elapsedTicks / durationTicks;
  travel.stageProgress = Math.min(1, travel.stageProgress + increment);
  return travel.stageProgress;
}

/**
 * D61: the port's dock comes alongside at the start of `docking` (a port without one keeps the
 * transfer tiles), grafted onto the ship's deck. Its ramps are still up, so nobody can walk onto
 * it until `docked` lowers them.
 */
function bringDockAlongside(
  ctx: StepCtx,
  portId: PortDefId,
  staging: DockStaging | undefined,
): void {
  const dock = dockForPort(ctx.content, portId);
  if (dock === undefined) return;
  attachDock(ctx, { dockId: dock.id, deckId: theDeckId(ctx) });
  // D66: the dock slides in with its people already at their posts: the floor set, and the
  // staging call's plan if it gave one.
  dressDockAlongside(ctx, staging?.status === "raised" ? staging.plan : undefined);
}

/**
 * D61: the dock leaves at the end of `undocking`. Prep has brought everyone aboard and raised
 * the ramps; `clearDock` leaves anything still lying there at the port, then the graft goes.
 * D66: the locals go first, with the dock, never aboard: they are not in `actors`, so neither the
 * call aboard nor `clearDock` ever sees them; a dock hand's open errand is finished on the spot.
 */
function castOffDock(ctx: StepCtx, portId: PortDefId): void {
  if (ctx.state.deck.dock === undefined) return;
  dismissLocals(ctx, portId);
  clearDock(ctx, portId, portStoreLocation(ctx.defs.port(portId)));
  detachDock(ctx);
}

function advanceStage(ctx: StepCtx): void {
  const travel = ctx.state.travel as InFlight;
  const from = travel.stage;
  const to = nextStage(from);
  if (from === "undocking") castOffDock(ctx, travel.fromPortId);

  if (to === "docked") {
    const portId = travel.toPortId;
    // §2.3: the voyage (and the gate's answer for it) survives an intermediate docking and ends
    // at its destination; with no voyage, "leave anyway" is forgotten here as before (D36).
    const voyageContinues =
      travel.voyageDestinationId !== undefined && travel.voyageDestinationId !== portId;
    ctx.state.travel = {
      stage: "docked",
      portId,
      ...(voyageContinues ? carriedVoyageFields(travel) : {}),
    };
    requestRamps(ctx, "open");
    // W6 decision: the fee is a flat config value, not per-`PortDef`, to keep V1 thin; a
    // per-port fee would read `ctx.defs.port(portId)` here instead.
    const fee = ctx.config.commerce.dockingFee;
    if (fee > 0) {
      const txId = allocateId(ctx.state, "transaction");
      ctx.state.money.balance -= fee;
      ctx.state.money.transactions[txId] = {
        id: txId,
        tick: ctx.tick,
        amount: -fee,
        reason: "fee",
      };
    }
    emitStageChanged(ctx, from, "docked");
    ctx.emit({
      type: "arrived",
      subjectIds: [],
      causeIds: [],
      source: "sim",
      payload: { portId },
    });
    return;
  }

  const routeDistance =
    to === "transit"
      ? (findRoute(ctx.defs.port(travel.fromPortId), travel.toPortId) ?? travel.routeDistance)
      : travel.routeDistance;
  ctx.state.travel = {
    stage: to,
    fromPortId: travel.fromPortId,
    toPortId: travel.toPortId,
    stageProgress: 0,
    routeProgress: to === "transit" ? 0 : travel.routeProgress,
    routeDistance,
    drifting: travel.drifting,
    stageStartedTick: ctx.tick,
    ...carriedVoyageFields(travel),
    // D66: the staging record rides from transit into the approach and is spent at docking.
    ...(to === "approaching" && travel.staging !== undefined ? { staging: travel.staging } : {}),
  };
  if (to === "docking") bringDockAlongside(ctx, travel.toPortId, travel.staging);
  emitStageChanged(ctx, from, to);
  if (from === "undocking" && to === "departing") {
    ctx.emit({
      type: "departed",
      subjectIds: [],
      causeIds: [],
      source: "sim",
      payload: { fromPortId: travel.fromPortId, toPortId: travel.toPortId },
    });
  }
}

/**
 * Raise `notableEvent` for a hookable narrative event committed in an earlier tick. Core's phase
 * 8 records it as `narrator.pendingNotable` (see `core/pipeline.ts`); it waits there while
 * another hook is pending, so a staging call raised the tick after the event (D69) delays the
 * notable hook rather than swallowing it. A story hook raised after the event clears it
 * (`core/hooks.ts`).
 */
function checkNotableEventHook(ctx: StepCtx): void {
  const owed = ctx.state.narrator.pendingNotable;
  if (owed === undefined || owed.tick >= ctx.tick) return;
  if (!ctx.config.narrator.hookOnEvents.includes(owed.type)) {
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete ctx.state.narrator.pendingNotable;
    return;
  }
  if (
    raiseHookIfIdle(ctx, "notableEvent", {
      eventIds: owed.eventId === undefined ? [] : [owed.eventId],
    })
  ) {
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete ctx.state.narrator.pendingNotable;
  }
}

export const travelSystem: System = {
  name: "travel.stateMachine",
  phase: "equipment",
  run(ctx) {
    advanceTravel(ctx);
    checkNotableEventHook(ctx);
  },
};
