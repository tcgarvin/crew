/**
 * Group sessions (slice 4, call 4): opening, joining and leaving the row in `social.sessions`.
 *
 * - `openSession`: allocates `nextId.session`; a session already open for the activity at the
 *   venue is joined instead (four hosts walking to one table make one game); `sessionOpened`.
 * - `joinSession`: room left, and not running past `recreation.lateJoinSeconds`; `sessionJoined`.
 * - `leaveRecreation` (called from `abortActivity` before the activity is cleared, so a bell, a
 *   meal call or an essential task takes the member out the tick they leave): removes them from
 *   `members` (`sessionLeft`); sets a carried `book` or `instrument` down where they stand (and
 *   `seeItem`); a contest or debate left under `min`, or any started session left empty, ends
 *   `abandoned`; an open one left empty collapses. A host who leaves hands the row to the next
 *   member. A completed `recreate` step leaves its session itself (`leaveSession`), since
 *   `finishActivity` does not call `abortActivity`.
 *
 * Owner: W1 of ship life slice 4.
 */
import { configTicks } from "../../core/clock";
import { allocateId } from "../../core/ids";
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly } from "../../core/types/common";
import type { ActivityDef } from "../../core/types/content";
import type { SessionId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { GroupSession, SessionVenue } from "../../core/types/state";
import { emitSim } from "../work/events";
import { seeItem } from "../work/facts";
import { carriedItems } from "../work/plans";
import { touchInventory } from "../work/steps";
import { recreateStepOf } from "./common";
import { sameVenue } from "./venues";

/** Can `session` take one more now: room left, and not running past `lateJoinSeconds`? */
export function joinable(
  ctx: Pick<StepCtx, "config" | "tick" | "content">,
  session: DeepReadonly<GroupSession>,
): boolean {
  const def = ctx.content.activities[session.activityId];
  if (def === undefined || session.members.length >= def.participants.max) return false;
  if (session.startedTick === undefined) return true;
  const late = configTicks(ctx.config, ctx.config.recreation.lateJoinSeconds);
  return ctx.tick - session.startedTick <= late;
}

/** The session of `def` at `venue`, open or running, if there is one. */
export function sessionAtVenue(
  ctx: Pick<StepCtx, "state">,
  def: DeepReadonly<ActivityDef>,
  venue: DeepReadonly<SessionVenue>,
): GroupSession | undefined {
  return Object.values(ctx.state.social.sessions).find(
    (s) => s.activityId === def.id && sameVenue(s.venue, venue),
  );
}

/** Open a session of `def` at `venue` hosted by `actor` (or join the one open there). */
export function openSession(
  ctx: StepCtx,
  actor: Actor,
  def: ActivityDef,
  venue: SessionVenue,
): SessionId {
  const there = sessionAtVenue(ctx, def, venue);
  if (there !== undefined && joinable(ctx, there) && joinSession(ctx, actor, there.id)) {
    return there.id;
  }
  const id = allocateId(ctx.state, "session");
  ctx.state.social.sessions[id] = {
    id,
    activityId: def.id,
    venue: { ...venue },
    hostId: actor.id,
    members: [actor.id],
    openedTick: ctx.tick,
  };
  emitSim(ctx, "sessionOpened", [actor.id], {
    sessionId: id,
    activityId: def.id,
    hostId: actor.id,
  });
  return id;
}

/** Join `sessionId`: true when joined (or already in), false when full, gone or too late. */
export function joinSession(ctx: StepCtx, actor: Actor, sessionId: SessionId): boolean {
  const session = ctx.state.social.sessions[sessionId];
  if (session === undefined) return false;
  if (session.members.includes(actor.id)) return true;
  if (!joinable(ctx, session)) return false;
  session.members.push(actor.id);
  emitSim(ctx, "sessionJoined", [actor.id], { sessionId, actorId: actor.id });
  return true;
}

/** Delete the row, saying it ended `abandoned` (started) or collapsed (still gathering). */
export function dropSession(
  ctx: StepCtx,
  session: GroupSession,
  memberIds: readonly Actor["id"][],
) {
  delete ctx.state.social.sessions[session.id];
  if (session.startedTick === undefined) {
    emitSim(ctx, "sessionCollapsed", [session.hostId], {
      sessionId: session.id,
      activityId: session.activityId,
      toSolo: false,
    });
    return;
  }
  emitSim(ctx, "sessionEnded", [...memberIds], {
    sessionId: session.id,
    activityId: session.activityId,
    outcome: "abandoned",
    memberIds: [...memberIds],
  });
}

/**
 * Take `actor` out of `sessionId`'s members (`sessionLeft`). A contest or debate left under its
 * `min`, or any session left empty, ends then and there (see the module comment).
 */
export function leaveSession(ctx: StepCtx, actor: Actor, sessionId: SessionId): void {
  const session = ctx.state.social.sessions[sessionId];
  if (session === undefined || !session.members.includes(actor.id)) return;
  session.members = session.members.filter((id) => id !== actor.id);
  emitSim(ctx, "sessionLeft", [actor.id], { sessionId, actorId: actor.id });
  const [next] = session.members;
  if (next === undefined) {
    dropSession(ctx, session, [actor.id]);
    return;
  }
  if (session.hostId === actor.id) session.hostId = next;
  const def = ctx.content.activities[session.activityId];
  const contested = def?.outcome === "contest" || def?.outcome === "debate";
  if (session.startedTick !== undefined && contested && def !== undefined) {
    if (session.members.length < def.participants.min) {
      dropSession(ctx, session, [...session.members]);
    }
  }
}

/** Set down a carried `book` or `instrument` where the actor stands; the crew's beliefs follow. */
function setDownGear(ctx: StepCtx, actor: Actor): void {
  const location = actor.location;
  if (location.kind !== "onDeck") return;
  let dropped = false;
  for (const item of carriedItems(ctx, actor.id)) {
    const tags = ctx.content.items[item.defId]?.tags ?? [];
    if (!tags.includes("book") && !tags.includes("instrument")) continue;
    item.location = {
      kind: "onDeck",
      deckId: location.deckId,
      x: Math.floor(location.x) + 0.5,
      y: Math.floor(location.y) + 0.5,
    };
    seeItem(actor, item.id, item.location, ctx.tick);
    dropped = true;
  }
  if (dropped) touchInventory(ctx);
}

/** Take `actor` out of any session and set down what they carried for it. */
export function leaveRecreation(ctx: StepCtx, actor: Actor): void {
  const activity = actor.activity;
  if (activity.kind !== "personal" || activity.activity !== "recreate") return;
  const step = recreateStepOf(actor);
  if (step?.sessionId !== undefined) leaveSession(ctx, actor, step.sessionId);
  // Not only during the step: on the walk to the venue or home they carry it too.
  for (const session of Object.values(ctx.state.social.sessions)) {
    if (session.members.includes(actor.id)) leaveSession(ctx, actor, session.id);
  }
  setDownGear(ctx, actor);
}
