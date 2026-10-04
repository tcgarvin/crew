/**
 * D70: the plans of the captain ashore (dockside §6.2). Both are personal activities that only
 * commerce hands out (`systems/commerce/ashore.ts`), never the planner:
 *
 * - `lookForWork`: down the personnel ramp onto the dock (commerce raises `captainAshore` the tick
 *   they stand on it), wait there for the narrator's answer (`awaitWord`), then, when the answer
 *   held nothing for the captain, a look round: over to one of the dock's posts, perhaps out
 *   through the gate for a few seconds, and back up the ramp. No second ask.
 * - `meetSpeaker`: to the person a held card names. Someone on the dock: walk up beside them,
 *   talk for `travel.talkSeconds` ("talking with Fenwick Adair"), and their card comes up
 *   (`deliverCard`). Anyone else is in the port beyond the gate: walk out through it, be off ship
 *   for `travel.gateVisitSeconds`, and the card comes up on the way back in. Then back aboard.
 */
import { configTicks } from "../../core/clock";
import { heldCard, localNamed } from "../../core/delivery";
import { dockAlongside, dockPost, postServiceTile, postTile } from "../../core/docks";
import { personnelRampFoot } from "../../core/locals";
import type { Actor } from "../../core/types/actor";
import type { TileCoord } from "../../core/types/common";
import type { DockDef } from "../../core/types/content";
import type { DecisionId, DeckDefId, DoorId, PortDefId } from "../../core/types/ids";
import type { DeckGeometry } from "../../core/types/nav";
import type { StepCtx } from "../../core/types/pipeline";
import type { ActivityPlan, ActivityStep, BlockageReason } from "../../core/types/work";
import { dockRamps, rampLanding, rampTop } from "../spatial/dock";
import { deckGeometry, isDockTile, isWalkable } from "../spatial/geometry";

type ShorePlan =
  | { readonly ok: true; readonly plan: ActivityPlan }
  | { readonly ok: false; readonly reason: BlockageReason };

const planOf = (steps: ActivityStep[]): ShorePlan => ({ ok: true, plan: { steps, stepIndex: 0 } });
const blocked = (reason: BlockageReason): ShorePlan => ({ ok: false, reason });

const move = (tile: TileCoord): ActivityStep => ({
  kind: "moveTo",
  target: { x: tile.x, y: tile.y },
  requested: false,
});

/** The docked port, its dock and the ramp tiles a walk ashore needs, or undefined. */
interface Shore {
  readonly portId: PortDefId;
  readonly dock: DockDef;
  readonly geometry: DeckGeometry;
  /** The dock tile at the foot of the personnel ramp. */
  readonly foot: TileCoord;
  /** The ship tile at its top, where a walk back aboard ends. */
  readonly top: TileCoord;
  /** The gate tile, when the dock has one. */
  readonly gate: TileCoord | undefined;
}

/** The personnel ramp's door (by the deck's `personnelRampDoorKey`), else any ramp with a foot. */
function personnelRamp(
  ctx: StepCtx,
  deckId: DeckDefId,
  geometry: DeckGeometry,
): DoorId | undefined {
  const ramps = dockRamps(geometry);
  const key = ctx.content.decks[deckId]?.docking.personnelRampDoorKey;
  const named = ramps.find((id) => ctx.state.doors[id]?.placementKey === key);
  return named ?? ramps[0];
}

function shoreHere(ctx: StepCtx): Shore | undefined {
  const travel = ctx.state.travel;
  const presence = ctx.state.deck.dock;
  const dock = dockAlongside(ctx.content, ctx.state);
  if (travel.stage !== "docked" || presence === undefined || dock === undefined) return undefined;
  if (dock.portId !== travel.portId) return undefined;
  const geometry = deckGeometry(ctx.caches, presence.deckId);
  const rampId = personnelRamp(ctx, presence.deckId, geometry);
  if (rampId === undefined) return undefined;
  const foot =
    personnelRampFoot(ctx.content, presence.deckId, dock) ?? rampLanding(geometry, rampId);
  const gatePost = dockPost(dock, "gate");
  return {
    portId: travel.portId,
    dock,
    geometry,
    foot,
    top: rampTop(geometry, rampId),
    gate: gatePost === undefined ? undefined : postTile(dock, gatePost),
  };
}

