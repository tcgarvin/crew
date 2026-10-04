/**
 * The helm as the duty station (D77): who stands it, the plan to take it, the handover, the
 * hold, and gangway watch in port.
 *
 * Who has the helm is physical: the crew member in a `staff` hold on a helm task, on its seat
 * (`whoHasTheHelm`); standing beside the console is not having it. Who *should* have it is the
 * sim's call, never the planner's (`helmRoleOf`, read by the planner through
 * `SelfView.watch.helmRole`):
 *
 * - The section on watch designates its stander: a qualified (piloting at least the helm's
 *   `operatorSkill.min`) non-officer first, highest piloting first; then a qualified officer of
 *   the section; then the nearest qualified non-officer aboard from any section, then the nearest
 *   qualified officer; then anyone in the section with piloting ≥ 1, then anyone aboard with it
 *   (the unqualified fallback the narrator sees).
 * - While the helm is empty a candidate must also be free to come: awake, and not busy with
 *   something the helm (essential) would not interrupt. So an idle qualified hand is designated
 *   rather than a stander who is eating or asleep, and a vacancy pulls the officer of the watch
 *   back to the bridge. While someone has it nobody is re-designated for being busy: the
 *   off-going or a relief holds until the designated stander comes.
 * - `oncoming`: the next section's stander, from `handoverLeadSeconds` before the bell. Once the
 *   oncoming has the helm, the off-going section has no stander.
 * - `relief`: any qualified, awake crew member aboard who is not on watch, while a `relief` post is
 *   open. A stander (or oncoming) with a need past `needEssentialAbove` is not called to a helm
 *   someone else holds (`none`) until it is seen to, so one relieved to eat goes and eats.
 *
 * Owner: W1 of ship life slice 2.
 */
import { configTicks, watchIndexAt, watchOfDay, watchTicks } from "../../core/clock";
import { isOnDock } from "../../core/docks";
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly, Tick, TileCoord } from "../../core/types/common";
import type { ConfigDef, ContentBundle } from "../../core/types/content";
import type { ActorId, MachineId } from "../../core/types/ids";
import type { ReadonlyWorldState, StepCtx } from "../../core/types/pipeline";
import type { Machine } from "../../core/types/ship";
import type { HelmRole } from "../../core/types/view";
import { type ActivityStep, type Task, URGENCY_CLASSES } from "../../core/types/work";
import { shipDeckId } from "../../core/world";
import { isStaticWalkable } from "../spatial/geometry";
import { interactionsAt } from "../spatial/reservations";
import { operateTiles } from "../travel/tasks";
import { currentStep } from "../work/activity";
import { type PlanResult, interactionTarget } from "../work/plans";
import type { StepResult } from "../work/steps";
import { isOnWatch } from "./duty";

type StepOf<K extends ActivityStep["kind"]> = Extract<ActivityStep, { kind: K }>;

/** What the helm's rules read: the world, its content and config, and the tick in question. */
export interface HelmReadCtx {
  readonly state: ReadonlyWorldState;
  readonly content: ContentBundle;
  readonly config: ConfigDef;
  readonly tick: Tick;
}

/** The helm's two posts (`stationToStaff.post`): the watch, and a relief for the stander. */
export type HelmPost = "watch" | "relief";

// ---------------------------------------------------------------------------------------------
// The helm and who has it
// ---------------------------------------------------------------------------------------------

/** The ship's helm: a `pilotStation` machine whose def requires an operator. */
export function helmMachine(
  state: Pick<ReadonlyWorldState, "machines">,
  content: Pick<ContentBundle, "machines">,
): DeepReadonly<Machine> | undefined {
  return Object.values(state.machines).find((m) => {
    const def = content.machines[m.defId];
    return def?.tags.includes("pilotStation") && def.operation.requiresOperator === true;
  });
}

/** The helm's seat: its first `operate` position. */
function seatTile(
  state: ReadonlyWorldState,
  content: ContentBundle,
  helmId: MachineId,
): TileCoord | undefined {
  return operateTiles({ state, content }, helmId)[0];
}

/** The post of the helm task an actor is on (any step), if they are on one. */
export function helmPostOf(
  state: ReadonlyWorldState,
  helmId: MachineId,
  actor: DeepReadonly<Actor>,
): HelmPost | undefined {
  const activity = actor.activity;
  if (activity.kind !== "task") return undefined;
  const task = state.work.tasks[activity.taskId];
  if (task?.type !== "staffStation" || task.target.kind !== "machine") return undefined;
  if (task.target.machineId !== helmId) return undefined;
  return task.derivationKey === "staff:relief" ? "relief" : "watch";
}

