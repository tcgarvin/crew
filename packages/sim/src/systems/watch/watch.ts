/**
 * The watch system (D77), phase `needs`, every tick:
 *
 * - the bell when the watch changes, naming the section that has it;
 * - the helm's `watch` post: open while a course is planned (and no passenger keeps the ship in)
 *   or the ship is underway, resolved once it is docked with no course (moved from travel);
 * - the `relief` post: raised when whoever holds the watch post has hunger, fatigue, comfort or
 *   social past `urgency.needEssentialAbove`, resolved once a watch-post stander is back in the
 *   seat (by a handover since it was raised), after `watches.reliefMaxDays`, or when the helm
 *   watch ends;
 * - vacancy: `helm.unattendedSinceTick` while the helm watch is wanted and nobody has the helm,
 *   and `helmUnattended` once per vacancy after `watches.helmUnattendedSeconds` of it in transit;
 * - the long-watch thoughts: `stoodLongWatch` once a hold at the helm passes `longWatchFactor`
 *   watches, `doubleWatch` at two.
 *
 * Gangway watch needs no bookkeeping: it is a personal activity (`helm.ts`).
 *
 * Owner: W1 of ship life slice 2.
 */
import { configTicks, dayTicks, watchIndexAt, watchOfDay, watchTicks } from "../../core/clock";
import { allocateId } from "../../core/ids";
import { addThought } from "../../core/thoughts";
import type { ActorId, MachineId, ProblemId } from "../../core/types/ids";
import type { StepCtx, System } from "../../core/types/pipeline";
import type { ProblemOfKind } from "../../core/types/work";
import { coursePlotted } from "../travel/course";
import { waitingForPassenger } from "../travel/travel";
import { currentStep } from "../work/activity";
import { watchBillOf } from "./bill";
import {
  type HelmPost,
  helmCover,
  helmMachine,
  helmManned,
  helmPostOf,
  needsPastEssential,
  whoHasTheHelm,
} from "./helm";

function ringBell(ctx: StepCtx): void {
  const watchIndex = watchIndexAt(ctx.config, ctx.tick);
  if (watchIndex === ctx.state.watch.lastBellWatch) return;
  ctx.state.watch.lastBellWatch = watchIndex;
  const ofDay = watchOfDay(ctx.config, ctx.tick);
  const sectionKey = watchBillOf(ctx.state).sections.find((s) => s.index === ofDay)?.key;
  ctx.emit({
    type: "bell",
    subjectIds: [],
    causeIds: [],
    source: "sim",
    payload: { watchIndex, ...(sectionKey === undefined ? {} : { sectionKey }) },
  });
}

/**
 * Is the helm wanted: underway, or in port with a course planned and plotted (D78: prep cannot
 * begin before, and a pilot in the seat could not plot it) and nobody ashore to wait for?
 */
function helmWanted(ctx: StepCtx): boolean {
  const travel = ctx.state.travel;
  if (travel.stage !== "docked") return true;
  return (
    travel.plannedDestinationId !== undefined &&
    coursePlotted(ctx) &&
    waitingForPassenger(ctx.state) === undefined
  );
}

const dedupeKeyOf = (machineId: MachineId, post: HelmPost): string =>
  post === "watch" ? `stationToStaff:${machineId}` : `stationToStaff:${machineId}:relief`;

function openPost(
  ctx: StepCtx,
  machineId: MachineId,
  post: HelmPost,
): ProblemOfKind<"stationToStaff"> | undefined {
  const dedupeKey = dedupeKeyOf(machineId, post);
  return Object.values(ctx.state.work.problems).find(
    (p) => p.dedupeKey === dedupeKey && p.status === "open",
  ) as ProblemOfKind<"stationToStaff"> | undefined;
}

function raisePost(ctx: StepCtx, machineId: MachineId, post: HelmPost): void {
  const id = allocateId(ctx.state, "problem") as ProblemId;
  ctx.state.work.problems[id] = {
    id,
    kind: "stationToStaff",
    payload: { machineId, post },
    owner: "watch",
    visibility: "public",
    dedupeKey: dedupeKeyOf(machineId, post),
    status: "open",
    createdTick: ctx.tick,
    revision: 1,
    // The planner rates the helm essential either way; the relief's own class is routine (§2).
    baseUrgency: post === "watch" ? "essentialOperation" : "routineObligation",
    location: { kind: "machine", machineId },
  };
}

function settle(problem: ProblemOfKind<"stationToStaff"> | undefined): void {
  if (problem !== undefined) problem.status = "resolved";
}

