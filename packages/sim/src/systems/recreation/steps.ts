/**
 * The `recreate` step (slice 4, call 4). On its first tick a `host` opens a session where it
 * stands (or joins one already open for the activity there; one there that is full or running
 * too long fails `occupiedPosition`), a `join` joins `sessionId` (full, gone, or running past
 * `recreation.lateJoinSeconds`: fail `occupiedPosition`, which backs off), a `solo` starts
 * counting. Waiting while the session is open; counting while solo or started; done when the
 * session is gone after starting, or at `ticksNeeded` solo. A collapse to solo is the recreation
 * system's rewrite of the step (`role: "solo"`, no `sessionId`, the def's `solo.durationDays`,
 * or `ticksNeeded` 0 when the host gives up). The step's labels are `labels.ts`
 * `recreateLabel`'s.
 *
 * A solo play of an activity that is itself (not a group game's `solo` variant: reading, the
 * harmonica, baking) resolves its outcome when it completes, through the same
 * `resolveOutcome(ctx, session, def)` a session uses, with a one-person session that is never
 * stored: the harmonica is a performance for the room (its one `sessionEnded`, D84 tuning), the
 * bake a tray of treats. A completed
 * step leaves its session itself (`finishActivity` does not call `abortActivity`).
 *
 * Owner: W1 of ship life slice 4.
 */
import { allocateId } from "../../core/ids";
import type { Actor } from "../../core/types/actor";
import type { ActivityDef } from "../../core/types/content";
import type { SessionId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { GroupSession } from "../../core/types/state";
import { resolveOutcome } from "../social/outcomes";
import { emitSim } from "../work/events";
import type { StepResult } from "../work/steps";
import { type RecreateStep, playsVariant } from "./common";
import { joinSession, joinable, leaveSession, openSession, sessionAtVenue } from "./sessions";
import { venueAt, venueTakenByAnother } from "./venues";

const OCCUPIED: StepResult = { fail: "occupiedPosition" };

/**
 * A solo play's outcome, through a one-person session that is never stored. A performance (the
 * harmonica) is for the room, so it ends with a `sessionEnded` line ("Bettina Solheim played the
 * harmonica in the lounge", D84 tuning); the session's id is allocated for that event like any
 * other (it names a real, if unstored, one-person session), and only then, so other solo plays
 * use none.
 */
function resolveSolo(ctx: StepCtx, actor: Actor, step: RecreateStep, def: ActivityDef): void {
  const venue = venueAt(ctx, actor, def);
  if (venue === undefined) return;
  const perform = def.outcome === "perform";
  const startedTick = ctx.tick - step.ticksDone;
  const session: GroupSession = {
    id: perform ? allocateId(ctx.state, "session") : (`solo:${actor.id}` as SessionId),
    activityId: def.id,
    venue,
    hostId: actor.id,
    members: [actor.id],
    openedTick: startedTick,
    startedTick,
    endsAtTick: ctx.tick,
  };
  resolveOutcome(ctx, session, def);
  if (!perform) return;
  emitSim(ctx, "sessionEnded", [actor.id], {
    sessionId: session.id,
    activityId: def.id,
    outcome: "perform",
    memberIds: [actor.id],
  });
}

function runSolo(ctx: StepCtx, actor: Actor, step: RecreateStep, def: ActivityDef): StepResult {
  if (step.ticksDone >= step.ticksNeeded) return "done";
  step.ticksDone += 1;
  if (step.ticksDone < step.ticksNeeded) return "wait";
  resolveSolo(ctx, actor, step, def);
  return "done";
}

/** The host's first tick: open (or join) the session where they stand. */
function openHere(ctx: StepCtx, actor: Actor, step: RecreateStep, def: ActivityDef): StepResult {
  const venue = venueAt(ctx, actor, def);
  if (venue === undefined) return { fail: "unreachableTarget" };
  const there = sessionAtVenue(ctx, def, venue);
  if (there !== undefined && !there.members.includes(actor.id) && !joinable(ctx, there)) {
    return OCCUPIED;
  }
  // Hosts who planned before either arrived: the first game at a table or mat keeps it, and
  // there is one game of a kind at a time (the fifth of five does not start a second table).
  if (there === undefined && venueTakenByAnother(ctx, def, venue)) return OCCUPIED;
  const elsewhere = Object.values(ctx.state.social.sessions).some((s) => s.activityId === def.id);
  if (there === undefined && elsewhere) return OCCUPIED;
  step.sessionId = openSession(ctx, actor, def, venue);
  return "wait";
}

export function runRecreate(ctx: StepCtx, actor: Actor, step: RecreateStep): StepResult {
  const result = advance(ctx, actor, step);
  // A step that ends on its own is not an abort: it leaves whatever session still lists it.
  if (result === "done") {
    for (const session of Object.values(ctx.state.social.sessions)) {
      if (session.members.includes(actor.id)) leaveSession(ctx, actor, session.id);
    }
  }
  return result;
}

function advance(ctx: StepCtx, actor: Actor, step: RecreateStep): StepResult {
  const def = ctx.content.activities[step.activityId];
  if (def === undefined) return { fail: "unreachableTarget" };
  if (step.role === "solo") return runSolo(ctx, actor, step, def);
  if (step.sessionId === undefined) {
    // A join always names its session; a host names it once opened.
    return step.role === "host" ? openHere(ctx, actor, step, def) : OCCUPIED;
  }
  const session = ctx.state.social.sessions[step.sessionId];
  // Gone: it ended (they played, so the step is done) or collapsed before they had a game.
  if (session === undefined) return step.ticksDone > 0 ? "done" : OCCUPIED;
  if (!session.members.includes(actor.id)) {
    if (step.ticksDone > 0) return "done";
    if (!joinSession(ctx, actor, session.id)) return OCCUPIED;
  }
  if (session.startedTick === undefined) return "wait";
  step.ticksDone += 1;
  return "wait";
}