/**
 * The actor holding the helm: in a `staff` hold on a helm task, standing on its seat. Undefined
 * when the ship has no helm (or the helm no seat) or nobody holds it.
 */
export function whoHasTheHelm(
  state: ReadonlyWorldState,
  content: ContentBundle,
): ActorId | undefined {
  const helm = helmMachine(state, content);
  if (helm === undefined) return undefined;
  const seat = seatTile(state, content, helm.id);
  if (seat === undefined) return undefined;
  for (const actor of Object.values(state.actors)) {
    const location = actor.location;
    if (!actor.crew || actor.passenger === true || location.kind !== "onDeck") continue;
    if (location.deckId !== helm.deckId) continue;
    if (Math.floor(location.x) !== seat.x || Math.floor(location.y) !== seat.y) continue;
    const step = currentStep(actor.activity);
    if (step?.kind !== "hold" || step.hold !== "staff") continue;
    if (helmPostOf(state, helm.id, actor) !== undefined) return actor.id;
  }
  return undefined;
}

/**
 * Is the helm manned, or is there none to man? A crew member holds it from the seat
 * (`whoHasTheHelm`); a helm with no seat needs nobody.
 */
export function helmManned(state: ReadonlyWorldState, content: ContentBundle): boolean {
  const helm = helmMachine(state, content);
  if (helm === undefined || seatTile(state, content, helm.id) === undefined) return true;
  return whoHasTheHelm(state, content) !== undefined;
}

// ---------------------------------------------------------------------------------------------
// Who should have it
// ---------------------------------------------------------------------------------------------

const ESSENTIAL = URGENCY_CLASSES.indexOf("essentialOperation");

const isOfficer = (actor: DeepReadonly<Actor>): boolean =>
  actor.roleTags.some((role) => role === "captain" || role === "firstOfficer");

const pilotingOf = (actor: DeepReadonly<Actor>): number => actor.skills.piloting ?? 0;

/** The piloting the helm asks of a stander (its `operatorSkill.min`; 0 if it names none). */
function helmSkillMinOf(content: ContentBundle, helm: DeepReadonly<Machine>): number {
  const skill = content.machines[helm.defId]?.operation.operatorSkill;
  return skill?.skill === "piloting" ? skill.min : 0;
}

/** Crew aboard and up: available, on the ship's deck and not out on the dock alongside. */
function aboard(ctx: HelmReadCtx, actor: DeepReadonly<Actor>): boolean {
  if (!actor.crew || actor.passenger === true || actor.availability !== "available") return false;
  const location = actor.location;
  if (location.kind !== "onDeck" || location.deckId !== shipDeckId(ctx.state)) return false;
  return !isOnDock(ctx.content, ctx.state, location);
}

function asleep(actor: DeepReadonly<Actor>): boolean {
  const activity = actor.activity;
  return activity.kind === "personal" && activity.activity === "sleep";
}

/**
 * Free to come to an empty helm: awake, and doing nothing the helm's essential class would not
 * interrupt (idle, at or on the way to the helm, or anything routine or voluntary).
 */
function free(ctx: HelmReadCtx, helmId: MachineId, actor: DeepReadonly<Actor>): boolean {
  const activity = actor.activity;
  if (activity.kind === "idle") return true;
  if (helmPostOf(ctx.state, helmId, actor) !== undefined) return true;
  // Plotting the course the helm will steer (D78): they come straight on from the nav terminal.
  if (activity.kind === "task" && ctx.state.work.tasks[activity.taskId]?.type === "plotCourse") {
    return true;
  }
  if (asleep(actor)) return false;
  return URGENCY_CLASSES.indexOf(activity.urgency) > ESSENTIAL;
}

/** Manhattan tiles from the actor to `tile` (the seat): the "nearest" of the fallbacks. */
function distanceTo(actor: DeepReadonly<Actor>, tile: TileCoord | undefined): number {
  const location = actor.location;
  if (tile === undefined || location.kind !== "onDeck") return 0;
  return Math.abs(Math.floor(location.x) - tile.x) + Math.abs(Math.floor(location.y) - tile.y);
}

const byId = (a: DeepReadonly<Actor>, b: DeepReadonly<Actor>): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Everyone who might stand the watch with index `watch` of the day, in the order they are
 * asked: the section's qualified non-officers then officers (by piloting), the nearest qualified
 * non-officers then officers aboard, then the section's and everyone's piloting ≥ 1.
 * `sectionOnly` keeps the section's own tiers (the oncoming is never someone else's).
 */
