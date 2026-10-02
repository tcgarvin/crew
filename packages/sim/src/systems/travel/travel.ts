/**
 * Travel state machine (SD §17.1, PLAN §6 W6 item 1).
 *
 * `docked -> preparingDeparture -> undocking -> departing -> transit -> approaching -> docking ->
 * docked`. Runs every tick in the "equipment" phase (PHASES[3]) alongside power/equipment, since
 * travel progress depends on the engine's output the same way a machine's does.
 */
import { configTicks } from "../../core/clock";
import { allocateId } from "../../core/ids";
import type { PhysicalLocation, TileCoord } from "../../core/types/common";
import type { ExternalStoreDef, MachineTag, PortDef } from "../../core/types/content";
import type { EventDraft } from "../../core/types/events";
import type {
  ActorId,
  DeckDefId,
  DoorId,
  MachineId,
  PortDefId,
  ProblemId,
} from "../../core/types/ids";
import type { StepCtx, System } from "../../core/types/pipeline";
import type { Machine } from "../../core/types/ship";
import type { TravelStage, TravelState } from "../../core/types/travel";
import type { ProblemOfKind } from "../../core/types/work";
import { departureCleared } from "./departure-gate";
import { raiseHookIfIdle } from "./hooks";

// ---------------------------------------------------------------------------------------------
// Propulsion
// ---------------------------------------------------------------------------------------------

/**
 * `W6 decision`: propulsion factor is the mean `output` of every `on` machine tagged `engine`
 * (0 for `standby`/`off`); `output` already folds in power/heat/fault derating (SD §9), so travel
 * does not re-derive it. A ship with no engine machine (test fixtures) is treated as unconstrained
 * (factor 1) rather than permanently drifting.
 */
export function propulsionFactor(
  machines: Readonly<Record<string, Machine>>,
  machineDefs: ReadonlyMap<string, readonly MachineTag[]>,
): number {
  const engines = Object.values(machines).filter((m) =>
    (machineDefs.get(m.defId) ?? []).includes("engine"),
  );
  if (engines.length === 0) return 1;
  const sum = engines.reduce((acc, m) => acc + (m.actualMode === "on" ? m.output : 0), 0);
  return sum / engines.length;
}

function machineTagsByDefId(
  ctx: Pick<StepCtx, "content">,
): ReadonlyMap<string, readonly MachineTag[]> {
  return new Map(Object.values(ctx.content.machines).map((def) => [def.id, def.tags]));
}

// ---------------------------------------------------------------------------------------------
// Ramps and staffing (departure/docking preconditions)
// ---------------------------------------------------------------------------------------------

/** V1 is single-ship/single-deck (common.ts W0 decision); the one deck the ship uses. */
export function theDeckId(ctx: Pick<StepCtx, "content">): DeckDefId {
  const [deck] = Object.values(ctx.content.decks);
  if (deck === undefined) throw new Error("travel: content bundle has no deck");
  return deck.id;
}

function rampDoorIds(ctx: Pick<StepCtx, "state" | "content">): DoorId[] {
  const deckId = theDeckId(ctx);
  return Object.values(ctx.state.doors)
    .filter((d) => d.deckId === deckId && d.kind === "ramp")
    .map((d) => d.id);
}

/** Request every ramp door to `state`; the door system (W3) drives the physical transition. */
export function requestRamps(
  ctx: Pick<StepCtx, "state" | "content">,
  state: "open" | "closed",
): void {
  for (const doorId of rampDoorIds(ctx)) {
    const door = ctx.state.doors[doorId];
    if (door !== undefined) door.requestedState = state;
  }
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
 * console's `operate` interaction positions (rotation-adjusted, footprint origin from the
 * placement). W4 will replace this with a real claimed `stationToStaff` task.
 */
function rotate(offset: TileCoord, rotation: 0 | 90 | 180 | 270): TileCoord {
  switch (rotation) {
    case 0:
      return offset;
    case 90:
      return { x: -offset.y, y: offset.x };
    case 180:
      return { x: -offset.x, y: -offset.y };
    case 270:
      return { x: offset.y, y: -offset.x };
  }
}