/** A gate visit: out for `travel.gateVisitSeconds`, back to the gate tile. */
function throughGate(ctx: StepCtx, shore: Shore, gate: TileCoord): ActivityStep {
  return {
    kind: "throughGate",
    portId: shore.portId,
    gate: { x: gate.x, y: gate.y },
    ticksDone: 0,
    ticksNeeded: configTicks(ctx.config, ctx.config.travel.gateVisitSeconds),
  };
}

/**
 * Where a look round the dock goes: in front of one of its posts (not the gate, which a look
 * round may step through anyway), picked by a keyed draw so the plan is the same however often
 * it is built.
 */
function lookRoundTile(ctx: StepCtx, actor: Actor, shore: Shore): TileCoord | undefined {
  const posts = shore.dock.posts.filter((p) => p.kind !== "gate");
  if (posts.length === 0) return undefined;
  const draw = ctx.rng.keyedFloat("social", `lookRound:${actor.id}:${shore.portId}`, ctx.tick);
  const post = posts[Math.min(posts.length - 1, Math.floor(draw * posts.length))];
  return post === undefined ? undefined : postServiceTile(shore.dock, post);
}

/** D70 `lookForWork`: ashore, wait for the narrator's word, then a look round and back aboard. */
export function lookForWorkPlan(ctx: StepCtx, actor: Actor): ShorePlan {
  const shore = shoreHere(ctx);
  if (shore === undefined) return blocked("rampClosed");
  const steps: ActivityStep[] = [move(shore.foot), { kind: "awaitWord", portId: shore.portId }];
  const tile = lookRoundTile(ctx, actor, shore);
  if (tile !== undefined) steps.push(move(tile));
  const gate = shore.gate;
  const outThroughGate =
    gate !== undefined &&
    ctx.rng.keyedFloat("social", `lookRoundGate:${actor.id}:${shore.portId}`, ctx.tick) < 0.5;
  if (outThroughGate) steps.push(move(gate), throughGate(ctx, shore, gate));
  steps.push(move(shore.top));
  return planOf(steps);
}

/** A walkable dock tile beside `tile` (4-neighbours), else `tile` itself. */
function besideTile(geometry: DeckGeometry, tile: TileCoord): TileCoord {
  const around = [
    { x: tile.x, y: tile.y - 1 },
    { x: tile.x + 1, y: tile.y },
    { x: tile.x - 1, y: tile.y },
    { x: tile.x, y: tile.y + 1 },
  ];
  return (
    around.find((t) => isDockTile(geometry, t.x, t.y) && isWalkable(geometry, t.x, t.y)) ?? tile
  );
}

/**
 * D70 `meetSpeaker`: the steps that deliver held card `decisionId`, then back aboard. Blocked when
 * the card is no longer held, or neither the speaker is on the dock nor a gate leads to them.
 */
export function meetingPlan(ctx: StepCtx, decisionId: DecisionId | undefined): ShorePlan {
  const held = decisionId === undefined ? undefined : heldCard(ctx.state, decisionId);
  const shore = shoreHere(ctx);
  if (held === undefined || decisionId === undefined) return blocked("dependencyPending");
  if (shore === undefined || shore.portId !== held.portId) return blocked("rampClosed");
  const local = localNamed(ctx.state, held.speaker);
  if (local !== undefined) {
    const at = { x: Math.floor(local.location.x), y: Math.floor(local.location.y) };
    return planOf([
      move(besideTile(shore.geometry, at)),
      {
        kind: "talk",
        decisionId,
        withName: local.name,
        localId: local.id,
        ticksDone: 0,
        ticksNeeded: configTicks(ctx.config, ctx.config.travel.talkSeconds),
      },
      { kind: "deliverCard", decisionId, withName: local.name },
      move(shore.top),
    ]);
  }
  if (shore.gate === undefined) return blocked("unreachableTarget");
  return planOf([
    move(shore.gate),
    throughGate(ctx, shore, shore.gate),
    { kind: "deliverCard", decisionId, withName: held.speaker },
    move(shore.top),
  ]);
}

/** The held card this activity is on its way to deliver (a `deliverCard` still ahead), if any. */
export function meetingAhead(actor: Pick<Actor, "activity">): DecisionId | undefined {
  const activity = actor.activity;
  if (activity.kind === "idle" || activity.plan === undefined) return undefined;
  const plan = activity.plan;
  for (let i = plan.stepIndex; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (step?.kind === "deliverCard") return step.decisionId;
  }
  return undefined;
}
