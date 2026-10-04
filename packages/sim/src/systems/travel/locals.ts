/**
 * Locals on the dock (Dockside §5, D66): walking, the three scripted behaviours, and the dock's
 * dressing and clearing as it comes and goes. Placement is `core/locals.ts`; the dock-hand
 * errands that move freight are commerce's (`systems/commerce/dock-hands.ts`).
 *
 * Walking uses the crew's nav grid and A* (`cachedPath`) under a policy for which every door is
 * impassable. The only doors on the grafted dock's edge are the ramps, so a local's route never
 * leaves the dock floor; the hull does the rest. Speed is `movement.walkSpeed`, slowed by the
 * same corridor-passing factor as the crew's when someone (crew or local) is within half a tile;
 * the crew are slowed by locals the same way (`spatial/movement.ts`). Locals have no needs,
 * skills, load or traits, and nothing about them reaches the planner.
 *
 * Behaviours:
 * - `atPost`: stand at `home`; every `travel.localShuffleSeconds` (plus a per-person offset) step
 *   to a free neighbouring floor tile and, next time, back.
 * - `walkTo`: walk to `tile`; with no errand, stand there (`atPost` with that home). A dock hand's
 *   errand takes over on arrival (commerce).
 * - `leave`: walk to `exit`; gone on arrival, or at once if the way is blocked: leaving needs no
 *   witness, and a local who cannot leave must not stand there forever.
 */
import { configTicks } from "../../core/clock";
import { dockAlongside, postTile } from "../../core/docks";
import {
  clearDockside,
  dockNeedsDressing,
  dressDock,
  localTiles,
  nextShuffleTick,
} from "../../core/locals";
import type { TileCoord } from "../../core/types/common";
import type { DockDef } from "../../core/types/content";
import type { Local, LocalBehaviour, StagingPlan } from "../../core/types/dockside";
import type { LocalId, PortDefId } from "../../core/types/ids";
import type { DeckGeometry } from "../../core/types/nav";
import type { StepCtx, System } from "../../core/types/pipeline";
import { deckGeometry, isDockTile, isWalkable } from "../spatial/geometry";
import { indexAt } from "../spatial/grid";
import { centre, overlapSpeedFactor, tileOf, withinHalfTile } from "../spatial/movement";
import { type PathPolicy, cachedPath, stepLength } from "../spatial/pathfind";
import { takeCratesIntoStore, withdrawJobCrates } from "./dock-custody";

type Ctx = StepCtx;

const EPS = 1e-9;

const sameTile = (a: TileCoord, b: TileCoord) => a.x === b.x && a.y === b.y;

/** Is this local standing (not walking) on `tile`? */
export function standingOn(local: Local, tile: TileCoord): boolean {
  return local.movement.kind === "stationary" && sameTile(tileOf(local.location), tile);
}

/** A* for locals: dock floor only (every door, so every ramp, is impassable). */
function localPolicy(ctx: Pick<Ctx, "state">, geometry: DeckGeometry): PathPolicy {
  return {
    key: `o${ctx.state.deck.geometryRevision}`,
    doorCost: () => null,
    tileBlocked: (x, y) => geometry.obstructed[indexAt(geometry, x, y)] === 1,
  };
}

/**
 * Start (or redirect) `local`'s walk to `to`. A local mid-step finishes that step first. Returns
 * false, leaving the local as they were, when there is no route on the dock floor. Standing on
 * `to` already is success.
 */
