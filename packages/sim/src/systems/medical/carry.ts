/**
 * §extraction: a crew member down aboard with wounds to treat is carried to the medbay bed.
 * §the-body-aboard: a dead crewmate's body is carried to its resting place the same way.
 *
 * - `carrySpecs` (derivation, from `tasks.ts`): while the patient is incapacitated, off the bed,
 *   on the ship's floor (or in a carrier's arms) and nobody else lies at the bed, one
 *   `carryCasualty`: no skill, one worker, standing on the open floor beside the patient (their
 *   own tile is theirs: nobody walks onto it). Its key names how many
 *   carries this problem has had and the tile the patient lies on, so a carry stopped part way
 *   (the patient set down elsewhere) is derived afresh from there; while they are carried the
 *   carry in progress keeps its key. `bodyCarrySpecs` derives a body's `carryBody` alike while it
 *   lies away from its resting place and nobody else lies there.
 * - `carryPlan`: to the tile beside the patient nearest the carrier and `lift`
 *   (`medical.liftSeconds`), then to the floor beside the bed (or the resting place) nearest them
 *   and `lay` (`medical.laySeconds`); already carrying them, only the second half.
 * - `runLift` takes them up (`carriedBy`, the fight's rescue primitive, `expedition/actions.ts`
 *   `pickUp`), so the body goes where the carrier goes. `runLay` lays a patient on the bed's `use`
 *   tile and emits `casualtyCarried`, or a body on its resting place and emits `bodyLaidOut`; a bed
 *   or place someone has taken meanwhile fails `occupiedPosition`.
 * - `setDownCasualty`: a carrier who stops for any reason (`abortActivity`: interrupted, failed,
 *   down) sets the one in their arms down where they stand. `releaseStrayCasualties` (the medical
 *   system, every tick) does the same for anyone carried aboard outside a carry of them: the
 *   patient who died or came round in someone's arms, or whose carrier is no longer carrying them.
 */
import { configTicks } from "../../core/clock";
import { isOnDock } from "../../core/docks";
import type { Actor, Availability } from "../../core/types/actor";
import type { DeepReadonly, TileCoord } from "../../core/types/common";
import type { ContentBundle } from "../../core/types/content";
import type { ActorId, ProblemId } from "../../core/types/ids";
import type { ReadonlyWorldState, StepCtx } from "../../core/types/pipeline";
import type {
  ActivityStep,
  DerivationCtx,
  ProblemOfKind,
  Task,
  TaskSpec,
  TaskType,
} from "../../core/types/work";
import { shipDeckId } from "../../core/world";
import { besideTiles, chebyshev } from "../damage/deck";
import { nearestReachable } from "../damage/plans";
import { carriedBy, pickUp, setDown } from "../expedition/actions";
import { emitSim } from "../work/events";
import { type PlanResult, blocked, planOf, tileOf } from "../work/plans";
import type { StepResult } from "../work/steps";
import { type MedBed, bedTakenFrom, medBedOf, onTheBed } from "./bed";
import { restingPlaceTaken } from "./rest";

type WorkStep = Extract<ActivityStep, { kind: "work" }>;

type CarryType = Extract<TaskType, "carryCasualty" | "carryBody">;

export const isCarry = (type: TaskType): type is CarryType =>
  type === "carryCasualty" || type === "carryBody";

/** What a carry wants of the one it carries: a casualty down, a body dead. */
const carriedState: Readonly<Record<CarryType, Availability>> = {
  carryCasualty: "incapacitated",
  carryBody: "dead",
};

/** Carried aboard (not a fight's rescue: neither side is a combatant). */
const carriedAboard = (patient: DeepReadonly<Actor>, carrier: DeepReadonly<Actor>): boolean =>
  patient.combatant === undefined && carrier.combatant === undefined;