function consoleOperatePositions(ctx: Pick<StepCtx, "content">, console_: Machine): TileCoord[] {
  const deck = ctx.content.decks[theDeckId(ctx)];
  const def = ctx.content.machines[console_.defId];
  const placement = deck?.machines.find((p) => p.key === console_.placementKey);
  if (deck === undefined || def === undefined || placement === undefined) return [];
  return def.interactionPositions
    .filter((p) => p.purposes.includes("operate"))
    .map((p) => {
      const rotated = rotate(p.offset, placement.rotation);
      return { x: placement.origin.x + rotated.x, y: placement.origin.y + rotated.y };
    });
}

function isStaffed(ctx: Pick<StepCtx, "state" | "content">): boolean {
  const console_ = bridgeConsole(ctx);
  if (console_ === undefined) return true;
  const positions = consoleOperatePositions(ctx, console_);
  if (positions.length === 0) return true;
  const deckId = theDeckId(ctx);
  return Object.values(ctx.state.actors).some((actor) => {
    const location = actor.location;
    if (!actor.crew || location.kind !== "onDeck" || location.deckId !== deckId) return false;
    return positions.some(
      (p) => Math.abs(location.x - (p.x + 0.5)) <= 1 && Math.abs(location.y - (p.y + 0.5)) <= 1,
    );
  });
}

// ---------------------------------------------------------------------------------------------
// stationToStaff problem bookkeeping
// ---------------------------------------------------------------------------------------------

function findOpenProblem(ctx: Pick<StepCtx, "state">, dedupeKey: string) {
  return Object.values(ctx.state.work.problems).find(
    (p) => p.dedupeKey === dedupeKey && p.status === "open",
  );
}

/** Open (or revise) `stationToStaff` while unstaffed; resolve it once staffed. Owner: travel. */
function updateStaffingProblem(ctx: StepCtx, machineId: MachineId, staffed: boolean): void {
  const dedupeKey = `stationToStaff:${machineId}`;
  const existing = findOpenProblem(ctx, dedupeKey) as ProblemOfKind<"stationToStaff"> | undefined;
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

function nextStage(
  stage: Exclude<TravelStage, "docked">,
): Exclude<TravelStage, "docked"> | "docked" {
  const index = STAGE_ORDER.indexOf(stage);
  const next = STAGE_ORDER[index + 1];
  return next ?? "docked";
}

function emitStageChanged(
  ctx: StepCtx,
  from: TravelStage,
  to: TravelStage,
  subjectIds: readonly ActorId[] = [],
): void {
  ctx.emit({
    type: "travelStageChanged",
    subjectIds,
    causeIds: [],
    source: "sim",
    payload: { from, to },
  });
}

function findRoute(port: PortDef, toPortId: PortDefId): number | undefined {
  return port.routes.find((r) => r.toPortId === toPortId)?.distance;
}

function warehouseStore(port: PortDef): ExternalStoreDef | undefined {
  return port.externalStores.find((s) => s.kind === "warehouse") ?? port.externalStores[0];
}

/** Spawn location for freight at a port on arrival/accept: its warehouse (or first) store. */
export function portStoreLocation(port: PortDef): PhysicalLocation {
  const store = warehouseStore(port);
  if (store === undefined) throw new Error(`Port "${port.id}" has no external store`);
  return { kind: "inExternalStore", portId: port.id, storeKey: store.key };
}

// ---------------------------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------------------------

/** Open freight work (either direction) that must finish before the ship may leave. */
export function hasOpenCargoWork(ctx: Pick<StepCtx, "state">): boolean {
  return Object.values(ctx.state.work.problems).some(
    (p) => (p.kind === "cargoToLoad" || p.kind === "cargoToUnload") && p.status === "open",
  );
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
    // D36: "leave anyway" answered while docked still covers the departure it was asked for.
    ...(travel.departureRiskAccepted === true ? { departureRiskAccepted: true } : {}),
  };
  ctx.emit({
    ...cause,
    type: "travelStageChanged",
    subjectIds: [],
    payload: { from: "docked", to: "preparingDeparture" },
  });
}

