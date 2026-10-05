/**
 * Slice 4 (call 17): a tap on a games table, a vid screen or a workbench shows the session held
 * there in the machine inspector, "cards: Jax, Tomas, Dane, 40 s in". Pure words over the
 * snapshot the machine inspector already fetches.
 */
import type { ActivityDef, ActivityDefId, MachineId, WorldState } from "@crew/sim";
import { activityShortLabel, firstName } from "../render/sessions";

/**
 * The "Gathering" line for a machine: the session whose venue it is, its players' first names,
 * and how long it has run ("cards: Jax, Tomas, Dane, 40 s in") or, while it gathers, how long the
 * host has waited ("waiting for a game of cards: Jax, 12 s waiting"). `undefined` when no
 * session is held at the machine. A session on a deck has one venue, so one machine holds at most
 * one; should two ever name it, the first opened is shown.
 */
export function gatheringLine(
  state: Pick<WorldState, "tick" | "social" | "actors">,
  machineId: MachineId,
  activities: Readonly<Record<ActivityDefId, Pick<ActivityDef, "label" | "waitingLabel">>>,
  tickRate: number,
): string | undefined {
  const session = Object.values(state.social.sessions)
    .filter((s) => "machineId" in s.venue && s.venue.machineId === machineId)
    .sort((a, b) => a.openedTick - b.openedTick)[0];
  if (session === undefined) return undefined;
  const def = activities[session.activityId];
  if (def === undefined) {
    throw new Error(`gatheringLine: session ${session.id} names unknown ${session.activityId}`);
  }
  const names = session.members.flatMap((id) => {
    const actor = state.actors[id];
    return actor === undefined ? [] : [firstName(actor.name)];
  });
  const who = names.length === 0 ? "" : `: ${names.join(", ")}`;
  if (session.startedTick === undefined) {
    return `${def.waitingLabel}${who}, ${since(state.tick, session.openedTick, tickRate)} waiting`;
  }
  return `${activityShortLabel(def.label)}${who}, ${since(state.tick, session.startedTick, tickRate)} in`;
}

/** Sim time from `from` to `tick` as the player reads it: "40 s" under a minute, else "5 min". */
function since(tick: number, from: number, tickRate: number): string {
  const seconds = Math.max(0, Math.floor((tick - from) / tickRate));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min`;
}