/** The relief post: raised for a stander in need, settled once the stander is back. */
function updateRelief(
  ctx: StepCtx,
  machineId: MachineId,
  wanted: boolean,
  holder: ReturnType<typeof whoHasTheHelm>,
): void {
  const relief = openPost(ctx, machineId, "relief");
  const onWatchPost = (actorId: ActorId | undefined) => {
    const actor = actorId === undefined ? undefined : ctx.state.actors[actorId];
    return actor !== undefined && helmPostOf(ctx.state, machineId, actor) === "watch";
  };
  if (!wanted) {
    settle(relief);
    return;
  }
  if (relief !== undefined) {
    // Back: a watch-post stander has relieved the relief since it was raised (counted from the
    // handover, so the relief is not called back to the seat while they walk into it).
    const relievedAt = ctx.state.watch.helm.relievedAt;
    const cover = helmCover(ctx.state, ctx.content);
    const back =
      onWatchPost(cover) &&
      relievedAt !== undefined &&
      relievedAt.byActorId === cover &&
      relievedAt.tick >= relief.createdTick;
    const expired =
      ctx.tick - relief.createdTick >= dayTicks(ctx.config, ctx.config.watches.reliefMaxDays);
    if (back || expired) settle(relief);
    return;
  }
  const holderActor = holder === undefined ? undefined : ctx.state.actors[holder];
  if (holderActor !== undefined && onWatchPost(holder)) {
    if (needsPastEssential(ctx.config, holderActor)) raisePost(ctx, machineId, "relief");
  }
}

/** Did `elapsed` (ticks) reach `threshold` this tick? */
const crossed = (ctx: StepCtx, elapsed: number, threshold: number): boolean =>
  elapsed >= threshold && elapsed - ctx.elapsedTicks < threshold;

/**
 * `unattendedSinceTick` while the helm watch is wanted and nobody has the helm (any stage: the
 * headline's "waiting for someone at the helm" reads it); `helmUnattended` once per vacancy, after
 * `helmUnattendedSeconds` of it in transit (the manoeuvres stall instead, which the headline says).
 */
function trackVacancy(ctx: StepCtx, machineId: MachineId, wanted: boolean, manned: boolean): void {
  const helm = ctx.state.watch.helm;
  if (manned || !wanted) {
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete helm.unattendedSinceTick;
    return;
  }
  helm.unattendedSinceTick ??= ctx.tick;
  const travel = ctx.state.travel;
  if (travel.stage !== "transit") return;
  const since = Math.max(helm.unattendedSinceTick, travel.stageStartedTick);
  const seconds = ctx.config.watches.helmUnattendedSeconds;
  if (!crossed(ctx, ctx.tick - since, configTicks(ctx.config, seconds))) return;
  ctx.emit({
    type: "helmUnattended",
    subjectIds: [],
    causeIds: [],
    source: "sim",
    payload: { machineId, seconds },
  });
}

/** `stoodLongWatch` and `doubleWatch` for the one holding the helm, as their hold passes each. */
function longWatchThoughts(ctx: StepCtx, holder: ReturnType<typeof whoHasTheHelm>): void {
  const actor = holder === undefined ? undefined : ctx.state.actors[holder];
  const step = actor === undefined ? undefined : currentStep(actor.activity);
  if (actor === undefined || step?.kind !== "hold") return;
  const held = ctx.tick - step.sinceTick;
  const watch = watchTicks(ctx.config);
  if (crossed(ctx, held, Math.round(ctx.config.watches.longWatchFactor * watch))) {
    addThought(ctx, actor, "stoodLongWatch");
  }
  if (crossed(ctx, held, 2 * watch)) addThought(ctx, actor, "doubleWatch");
}

export const watchSystem: System = {
  name: "watch",
  phase: "needs",
  run(ctx) {
    ringBell(ctx);
    const helm = helmMachine(ctx.state, ctx.content);
    if (helm === undefined) return;
    const wanted = helmWanted(ctx);
    const watchPost = openPost(ctx, helm.id, "watch");
    if (wanted && watchPost === undefined) raisePost(ctx, helm.id, "watch");
    if (!wanted) settle(watchPost);
    const holder = whoHasTheHelm(ctx.state, ctx.content);
    updateRelief(ctx, helm.id, wanted, holder);
    trackVacancy(ctx, helm.id, wanted, helmManned(ctx.state, ctx.content));
    longWatchThoughts(ctx, holder);
  },
};