function walkLocal(ctx: Ctx, local: Local, to: TileCoord): boolean {
  // A registry without spatial (commerce-only tests) has no nav grid: no route, so a dock hand's
  // errand falls back to the instant behaviour, with its `dockHandGaveUp` event.
  const geometry = ctx.caches.nav.decks[local.location.deckId];
  if (geometry === undefined) return false;
  const movement = local.movement;
  const midStep = movement.kind === "moving" && movement.segmentDistanceTravelled > 0;
  const current = movement.kind === "moving" ? movement.path[movement.segmentIndex] : undefined;
  const nextTile =
    movement.kind === "moving" ? movement.path[movement.segmentIndex + 1] : undefined;
  const from = midStep && nextTile !== undefined ? nextTile : (current ?? tileOf(local.location));
  const route = cachedPath(ctx.caches, geometry, from, to, localPolicy(ctx, geometry));
  if (route === null) return false;
  const tail = route.map((t) => ({ x: t.x, y: t.y }));
  if (midStep && current !== undefined && movement.kind === "moving") {
    local.movement = {
      kind: "moving",
      path: [{ x: current.x, y: current.y }, ...tail],
      segmentIndex: 0,
      segmentDistanceTravelled: movement.segmentDistanceTravelled,
    };
    return true;
  }
  if (tail.length <= 1) {
    local.movement = { kind: "stationary" };
    local.location = { deckId: local.location.deckId, ...centre(to) };
    return true;
  }
  local.movement = { kind: "moving", path: tail, segmentIndex: 0, segmentDistanceTravelled: 0 };
  return true;
}

/** Positions of everyone who slows a walker down: crew on deck and the other locals. */
function bodies(ctx: Ctx): { id: string; x: number; y: number }[] {
  const out: { id: string; x: number; y: number }[] = [];
  for (const actor of Object.values(ctx.state.actors)) {
    if (actor.location.kind === "onDeck") {
      out.push({ id: actor.id, x: actor.location.x, y: actor.location.y });
    }
  }
  for (const local of Object.values(ctx.state.dockside.locals)) {
    out.push({ id: local.id, x: local.location.x, y: local.location.y });
  }
  return out;
}

function crowded(local: Local, others: readonly { id: string; x: number; y: number }[]): boolean {
  return others.some((o) => o.id !== local.id && withinHalfTile(local.location, o));
}

/** Walk one local up to `budget` tiles. A tile turned unwalkable ends the walk there. */
function stepLocal(local: Local, geometry: DeckGeometry, budget: number): void {
  let remaining = budget;
  for (;;) {
    const movement = local.movement;
    if (movement.kind !== "moving") return;
    const a = movement.path[movement.segmentIndex];
    const b = movement.path[movement.segmentIndex + 1];
    if (a === undefined || b === undefined) {
      local.movement = { kind: "stationary" };
      if (a !== undefined) local.location = { ...local.location, ...centre(a) };
      return;
    }
    if (movement.segmentDistanceTravelled === 0 && !isWalkable(geometry, b.x, b.y)) {
      local.movement = { kind: "stationary" };
      local.location = { ...local.location, ...centre(a) };
      return;
    }
    if (remaining <= EPS) return;
    const length = stepLength(a, b);
    const step = Math.min(remaining, length - movement.segmentDistanceTravelled);
    movement.segmentDistanceTravelled += step;
    remaining -= step;
    local.facing = Math.atan2(b.y - a.y, b.x - a.x);
    if (movement.segmentDistanceTravelled >= length - EPS) {
      movement.segmentIndex += 1;
      movement.segmentDistanceTravelled = 0;
      local.location = { ...local.location, ...centre(b) };
      continue;
    }
    const t = movement.segmentDistanceTravelled / length;
    local.location = {
      ...local.location,
      x: a.x + 0.5 + (b.x - a.x) * t,
      y: a.y + 0.5 + (b.y - a.y) * t,
    };
    return;
  }
}

/** Send `local` off through `exit`; gone at once when there is no way there. */
export function sendLocalAway(ctx: Ctx, local: Local, exit: TileCoord): void {
  local.behaviour = { kind: "leave", exit: { x: exit.x, y: exit.y }, sinceTick: ctx.tick };
  if (!walkLocal(ctx, local, exit)) delete ctx.state.dockside.locals[local.id];
}

