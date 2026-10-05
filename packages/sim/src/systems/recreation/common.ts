/**
 * Small reads the recreation modules share: which def a step plays (the def itself, or its `solo`
 * variant after a collapse or at low mood), whether a step is counting, and the actor's
 * `recreate` step. The variant rule is the one `labels.ts` `recreateLabel` uses, so the label,
 * the duration and the restores always agree.
 *
 * Owner: W1 of ship life slice 4.
 */
import { dayTicks } from "../../core/clock";
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly, TileCoord } from "../../core/types/common";
import type { ActivityDef, ActivityRestores, ConfigDef } from "../../core/types/content";
import type { ReadonlyWorldState } from "../../core/types/pipeline";
import type { GroupSession } from "../../core/types/state";
import type { ActivityStep, RecreateRole } from "../../core/types/work";
import { currentStep } from "../work/activity";

export type RecreateStep = Extract<ActivityStep, { kind: "recreate" }>;

/** A group activity has room for more than one; it is played in a session unless played solo. */
export const isGroup = (def: DeepReadonly<ActivityDef>): boolean => def.participants.max >= 2;

/**
 * Does `role` play `def`'s `solo` variant (solitaire for cards)? Only a group activity that needs
 * company (`min` ≥ 2) and has one; a min-1 group activity played alone (vids) is itself.
 */
export function playsVariant(def: DeepReadonly<ActivityDef>, role: RecreateRole): boolean {
  return role === "solo" && def.participants.min >= 2 && def.solo !== undefined;
}

/** The restores and duration `role` plays `def` with. */
export function playedAs(
  def: DeepReadonly<ActivityDef>,
  role: RecreateRole,
): { readonly restores: DeepReadonly<ActivityRestores>; readonly durationDays: number } {
  if (playsVariant(def, role) && def.solo !== undefined) {
    return { restores: def.solo.restores, durationDays: def.solo.durationDays };
  }
  return { restores: def.restores, durationDays: def.durationDays };
}

/** Ticks a solo play of `def` as `role` lasts (at least one). */
export function soloTicks(
  config: ConfigDef,
  def: DeepReadonly<ActivityDef>,
  role: RecreateRole,
): number {
  return Math.max(1, dayTicks(config, playedAs(def, role).durationDays));
}

/** The actor's current step when it is a `recreate` step. */
export function recreateStepOf(actor: Actor): RecreateStep | undefined {
  const step = currentStep(actor.activity);
  return step?.kind === "recreate" ? (step as RecreateStep) : undefined;
}

/** The session `step` belongs to, if it names one that still exists. */
export function sessionOf(
  state: Pick<ReadonlyWorldState, "social">,
  step: DeepReadonly<RecreateStep>,
): DeepReadonly<GroupSession> | undefined {
  return step.sessionId === undefined ? undefined : state.social.sessions[step.sessionId];
}

/**
 * Is the step counting (and restoring): solo, or a member of a session that has started. Waiting
 * for others counts nothing.
 */
export function isPlaying(
  state: Pick<ReadonlyWorldState, "social">,
  actor: DeepReadonly<Pick<Actor, "id">>,
  step: DeepReadonly<RecreateStep>,
): boolean {
  if (step.role === "solo") return true;
  const session = sessionOf(state, step);
  return session?.startedTick !== undefined && session.members.includes(actor.id);
}

/** The tile an actor on deck stands on. */
export function standingTile(actor: DeepReadonly<Pick<Actor, "location">>): TileCoord | undefined {
  const location = actor.location;
  return location.kind === "onDeck"
    ? { x: Math.floor(location.x), y: Math.floor(location.y) }
    : undefined;
}