/** The carry `carrier` is on of `patientId`, if they are on one. */
function carrying(
  state: DerivationCtx["state"] | StepCtx["state"],
  carrier: DeepReadonly<Actor>,
  patientId: ActorId,
): CarryType | undefined {
  const activity = carrier.activity;
  if (activity.kind !== "task" || carrier.availability !== "available") return undefined;
  const task = state.work.tasks[activity.taskId];
  if (task === undefined || !isCarry(task.type)) return undefined;
  return task.target.kind === "actor" && task.target.actorId === patientId ? task.type : undefined;
}

/** The tile the patient lies on aboard (on the ship's floor, off the dock), if they do. */
function lyingAt(ctx: DerivationCtx, patient: DeepReadonly<Actor>): TileCoord | undefined {
  const location = patient.location;
  if (location.kind !== "onDeck" || location.deckId !== shipDeckId(ctx.state)) return undefined;
  if (isOnDock(ctx.content, ctx.state, location)) return undefined;
  return tileOf(location);
}

/**
 * The open floor beside `tile` (never the tile itself, which the patient lies on and nobody may
 * walk onto), nearest first.
 */
function besidePatient(
  content: Pick<ContentBundle, "decks" | "machines">,
  state: Pick<ReadonlyWorldState, "deck">,
  tile: TileCoord,
): TileCoord[] {
  const deck = content.decks[shipDeckId(state)];
  if (deck === undefined) return [];
  return besideTiles(content, deck, tile).filter((t) => t.x !== tile.x || t.y !== tile.y);
}

/** The derivation key and the tiles to go to for the carry the patient wants now, if any. */
function carryKey(
  ctx: DerivationCtx,
  problemId: ProblemId,
  type: CarryType,
  patient: DeepReadonly<Actor>,
): { key: string; tiles: TileCoord[] } | undefined {
  const carries = Object.values(ctx.state.work.tasks).filter(
    (t) => t.problemId === problemId && t.type === type,
  );
  const location = patient.location;
  if (location.kind === "carriedBy") {
    const carrier = ctx.state.actors[location.actorId];
    const live = carries.find((t) => t.claimState.kind === "claimed");
    if (
      carrier === undefined ||
      live === undefined ||
      carrying(ctx.state, carrier, patient.id) !== type
    ) {
      return undefined;
    }
    const at = carrier.location;
    return at.kind === "onDeck" ? { key: live.derivationKey, tiles: [tileOf(at)] } : undefined;
  }
  const tile = lyingAt(ctx, patient);
  if (tile === undefined) return undefined;
  const done = carries.filter((t) => t.status === "completed").length;
  return {
    key: `carry:${done}:${tile.x},${tile.y}`,
    tiles: besidePatient(ctx.content, ctx.state, tile),
  };
}

/** One carry of `patient`, at the problem's urgency. */
function carrySpec(
  ctx: DerivationCtx,
  problem: ProblemOfKind<"crewWounded" | "bodyAboard">,
  type: CarryType,
  patient: DeepReadonly<Actor>,
): TaskSpec[] {
  const carry = carryKey(ctx, problem.id, type, patient);
  if (carry === undefined) return [];
  const { liftSeconds, laySeconds } = ctx.config.medical;
  return [
    {
      derivationKey: carry.key,
      type,
      target: { kind: "actor", actorId: patient.id },
      baseUrgency: problem.baseUrgency,
      requiredSkills: [],
      requiredTools: [],
      consumables: [],
      workerSlots: 1,
      interactionTiles: carry.tiles,
      dependencyIds: [],
      progressRef: { kind: "casualty", actorId: patient.id },
      completion: { kind: "stepsDone" },
      estimatedWorkSeconds: liftSeconds + laySeconds,
    },
  ];
}

/** §extraction: the carry for a downed patient off the bed (none while the bed is taken). */
export function carrySpecs(
  ctx: DerivationCtx,
  problem: ProblemOfKind<"crewWounded">,
  patient: DeepReadonly<Actor>,
  bed: MedBed,
): TaskSpec[] {
  if (patient.combatant !== undefined || bedTakenFrom(ctx.state, bed, patient.id)) return [];
  return carrySpec(ctx, problem, "carryCasualty", patient);
}

/**
 * §the-body-aboard: the carry of a body away from its resting place (none while it lies there, or
 * while someone else does).
 */