function standerOrder(
  ctx: HelmReadCtx,
  helm: DeepReadonly<Machine>,
  watch: number,
  sectionOnly: boolean,
): DeepReadonly<Actor>[] {
  const min = helmSkillMinOf(ctx.content, helm);
  const seat = seatTile(ctx.state, ctx.content, helm.id);
  const crew = Object.values(ctx.state.actors).filter((a) => a.crew && a.passenger !== true);
  const inSection = (a: DeepReadonly<Actor>) => a.schedule.section?.index === watch;
  const byPiloting = (a: DeepReadonly<Actor>, b: DeepReadonly<Actor>) =>
    pilotingOf(b) - pilotingOf(a) || byId(a, b);
  const byDistance = (a: DeepReadonly<Actor>, b: DeepReadonly<Actor>) =>
    distanceTo(a, seat) - distanceTo(b, seat) || byPiloting(a, b);
  const qualified = (a: DeepReadonly<Actor>) => pilotingOf(a) >= min;
  const someSkill = (a: DeepReadonly<Actor>) => pilotingOf(a) >= 1 && !qualified(a);
  const tier = (
    pick: (a: DeepReadonly<Actor>) => boolean,
    order: (a: DeepReadonly<Actor>, b: DeepReadonly<Actor>) => number,
  ) => crew.filter(pick).sort(order);
  const section = [
    ...tier((a) => inSection(a) && qualified(a) && !isOfficer(a), byPiloting),
    ...tier((a) => inSection(a) && qualified(a) && isOfficer(a), byPiloting),
  ];
  const unqualifiedSection = tier((a) => inSection(a) && someSkill(a), byPiloting);
  if (sectionOnly) return [...section, ...unqualifiedSection];
  return [
    ...section,
    ...tier((a) => !inSection(a) && qualified(a) && !isOfficer(a), byDistance),
    ...tier((a) => !inSection(a) && qualified(a) && isOfficer(a), byDistance),
    ...unqualifiedSection,
    ...tier((a) => !inSection(a) && someSkill(a), byDistance),
  ];
}

/** The helm's people at one moment. */
export interface HelmWatch {
  readonly helmId: MachineId;
  /** Who holds the seat now. */
  readonly holder?: ActorId;
  /**
   * Who has the helm in hand: the holder, or one who has just relieved (or taken) it and is on
   * their way into the seat. While someone does, nobody is called to it for being needed.
   */
  readonly cover?: ActorId;
  /** Who should: the section on watch's stander (absent once the oncoming has taken over). */
  readonly stander?: ActorId;
  /** The next section's stander, from `handoverLeadSeconds` before the bell. */
  readonly oncoming?: ActorId;
  /** A `relief` post is open. */
  readonly reliefOpen: boolean;
}

function openPost(state: ReadonlyWorldState, helmId: MachineId, post: HelmPost): boolean {
  return Object.values(state.work.problems).some(
    (p) =>
      p.kind === "stationToStaff" &&
      p.status === "open" &&
      p.payload.machineId === helmId &&
      p.payload.post === post,
  );
}

/**
 * The one who last relieved (or took) the helm, while still on their way into the seat: on a
 * helm task with its hold still ahead.
 */
function incoming(
  state: ReadonlyWorldState,
  helmId: MachineId,
  actorId: ActorId | undefined,
): ActorId | undefined {
  const actor = actorId === undefined ? undefined : state.actors[actorId];
  if (actor === undefined || helmPostOf(state, helmId, actor) === undefined) return undefined;
  const activity = actor.activity;
  if (activity.kind === "idle" || activity.plan === undefined) return undefined;
  const ahead = activity.plan.steps.slice(activity.plan.stepIndex);
  return ahead.some((step) => step.kind === "hold") ? actor.id : undefined;
}

/** Who has the helm in hand (`HelmWatch.cover`): the holder, or the one on their way in. */
export function helmCover(state: ReadonlyWorldState, content: ContentBundle): ActorId | undefined {
  const helm = helmMachine(state, content);
  if (helm === undefined) return undefined;
  const holder = whoHasTheHelm(state, content);
  return holder ?? incoming(state, helm.id, state.watch.helm.relievedAt?.byActorId);
}

