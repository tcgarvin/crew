/**
 * §extraction: a crew member down aboard with wounds to treat is carried to the medbay bed.
 *
 * - `carrySpecs` (derivation, from `tasks.ts`): while the patient is incapacitated, off the bed,
 *   on the ship's floor (or in a carrier's arms) and nobody else lies at the bed, one
 *   `carryCasualty`: no skill, one worker, standing on the open floor beside the patient (their
 *   own tile is theirs: nobody walks onto it). Its key names how many
 *   carries this problem has had and the tile the patient lies on, so a carry stopped part way
 *   (the patient set down elsewhere) is derived afresh from there; while they are carried the
 *   carry in progress keeps its key.
 * - `carryPlan`: to the tile beside the patient nearest the carrier and `lift` (`medical.liftSeconds`), then to the floor
 *   beside the bed nearest them and `lay` (`medical.laySeconds`); already carrying them, only the
 *   second half.
 * - `runLift` takes them up (`carriedBy`, the fight's rescue primitive, `expedition/actions.ts`
 *   `pickUp`), so the body goes where the carrier goes. `runLay` lays them on the bed's `use` tile
 *   and emits `casualtyCarried`; a bed someone has taken meanwhile fails `occupiedPosition`.
 * - `setDownCasualty`: a carrier who stops for any reason (`abortActivity`: interrupted, failed,
 *   down) sets the patient down where they stand. `releaseStrayCasualties` (the medical system,
 *   every tick) does the same for anyone carried aboard outside a carry: the patient who died or
 *   came round in someone's arms, or whose carrier is no longer carrying them.
 */
import { configTicks } from "../../core/clock";
import { isOnDock } from "../../core/docks";
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly, TileCoord } from "../../core/types/common";
import type { ContentBundle } from "../../core/types/content";
import type { ActorId } from "../../core/types/ids";
import type { ReadonlyWorldState, StepCtx } from "../../core/types/pipeline";
import type {
  ActivityStep,
  DerivationCtx,
  ProblemOfKind,
  Task,
  TaskSpec,
} from "../../core/types/work";
import { shipDeckId } from "../../core/world";
import { besideTiles, chebyshev } from "../damage/deck";
import { nearestReachable } from "../damage/plans";
import { carriedBy, pickUp, setDown } from "../expedition/actions";
import { emitSim } from "../work/events";
import { type PlanResult, blocked, planOf, tileOf } from "../work/plans";
import type { StepResult } from "../work/steps";
import { type MedBed, bedTakenFrom, medBedOf, onTheBed } from "./bed";

type WorkStep = Extract<ActivityStep, { kind: "work" }>;

/** A patient carried aboard (not a fight's rescue: neither side is a combatant). */
const carriedAboard = (patient: DeepReadonly<Actor>, carrier: DeepReadonly<Actor>): boolean =>
  patient.combatant === undefined && carrier.combatant === undefined;

