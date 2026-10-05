/**
 * The recreation system (slice 4, call 4), phase `needs`, every tick, registered after the needs
 * and mood systems. The lifecycle of a group session: it starts at `participants.max` members or
 * at `openedTick + gatherSeconds` with at least `min` (`sessionStarted`, `endsAtTick` from
 * `durationDays`, a debate's or a vid's topic picked from `def.topics` on the `social` stream); collapses at `gatherSeconds`
 * with fewer (`sessionCollapsed`: the host's step becomes `solo` with the def's `solo` variant,
 * or ends at once when there is none, and the host backs off `recreate:<activityId>` for
 * `collapseBackoffDays`; the row is deleted, so any other member's step fails); and resolves at
 * `endsAtTick` (`resolveOutcome` from `systems/social/outcomes.ts`, called exactly once, then the
 * row is deleted; `sessionEnded`). A contest or debate that falls under `min` mid-game ends
 * `abandoned` where the member leaves (`sessions.ts` `leaveSession`).
 *
 * `resolveOutcome` returns what the `sessionEnded` line says: the winner, the topic and whether a
 * debate was an argument.
 *
 * Owner: W1 of ship life slice 4.
 */
import { configTicks, dayTicks } from "../../core/clock";
import type { Actor } from "../../core/types/actor";
import type { ActivityDef } from "../../core/types/content";
import type { StepCtx, System } from "../../core/types/pipeline";
import type { GroupSession } from "../../core/types/state";
import { resolveOutcome } from "../social/outcomes";
import { backoffRef } from "../work/activity";
import { emitSim } from "../work/events";
import { recreateStepOf, soloTicks } from "./common";

/** Back the host off hosting `def` for `collapseBackoffDays`. */
function backOffHosting(ctx: StepCtx, host: Actor, def: ActivityDef): void {
  const ref = backoffRef.personal("recreate", def.id);
  const until = ctx.tick + dayTicks(ctx.config, ctx.config.recreation.collapseBackoffDays);
  host.workBackoff = { ...(host.workBackoff ?? {}), [ref]: until };
}

function deleteRow(ctx: StepCtx, session: GroupSession): void {
  delete ctx.state.social.sessions[session.id];
}

function start(ctx: StepCtx, session: GroupSession, def: ActivityDef): void {
  session.startedTick = ctx.tick;
  session.endsAtTick = ctx.tick + Math.max(1, dayTicks(ctx.config, def.durationDays));
  const topics = def.topics ?? [];
  if (topics.length > 0) {
    session.topicId = ctx.rng.pick("social", topics);
  }
  emitSim(ctx, "sessionStarted", [...session.members], {
    sessionId: session.id,
    activityId: def.id,
    memberIds: [...session.members],
    compartmentId: session.venue.compartmentId,
  });
}

/** Nobody (or too few) came: the host plays the `solo` variant, or gives up. */
function collapse(ctx: StepCtx, session: GroupSession, def: ActivityDef): void {
  deleteRow(ctx, session);
  const toSolo = def.solo !== undefined;
  emitSim(ctx, "sessionCollapsed", [session.hostId], {
    sessionId: session.id,
    activityId: def.id,
    toSolo,
  });
  const host = ctx.state.actors[session.hostId];
  if (host === undefined) return;
  backOffHosting(ctx, host, def);
  const step = recreateStepOf(host);
  if (step === undefined || step.sessionId !== session.id) return;
  step.role = "solo";
  // biome-ignore lint/performance/noDelete: state must omit the key (CONTRACTS rule 2).
  delete step.sessionId;
  step.ticksDone = 0;
  // Without a solo variant the host gives up: the step ends on its next tick, restoring nothing.
  step.ticksNeeded = toSolo ? soloTicks(ctx.config, def, "solo") : 0;
}

/** Resolve and end the session (see the module comment). */
function resolve(ctx: StepCtx, session: GroupSession, def: ActivityDef): void {
  const summary = resolveOutcome(ctx, session, def);
  deleteRow(ctx, session);
  const topicId = summary.topicId ?? session.topicId;
  emitSim(ctx, "sessionEnded", [...session.members], {
    sessionId: session.id,
    activityId: def.id,
    outcome: def.outcome,
    memberIds: [...session.members],
    ...(summary.winnerId === undefined ? {} : { winnerId: summary.winnerId }),
    ...(topicId === undefined ? {} : { topicId }),
    ...(summary.argued === undefined ? {} : { argued: summary.argued }),
  });
}

function advanceSession(ctx: StepCtx, session: GroupSession): void {
  const def = ctx.content.activities[session.activityId];
  if (def === undefined) {
    throw new Error(`recreation: session ${session.id} names unknown ${session.activityId}`);
  }
  if (session.startedTick === undefined) {
    const members = session.members.length;
    const gathered =
      ctx.tick >= session.openedTick + configTicks(ctx.config, ctx.config.recreation.gatherSeconds);
    if (members >= def.participants.max) start(ctx, session, def);
    else if (gathered && members >= def.participants.min) start(ctx, session, def);
    else if (gathered) collapse(ctx, session, def);
    return;
  }
  if (session.endsAtTick !== undefined && ctx.tick >= session.endsAtTick) {
    resolve(ctx, session, def);
  }
}

export const recreationSystem: System = {
  name: "recreation",
  phase: "needs",
  run(ctx) {
    const sessions = Object.values(ctx.state.social.sessions).sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    for (const session of sessions) advanceSession(ctx, session);
  },
};