/** The helm's people at `ctx.tick`; undefined for a ship with no helm. */
export function helmWatchOf(ctx: HelmReadCtx): HelmWatch | undefined {
  const helm = helmMachine(ctx.state, ctx.content);
  if (helm === undefined || seatTile(ctx.state, ctx.content, helm.id) === undefined) {
    return undefined;
  }
  const holder = whoHasTheHelm(ctx.state, ctx.content);
  const relievedAt = ctx.state.watch.helm.relievedAt;
  const cover = holder ?? incoming(ctx.state, helm.id, relievedAt?.byActorId);
  const held = cover !== undefined;
  const watchIndex = watchIndexAt(ctx.config, ctx.tick);
  const ofDay = watchOfDay(ctx.config, ctx.tick);
  const stander = standerOrder(ctx, helm, ofDay, false).find(
    (a) => aboard(ctx, a) && (held || free(ctx, helm.id, a)),
  )?.id;
  const nextBell = (watchIndex + 1) * watchTicks(ctx.config);
  const windowStart = nextBell - configTicks(ctx.config, ctx.config.watches.handoverLeadSeconds);
  const next = (ofDay + 1) % ctx.config.time.watchesPerDay;
  const oncoming =
    ctx.tick >= windowStart
      ? standerOrder(ctx, helm, next, true).find((a) => aboard(ctx, a) && a.id !== stander)?.id
      : undefined;
  const takenOver =
    oncoming !== undefined &&
    (holder === oncoming || (relievedAt?.byActorId === oncoming && relievedAt.tick >= windowStart));
  return {
    helmId: helm.id,
    ...(holder === undefined ? {} : { holder }),
    ...(cover === undefined ? {} : { cover }),
    ...(stander === undefined || takenOver ? {} : { stander }),
    ...(oncoming === undefined ? {} : { oncoming }),
    reliefOpen: openPost(ctx.state, helm.id, "relief"),
  };
}

/** Any of hunger, fatigue, comfort or social past `urgency.needEssentialAbove`. */
export function needsPastEssential(config: ConfigDef, actor: DeepReadonly<Actor>): boolean {
  const limit = config.urgency.needEssentialAbove;
  const { hunger, fatigue, comfort, social } = actor.needs;
  return hunger > limit || fatigue > limit || comfort > limit || social > limit;
}

/** What `actorId` is to the helm at `ctx.tick` (`SelfView.watch.helmRole`). */
export function helmRoleOf(ctx: HelmReadCtx, actorId: ActorId): HelmRole {
  const watch = helmWatchOf(ctx);
  const actor = ctx.state.actors[actorId];
  if (watch === undefined || actor === undefined) return "none";
  if (watch.stander === actorId || watch.oncoming === actorId) {
    // Someone has the helm while they see to a pressing need (relieved for it, or covering while
    // they ate): not called to it until the need is seen to. An empty helm still calls them.
    const seeingToNeed =
      watch.cover !== undefined && watch.cover !== actorId && needsPastEssential(ctx.config, actor);
    if (seeingToNeed) return "none";
    return watch.stander === actorId ? "stander" : "oncoming";
  }
  if (!watch.reliefOpen || watch.holder === actorId) return "none";
  const helm = ctx.state.machines[watch.helmId];
  const qualified = helm !== undefined && pilotingOf(actor) >= helmSkillMinOf(ctx.content, helm);
  const offWatch = !isOnWatch(actor.schedule, ctx.tick, ctx.config);
  return qualified && offWatch && aboard(ctx, actor) && !asleep(actor) ? "relief" : "none";
}

/**
 * Officer of the watch: the captain or first officer of the section on watch, unless they are
 * standing its helm. An officer who is the section's stander only stands it while the helm watch
 * is wanted (its `watch` post open); in port with no course they stand no gangway (never an
 * officer), so they are the officer of the watch.
 */
export function isOfficerOfTheWatch(ctx: HelmReadCtx, actorId: ActorId): boolean {
  const actor = ctx.state.actors[actorId];
  if (actor === undefined || !isOfficer(actor)) return false;
  if (!isOnWatch(actor.schedule, ctx.tick, ctx.config)) return false;
  if (helmRoleOf(ctx, actorId) !== "stander") return true;
  const helm = helmMachine(ctx.state, ctx.content);
  return helm === undefined || !openPost(ctx.state, helm.id, "watch");
}

// ---------------------------------------------------------------------------------------------
// The plan and its steps
// ---------------------------------------------------------------------------------------------