/** Is `carrier` on a carry of `patientId`? */
function carrying(
  state: DerivationCtx["state"] | StepCtx["state"],
  carrier: DeepReadonly<Actor>,
  patientId: ActorId,
): boolean {
  const activity = carrier.activity;
  if (activity.kind !== "task" || carrier.availability !== "available") return false;
  const task = state.work.tasks[activity.taskId];
  return (
    task?.type === "carryCasualty" &&
    task.target.kind === "actor" &&
    task.target.actorId === patientId
  );
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
  problem: ProblemOfKind<"crewWounded">,
  patient: DeepReadonly<Actor>,
): { key: string; tiles: TileCoord[] } | undefined {
  const carries = Object.values(ctx.state.work.tasks).filter(
    (t) => t.problemId === problem.id && t.type === "carryCasualty",
  );
  const location = patient.location;
  if (location.kind === "carriedBy") {
    const carrier = ctx.state.actors[location.actorId];
    const live = carries.find((t) => t.claimState.kind === "claimed");
    if (carrier === undefined || live === undefined || !carrying(ctx.state, carrier, patient.id)) {
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

/** §extraction: the carry for a downed patient off the bed (none while the bed is taken). */
export function carrySpecs(
  ctx: DerivationCtx,
  problem: ProblemOfKind<"crewWounded">,
  patient: DeepReadonly<Actor>,
  bed: MedBed,
): TaskSpec[] {
  if (patient.combatant !== undefined || bedTakenFrom(ctx.state, bed, patient.id)) return [];
  const carry = carryKey(ctx, problem, patient);
  if (carry === undefined) return [];
  const { liftSeconds, laySeconds } = ctx.config.medical;
  return [
    {
      derivationKey: carry.key,
      type: "carryCasualty",
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

const work = (stage: "lift" | "lay", ticks: number): ActivityStep => ({
  kind: "work",
  stage,
  ticksDone: 0,
  ticksNeeded: Math.max(1, ticks),
});

export function carryPlan(ctx: StepCtx, actor: Actor, task: Task): PlanResult {
  if (task.target.kind !== "actor") return blocked("unreachableTarget");
  const patient = ctx.state.actors[task.target.actorId];
  const bed = medBedOf(ctx.state, ctx.content);
  if (patient === undefined || bed === undefined || patient.availability !== "incapacitated") {
    return blocked("unreachableTarget");
  }
  if (bedTakenFrom(ctx.state, bed, patient.id)) return blocked("occupiedPosition");
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
  const stand = nearestReachable(ctx, actor, bed.medicTiles);
  if (stand === undefined) return blocked("unreachableTarget");
  steps.push(
    { kind: "moveTo", target: { x: stand.x, y: stand.y }, requested: false },
    work("lay", configTicks(ctx.config, laySeconds)),
  );
  return planOf(steps);
}

/** The carry the actor is on, and its patient. */
function carryOf(ctx: StepCtx, actor: Actor): { task: Task; patient: Actor } | undefined {
  const activity = actor.activity;
  if (activity.kind !== "task") return undefined;
  const task = ctx.state.work.tasks[activity.taskId];
  if (task?.type !== "carryCasualty" || task.target.kind !== "actor") return undefined;
  const patient = ctx.state.actors[task.target.actorId];
  return patient === undefined ? undefined : { task, patient };
}

/** Count one tick of a handling step; true once it is through. */
function handled(step: WorkStep): boolean {
  step.ticksDone += 1;
  return step.ticksDone >= step.ticksNeeded;
}

export function runLift(ctx: StepCtx, actor: Actor, step: WorkStep): StepResult {
  const carry = carryOf(ctx, actor);
  if (carry === undefined) return { fail: "dependencyPending" };
  const { task, patient } = carry;
  if (carriedBy(ctx, actor.id)?.id === patient.id) return "done";
  if (patient.availability !== "incapacitated") return { fail: "unreachableTarget" };
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
  const { patient } = carry;
  if (carriedBy(ctx, actor.id)?.id !== patient.id) return { fail: "unreachableTarget" };
  const bed = medBedOf(ctx.state, ctx.content);
  const here = actor.location;
  if (bed === undefined || here.kind !== "onDeck") return { fail: "unreachableTarget" };
  if (chebyshev(tileOf(here), bed.useTile) > 1) return { fail: "unreachableTarget" };
  if (bedTakenFrom(ctx.state, bed, patient.id)) return { fail: "occupiedPosition" };
  if (!handled(step)) return "wait";
  patient.location = {
    kind: "onDeck",
    deckId: here.deckId,
    x: bed.useTile.x + 0.5,
    y: bed.useTile.y + 0.5,
  };
  if (!onTheBed(ctx.state, bed, patient)) {
    throw new Error(`medical: ${patient.id} laid off the medbay bed`);
  }
  emitSim(ctx, "casualtyCarried", [patient.id, actor.id], {
    actorId: patient.id,
    byActorId: actor.id,
  });
  return "done";
}

/** A carrier stopping sets the patient in their arms down where they stand. */
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
    const kept =
      patient.availability === "incapacitated" && carrying(ctx.state, carrier, patient.id);
    if (!kept) setDown(carrier, patient);
  }
}