export function bodyCarrySpecs(
  ctx: DerivationCtx,
  problem: ProblemOfKind<"bodyAboard">,
  body: DeepReadonly<Actor>,
): TaskSpec[] {
  if (body.availability !== "dead" || body.combatant !== undefined) return [];
  const place = problem.payload.tile;
  const at = body.location.kind === "onDeck" ? tileOf(body.location) : undefined;
  if (at !== undefined && at.x === place.x && at.y === place.y) return [];
  if (restingPlaceTaken(ctx.state, place, body.id)) return [];
  return carrySpec(ctx, problem, "carryBody", body);
}

const work = (stage: "lift" | "lay", ticks: number): ActivityStep => ({
  kind: "work",
  stage,
  ticksDone: 0,
  ticksNeeded: Math.max(1, ticks),
});

/** Where a carry ends: the tile they are laid on, and the floor to stand on beside it. */
interface CarryEnd {
  readonly lay: TileCoord;
  readonly stand: readonly TileCoord[];
}

/**
 * Where this carry of `patient` ends: the medbay bed, or the body's resting place; the blockage
 * when it cannot (no bed or place, or someone else lies there).
 */
function carryEnd(
  ctx: StepCtx,
  task: Task,
  type: CarryType,
  patient: DeepReadonly<Actor>,
): CarryEnd | "unreachableTarget" | "occupiedPosition" {
  if (type === "carryCasualty") {
    const bed = medBedOf(ctx.state, ctx.content);
    if (bed === undefined) return "unreachableTarget";
    if (bedTakenFrom(ctx.state, bed, patient.id)) return "occupiedPosition";
    return { lay: bed.useTile, stand: bed.medicTiles };
  }
  const problem = ctx.state.work.problems[task.problemId];
  if (problem?.kind !== "bodyAboard") return "unreachableTarget";
  const place = problem.payload.tile;
  if (restingPlaceTaken(ctx.state, place, patient.id)) return "occupiedPosition";
  return { lay: place, stand: besidePatient(ctx.content, ctx.state, place) };
}

export function carryPlan(ctx: StepCtx, actor: Actor, task: Task): PlanResult {
  if (task.target.kind !== "actor" || !isCarry(task.type)) return blocked("unreachableTarget");
  const type = task.type;
  const patient = ctx.state.actors[task.target.actorId];
  if (patient === undefined || patient.availability !== carriedState[type]) {
    return blocked("unreachableTarget");
  }
  const end = carryEnd(ctx, task, type, patient);
  if (typeof end === "string") return blocked(end);
  const { liftSeconds, laySeconds } = ctx.config.medical;
  const steps: ActivityStep[] = [];
  if (carriedBy(ctx, actor.id)?.id !== patient.id) {
    const location = patient.location;
    if (location.kind !== "onDeck") return blocked("unreachableTarget");
    const beside = nearestReachable(
      ctx,
      actor,
      besidePatient(ctx.content, ctx.state, tileOf(location)),
    );
    if (beside === undefined) return blocked("unreachableTarget");
    steps.push(
      { kind: "moveTo", target: { x: beside.x, y: beside.y }, requested: false },
      work("lift", configTicks(ctx.config, liftSeconds)),
    );
  }
  const stand = nearestReachable(ctx, actor, end.stand);
  if (stand === undefined) return blocked("unreachableTarget");
  steps.push(
    { kind: "moveTo", target: { x: stand.x, y: stand.y }, requested: false },
    work("lay", configTicks(ctx.config, laySeconds)),
  );
  return planOf(steps);
}

/** The carry the actor is on, its type and the one carried. */
function carryOf(
  ctx: StepCtx,
  actor: Actor,
): { task: Task; type: CarryType; patient: Actor } | undefined {
  const activity = actor.activity;
  if (activity.kind !== "task") return undefined;
  const task = ctx.state.work.tasks[activity.taskId];
  if (task === undefined || !isCarry(task.type) || task.target.kind !== "actor") return undefined;
  const patient = ctx.state.actors[task.target.actorId];
  return patient === undefined ? undefined : { task, type: task.type, patient };
}