/** Set `local` walking to `tile` (`walkTo`). False, unchanged behaviour, when it has no route. */
export function sendLocalTo(ctx: Ctx, local: Local, tile: TileCoord): boolean {
  if (!walkLocal(ctx, local, tile)) return false;
  local.behaviour = { kind: "walkTo", tile: { x: tile.x, y: tile.y }, sinceTick: ctx.tick };
  return true;
}

/** Stand where they are, at their post from now on. */
export function settleLocal(ctx: Ctx, local: Local): void {
  local.behaviour = atPostHere(ctx, local);
}

function atPostHere(ctx: Ctx, local: Local): LocalBehaviour {
  const shuffle = configTicks(ctx.config, ctx.config.travel.localShuffleSeconds);
  return {
    kind: "atPost",
    home: tileOf(local.location),
    nextShuffleTick: nextShuffleTick(local.id, ctx.tick, shuffle),
  };
}

/** A free floor tile beside `home` (4-neighbours, in an order that varies per person and time). */
function shuffleSpot(
  ctx: Ctx,
  local: Local,
  home: TileCoord,
  dock: DockDef,
): TileCoord | undefined {
  const geometry = deckGeometry(ctx.caches, local.location.deckId);
  const taken = localTiles(ctx.state);
  const around = [
    { x: home.x + 1, y: home.y },
    { x: home.x, y: home.y + 1 },
    { x: home.x - 1, y: home.y },
    { x: home.x, y: home.y - 1 },
  ];
  const start = (ctx.tick + local.lookSeed) % around.length;
  for (let i = 0; i < around.length; i++) {
    const tile = around[(start + i) % around.length] as TileCoord;
    const onDock = isDockTile(geometry, tile.x, tile.y) && isWalkable(geometry, tile.x, tile.y);
    const isPost = dock.posts.some((p) => sameTile(postTile(dock, p), tile));
    if (onDock && !isPost && !taken.has(`${tile.x},${tile.y}`)) return tile;
  }
  return undefined;
}

/** D70: an actor's meeting with this local (a `talk` step with them) is still ahead or under way. */
function sought(ctx: Ctx, local: Local): boolean {
  return Object.values(ctx.state.actors).some((actor) => {
    const activity = actor.activity;
    if (activity.kind !== "personal" || activity.plan === undefined) return false;
    const { steps, stepIndex } = activity.plan;
    return steps.some((s, i) => i >= stepIndex && s.kind === "talk" && s.localId === local.id);
  });
}

/** `atPost`: the idle shuffle, out to a neighbouring tile and back. */
function shuffle(ctx: Ctx, local: Local, dock: DockDef): void {
  const behaviour = local.behaviour;
  if (behaviour.kind !== "atPost" || local.movement.kind !== "stationary") return;
  if (ctx.tick < behaviour.nextShuffleTick) return;
  // D70: someone the captain is walking over to, or talking with, stands still for it.
  if (sought(ctx, local)) return;
  const every = configTicks(ctx.config, ctx.config.travel.localShuffleSeconds);
  behaviour.nextShuffleTick = nextShuffleTick(local.id, ctx.tick, every);
  const here = tileOf(local.location);
  const target = sameTile(here, behaviour.home)
    ? shuffleSpot(ctx, local, behaviour.home, dock)
    : behaviour.home;
  if (target !== undefined) walkLocal(ctx, local, target);
}

/** One local's tick of behaviour, after they have walked. */
function behave(ctx: Ctx, local: Local, dock: DockDef): void {
  const behaviour = local.behaviour;
  switch (behaviour.kind) {
    case "atPost":
      shuffle(ctx, local, dock);
      return;
    case "walkTo":
      // A dock hand's errand decides what happens on arrival, or when the walk stops short.
      if (local.errand !== undefined || local.movement.kind === "moving") return;
      settleLocal(ctx, local);
      return;
    case "leave":
      if (local.movement.kind === "moving") return;
      if (standingOn(local, behaviour.exit) || !walkLocal(ctx, local, behaviour.exit)) {
        delete ctx.state.dockside.locals[local.id];
      }
      return;
  }
}