/** The machine's interaction position with `purpose`, strictly (no fallback to another). */
function positionFor(
  ctx: StepCtx,
  actor: Actor,
  machineId: MachineId,
  purpose: "operate" | "use",
): { machineId: MachineId; positionKey: string } | undefined {
  if (actor.location.kind !== "onDeck") return undefined;
  const geometry = ctx.caches.nav.decks[actor.location.deckId];
  const position = geometry?.interactionPositions.find(
    (p) => p.machineId === machineId && p.purposes.includes(purpose),
  );
  return position === undefined ? undefined : { machineId, positionKey: position.key };
}

/**
 * A floor tile beside the seat to step off onto when the hold ends, so the oncoming can sit
 * down at once: the first walkable neighbour (sides before corners) that is no interaction
 * position. Undefined if there is none.
 */
function stepOffTile(ctx: StepCtx, actor: Actor, seat: TileCoord): TileCoord | undefined {
  if (actor.location.kind !== "onDeck") return undefined;
  const geometry = ctx.caches.nav.decks[actor.location.deckId];
  if (geometry === undefined) return undefined;
  const around = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
    [1, -1],
    [1, 1],
    [-1, 1],
    [-1, -1],
  ] as const;
  for (const [dx, dy] of around) {
    const tile = { x: seat.x + dx, y: seat.y + dy };
    if (!isStaticWalkable(geometry, tile.x, tile.y)) continue;
    if (interactionsAt(geometry, tile).length > 0) continue;
    return tile;
  }
  return undefined;
}

/**
 * The plan for a `staffStation` task (call 7): with someone else at the helm, `moveTo standby →
 * work handover → moveTo seat → hold staff`; with it empty (or no standby position), `moveTo seat
 * → work handover → hold staff`, the handover then being done at once. Either way the hold is
 * followed by a step off the seat, so whoever relieves them can sit down.
 */
export function helmPlan(ctx: StepCtx, actor: Actor, task: Task): PlanResult {
  if (task.target.kind !== "machine") return { ok: false, reason: "unreachableTarget" };
  const machineId = task.target.machineId;
  const seat = interactionTarget(ctx, actor, machineId, "operate");
  if (seat === undefined) return { ok: false, reason: "unreachableTarget" };
  const handover: ActivityStep = {
    kind: "work",
    stage: "handover",
    ticksDone: 0,
    ticksNeeded: Math.max(1, configTicks(ctx.config, ctx.config.watches.handoverSeconds)),
  };
  const toSeat: ActivityStep = { kind: "moveTo", target: seat, requested: false };
  const hold: ActivityStep = { kind: "hold", hold: "staff", sinceTick: ctx.tick };
  const holder = whoHasTheHelm(ctx.state, ctx.content);
  const standby = positionFor(ctx, actor, machineId, "use");
  const taken = (holder !== undefined && holder !== actor.id) || onTheirWay(ctx, actor, machineId);
  const steps: ActivityStep[] =
    taken && standby !== undefined
      ? [{ kind: "moveTo", target: standby, requested: false }, handover, toSeat, hold]
      : [toSeat, handover, hold];
  const seatTileNow = operateTiles(ctx, machineId)[0];
  const off = seatTileNow === undefined ? undefined : stepOffTile(ctx, actor, seatTileNow);
  if (off !== undefined) steps.push({ kind: "moveTo", target: off, requested: false });
  return { ok: true, plan: { steps, stepIndex: 0 } };
}

function relieve(
  ctx: StepCtx,
  actor: Actor,
  machineId: MachineId,
  fromActorId: ActorId | undefined,
): void {
  ctx.state.watch.helm.relievedAt = { tick: ctx.tick, byActorId: actor.id };
  ctx.emit({
    type: "helmRelieved",
    subjectIds: fromActorId === undefined ? [actor.id] : [actor.id, fromActorId],
    causeIds: [],
    source: "sim",
    payload: {
      machineId,
      byActorId: actor.id,
      ...(fromActorId === undefined ? {} : { fromActorId }),
    },
  });
}

/**
 * The `handover` work step. With someone else at the helm it counts `watches.handoverSeconds`,
 * then records `watch.helm.relievedAt` (which ends their hold, `helmHoldDone`), emits
 * `helmRelieved` and waits the tick or so until they are off the seat. With the helm empty it
 * is done at once: "takes the helm".
 */