function advanceTravel(ctx: StepCtx): void {
  const travel = ctx.state.travel;
  if (travel.stage === "docked") {
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
      const console_ = bridgeConsole(ctx);
      if (console_ !== undefined) {
        updateStaffingProblem(ctx, console_.id, isStaffed(ctx) && !hasOpenCargoWork(ctx));
      }
    }
    // D36: the departure gate asks (once) before prep begins when an engine/generator is impaired.
    if (planned !== undefined && !hasOpenCargoWork(ctx) && departureCleared(ctx)) {
      beginDeparture(ctx, planned);
    }
    return;
  }

  const machineDefs = machineTagsByDefId(ctx);

  if (travel.stage === "preparingDeparture") {
    requestRamps(ctx, "closed");
    const console_ = bridgeConsole(ctx);
    const staffed = isStaffed(ctx);
    if (console_ !== undefined) updateStaffingProblem(ctx, console_.id, staffed);
    // D36: a course set with no cargo work enters this stage straight from `setCourse`, so the
    // departure gate is also checked here; a hold stalls the stage like any other precondition.
    if (!departureCleared(ctx)) return;
    const openCargo = Object.values(ctx.state.work.problems).some(
      (p) => p.kind === "cargoToLoad" && p.status === "open",
    );
    if (openCargo || !rampsClosed(ctx) || !staffed) return; // stalled: preconditions unmet
  }

  if (travel.stage === "docking") {
    const console_ = bridgeConsole(ctx);
    const staffed = isStaffed(ctx);
    if (console_ !== undefined) updateStaffingProblem(ctx, console_.id, staffed);
    if (!staffed) return; // stalled
  }

  if (travel.stage === "transit") {
    const factor = propulsionFactor(ctx.state.machines, machineDefs);
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
    if (travel.routeProgress < travel.routeDistance) return;
    advanceStage(ctx);
    return;
  }

  // Timer-driven stages: preparingDeparture, undocking, departing, approaching, docking.
  const durationTicks = stageDurationTicks(ctx, travel.stage);
  const increment = durationTicks === 0 ? 1 : ctx.elapsedTicks / durationTicks;
  travel.stageProgress = Math.min(1, travel.stageProgress + increment);
  if (travel.stageProgress >= 1) advanceStage(ctx);
}

function advanceStage(ctx: StepCtx): void {
  const travel = ctx.state.travel as Extract<
    TravelState,
    { stage: Exclude<TravelStage, "docked"> }
  >;
  const from = travel.stage;
  const to = nextStage(from);

  if (to === "docked") {
    const portId = travel.toPortId;
    ctx.state.travel = { stage: "docked", portId };
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
  };
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
  if (to === "approaching") {
    raiseHookIfIdle(ctx, "approachingPort", {
      portId: travel.toPortId,
      etaTicks: stageDurationTicks(ctx, "approaching") + stageDurationTicks(ctx, "docking"),
    });
  }
}

/**
 * Raise `notableEvent` the tick after a hookable narrative event was committed. Core's phase 8
 * records `lastNarrativeEvent` for every `narrative`-significance event, preferring one whose type
 * is in `config.narrator.hookOnEvents` (see `core/pipeline.ts`).
 */
function checkNotableEventHook(ctx: StepCtx): void {
  const last = ctx.state.narrator.lastNarrativeEvent;
  if (last === undefined || last.tick !== ctx.tick - 1) return;
  const kinds = ctx.config.narrator.hookOnEvents;
  if (!kinds.includes(last.type)) return;
  raiseHookIfIdle(ctx, "notableEvent", {
    eventIds: last.eventId === undefined ? [] : [last.eventId],
  });
}

export const travelSystem: System = {
  name: "travel.stateMachine",
  phase: "equipment",
  run(ctx) {
    advanceTravel(ctx);
    checkNotableEventHook(ctx);
  },
};