// ---------------------------------------------------------------------------------------------
// The dock coming and going
// ---------------------------------------------------------------------------------------------

/**
 * Dress the dock alongside with the floor set and (at the start of `docking`) the staging plan,
 * and say so: `dockDressed` always, `dockAmbience` when the plan had a line.
 */
export function dressDockAlongside(ctx: Ctx, plan: StagingPlan | undefined): void {
  const shuffleTicks = configTicks(ctx.config, ctx.config.travel.localShuffleSeconds);
  const dressed = dressDock(ctx.state, ctx.content, plan, ctx.tick, shuffleTicks);
  const dock = dockAlongside(ctx.content, ctx.state);
  if (dock === undefined) throw new Error("dressDockAlongside: the dock went while dressing it");
  ctx.emit({
    type: "dockDressed",
    subjectIds: dressed.locals.map((l) => l.id),
    causeIds: [],
    source: "sim",
    locationRef: { kind: "port", portId: dock.portId },
    payload: {
      portId: dock.portId,
      dockId: dock.id,
      localIds: dressed.locals.map((l) => l.id),
      props: ctx.state.dockside.props.length,
      staged: plan !== undefined,
      unplaced: dressed.unplaced,
    },
  });
  const line = ctx.state.dockside.ambience;
  if (line !== undefined) {
    ctx.emit({
      type: "dockAmbience",
      subjectIds: [],
      causeIds: [],
      source: "sim",
      locationRef: { kind: "port", portId: dock.portId },
      payload: { portId: dock.portId, line },
    });
  }
}

/**
 * Just before the dock is cast off at the end of `undocking`: a dock hand still carrying out an
 * errand has it done at once (`dockHandGaveUp`, reason `castOff`), so no crate of theirs is left
 * on the dock for `clearDock` to send to the warehouse as the ship's; then the dock "slides away
 * with them": every local and prop goes with it, without walking anywhere.
 */
export function dismissLocals(ctx: Ctx, portId: PortDefId): void {
  for (const local of Object.values(ctx.state.dockside.locals)) {
    const errand = local.errand;
    if (errand === undefined) continue;
    const job = ctx.state.jobs[errand.jobId];
    const pickupPending = errand.kind !== "stageOffer" && errand.phase === "fetch";
    if (job !== undefined && pickupPending) {
      if (errand.kind === "withdrawOffer") withdrawJobCrates(ctx, job);
      else takeCratesIntoStore(ctx, job, errand.itemIds, portId);
      ctx.emit({
        type: "dockHandGaveUp",
        subjectIds: [local.id, job.id],
        causeIds: [],
        source: "sim",
        locationRef: { kind: "port", portId },
        payload: { localId: local.id, jobId: job.id, errand: errand.kind, reason: "castOff" },
      });
    }
  }
  clearDockside(ctx.state);
}

/** Every local, after the crew have moved (phase `actions`). */
export const localsSystem: System = {
  name: "travel.locals",
  phase: "actions",
  run(ctx) {
    // A new game's dock is dressed at creation; one restored from before D66 is dressed here.
    if (dockNeedsDressing(ctx.state)) dressDockAlongside(ctx, undefined);
    const dock = dockAlongside(ctx.content, ctx.state);
    if (dock === undefined) return;
    const dt = ctx.elapsedTicks / ctx.config.time.tickRate;
    const others = bodies(ctx);
    const passing = overlapSpeedFactor(ctx.config);
    for (const local of Object.values(ctx.state.dockside.locals)) {
      if (local.movement.kind !== "moving") continue;
      const geometry = deckGeometry(ctx.caches, local.location.deckId);
      const speed = ctx.config.movement.walkSpeed * (crowded(local, others) ? passing : 1);
      stepLocal(local, geometry, speed * dt);
    }
    for (const id of Object.keys(ctx.state.dockside.locals) as LocalId[]) {
      const local = ctx.state.dockside.locals[id];
      if (local !== undefined) behave(ctx, local, dock);
    }
  },
};