/** Count one tick of a handling step; true once it is through. */
function handled(step: WorkStep): boolean {
  step.ticksDone += 1;
  return step.ticksDone >= step.ticksNeeded;
}

export function runLift(ctx: StepCtx, actor: Actor, step: WorkStep): StepResult {
  const carry = carryOf(ctx, actor);
  if (carry === undefined) return { fail: "dependencyPending" };
  const { task, type, patient } = carry;
  if (carriedBy(ctx, actor.id)?.id === patient.id) return "done";
  if (patient.availability !== carriedState[type]) return { fail: "unreachableTarget" };
  const here = actor.location;
  const there = patient.location;
  if (here.kind !== "onDeck" || there.kind !== "onDeck") return { fail: "unreachableTarget" };
  if (chebyshev(tileOf(here), tileOf(there)) > 1) return { fail: "unreachableTarget" };
  if (task.status === "claimed") task.status = "active";
  if (!handled(step)) return "wait";
  pickUp(ctx, actor, patient);
  return "done";
}

export function runLay(ctx: StepCtx, actor: Actor, step: WorkStep): StepResult {
  const carry = carryOf(ctx, actor);
  if (carry === undefined) return { fail: "dependencyPending" };
  const { task, type, patient } = carry;
  if (carriedBy(ctx, actor.id)?.id !== patient.id) return { fail: "unreachableTarget" };
  const end = carryEnd(ctx, task, type, patient);
  const here = actor.location;
  if (end === "unreachableTarget" || here.kind !== "onDeck") return { fail: "unreachableTarget" };
  if (end === "occupiedPosition") return { fail: "occupiedPosition" };
  if (chebyshev(tileOf(here), end.lay) > 1) return { fail: "unreachableTarget" };
  if (!handled(step)) return "wait";
  patient.location = {
    kind: "onDeck",
    deckId: here.deckId,
    x: end.lay.x + 0.5,
    y: end.lay.y + 0.5,
  };
  if (type === "carryBody") {
    laidOut(ctx, task, patient, actor);
    return "done";
  }
  const bed = medBedOf(ctx.state, ctx.content);
  if (bed === undefined || !onTheBed(ctx.state, bed, patient)) {
    throw new Error(`medical: ${patient.id} laid off the medbay bed`);
  }
  emitSim(ctx, "casualtyCarried", [patient.id, actor.id], {
    actorId: patient.id,
    byActorId: actor.id,
  });
  return "done";
}

/** §the-body-aboard: `bodyLaidOut`, in the resting place's compartment. */
function laidOut(ctx: StepCtx, task: Task, body: Actor, carrier: Actor): void {
  const location = ctx.state.work.problems[task.problemId]?.location;
  if (location?.kind !== "compartment") {
    throw new Error(`medical: the body problem ${task.problemId} names no compartment`);
  }
  emitSim(ctx, "bodyLaidOut", [body.id, carrier.id], {
    actorId: body.id,
    byActorId: carrier.id,
    compartmentId: location.compartmentId,
  });
}

/** A carrier stopping sets the one in their arms down where they stand. */
export function setDownCasualty(ctx: StepCtx, carrier: Actor): void {
  const patient = carriedBy(ctx, carrier.id);
  if (patient !== undefined && carriedAboard(patient, carrier)) setDown(carrier, patient);
}

/**
 * Anyone carried aboard outside a carry of them is set down where the carrier stands: they died
 * or came round in someone's arms, or the carrier stopped carrying them.
 */
export function releaseStrayCasualties(ctx: StepCtx): void {
  for (const patient of Object.values(ctx.state.actors)) {
    const location = patient.location;
    if (location.kind !== "carriedBy") continue;
    const carrier = ctx.state.actors[location.actorId];
    if (carrier === undefined || !carriedAboard(patient, carrier)) continue;
    const carry = carrying(ctx.state, carrier, patient.id);
    const kept = carry !== undefined && patient.availability === carriedState[carry];
    if (!kept) setDown(carrier, patient);
  }
}