export function runHandover(ctx: StepCtx, actor: Actor, step: StepOf<"work">): StepResult {
  const helm = helmMachine(ctx.state, ctx.content);
  if (helm === undefined) return { fail: "unreachableTarget" };
  const holder = whoHasTheHelm(ctx.state, ctx.content);
  if (holder !== undefined && holder !== actor.id) {
    if (step.ticksDone < step.ticksNeeded) {
      step.ticksDone += 1;
      if (step.ticksDone >= step.ticksNeeded) relieve(ctx, actor, helm.id, holder);
    }
    return "wait";
  }
  if (step.ticksDone < step.ticksNeeded) {
    // Someone else is walking into the empty seat: wait for them to sit, then relieve them.
    if (intoTheSeat(ctx, actor, helm.id)) return "wait";
    step.ticksDone = step.ticksNeeded;
    relieve(ctx, actor, helm.id, undefined);
  }
  return "done";
}

/** Another crew member on a helm task with their hold still ahead (walking up, or handing over). */
function onTheirWay(ctx: StepCtx, actor: Actor, helmId: MachineId): boolean {
  return Object.values(ctx.state.actors).some(
    (other) => other.id !== actor.id && incoming(ctx.state, helmId, other.id) !== undefined,
  );
}

/** Another crew member on a helm task whose current step is the walk into the seat. */
function intoTheSeat(ctx: StepCtx, actor: Actor, helmId: MachineId): boolean {
  return Object.values(ctx.state.actors).some((other) => {
    if (other.id === actor.id || helmPostOf(ctx.state, helmId, other) === undefined) return false;
    const step = currentStep(other.activity);
    return (
      step?.kind === "moveTo" &&
      "machineId" in step.target &&
      step.target.machineId === helmId &&
      positionFor(ctx, other, helmId, "operate")?.positionKey === step.target.positionKey
    );
  });
}

/**
 * Does a `staff` hold end? When someone else has relieved this actor since the hold began, or
 * the helm watch has ended (its `watch` post closed: docked with no course). A relief holds on
 * after its own post closes (`reliefMaxDays`): leaving would empty the helm; whoever comes next
 * relieves them as anyone is relieved.
 */
export function helmHoldDone(ctx: StepCtx, actor: Actor, step: StepOf<"hold">): boolean {
  const activity = actor.activity;
  const task = activity.kind === "task" ? ctx.state.work.tasks[activity.taskId] : undefined;
  if (task === undefined || task.target.kind !== "machine") return true;
  const own = ctx.state.work.problems[task.problemId]?.status === "open";
  if (!own && !openPost(ctx.state, task.target.machineId, "watch")) return true;
  const relieved = ctx.state.watch.helm.relievedAt;
  return (
    relieved !== undefined && relieved.byActorId !== actor.id && relieved.tick >= step.sinceTick
  );
}

/** Does `actor` hold the helm (a `staff` hold on a helm task)? For skill gain at the helm. */
export function holdsTheHelm(ctx: StepCtx, actor: Actor): boolean {
  return whoHasTheHelm(ctx.state, ctx.content) === actor.id;
}

// ---------------------------------------------------------------------------------------------
// Gangway watch
// ---------------------------------------------------------------------------------------------

/** The deck's gangway post: the first tile of its zone tagged `gangway`. */
function gangwayTile(ctx: StepCtx, actor: Actor): TileCoord | undefined {
  if (actor.location.kind !== "onDeck") return undefined;
  const deck = ctx.content.decks[actor.location.deckId];
  return deck?.zones.find((zone) => zone.tags.includes("gangway"))?.tiles[0];
}

/** Gangway watch (`standWatch`): to the gangway post and hold there. */
export function gangwayPlan(ctx: StepCtx, actor: Actor): PlanResult {
  const tile = gangwayTile(ctx, actor);
  if (tile === undefined) return { ok: false, reason: "unreachableTarget" };
  return {
    ok: true,
    plan: {
      steps: [
        { kind: "moveTo", target: { x: tile.x, y: tile.y }, requested: false },
        { kind: "hold", hold: "gangway", sinceTick: ctx.tick },
      ],
      stepIndex: 0,
    },
  };
}

/**
 * Does a `gangway` hold end? When the ship is no longer docked, or they are no longer the
 * stander. Its first tick says so in the trace (`gangwayWatchSet`).
 */
export function gangwayHoldDone(ctx: StepCtx, actor: Actor, step: StepOf<"hold">): boolean {
  if (step.sinceTick === ctx.tick) {
    ctx.emit({
      type: "gangwayWatchSet",
      subjectIds: [actor.id],
      causeIds: [],
      source: "sim",
      payload: { actorId: actor.id },
    });
  }
  if (ctx.state.travel.stage !== "docked") return true;
  return helmRoleOf(ctx, actor.id) !== "stander";
}
