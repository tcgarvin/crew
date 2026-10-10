/**
 * §delivery: cards delivered in person (dockside §6.2, §6.3). While the ship is docked at a port
 * with a dock map, a card whose speaker is one of the port's people (an offer's issuer, a narrator
 * card's `speaker` who is neither crew nor a passenger) is not put in front of the captain at
 * once: it is held (`DecisionsState.held`), and comes up when the captain and the speaker meet.
 * Commerce runs the meetings (`systems/commerce/delivery.ts`); this module is the part the kernel's
 * own command handlers need (`surfaceDecision`, and `offerJob` through `surfaceOfferCard`).
 *
 * A held card is a decision record with status `pending` that is not in the queue: nothing halts
 * on it, and every reader of the queue keeps meaning "on screen now". It leaves `held` only here,
 * by `deliverHeldCard`: onto the queue, or dropped when it is an offer whose job closed first.
 *
 * Crew and passengers bring their cards as before (immediately), and so do observed scenes (no
 * speaker), kernel-raised policy cards (§policy-decision-cards: brought by crew), anything in
 * flight, and anything at a port without a dock map.
 */
import { dockAlongsideAt, dockPost } from "./docks";
import type { DeepReadonly, Tick } from "./types/common";
import type { Decision, HeldCard } from "./types/decisions";
import type { Local } from "./types/dockside";
import type { CardDeliveryReason } from "./types/events";
import type { DecisionId, PortDefId } from "./types/ids";
import type { ReadonlyWorldState, StepCtx } from "./types/pipeline";

type Ctx = Pick<StepCtx, "state" | "content" | "tick" | "emit">;

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Someone of the ship: crew or a passenger, wherever they are (aboard, on the dock, ashore). */
function isShipsPerson(state: Pick<ReadonlyWorldState, "actors">, name: string): boolean {
  return Object.values(state.actors).some((a) => sameName(a.name, name));
}

/** The local on the dock alongside with this name, if any. */
export function localNamed(
  state: Pick<ReadonlyWorldState, "dockside">,
  name: string,
): DeepReadonly<Local> | undefined {
  return Object.values(state.dockside.locals).find((l) => sameName(l.name, name));
}

/** The name a card gives its speaker: `params.speaker` (narrator cards), else an offer's issuer. */
export function cardSpeaker(
  state: Pick<ReadonlyWorldState, "jobs">,
  decision: Pick<Decision, "prompt" | "jobId">,
): string | undefined {
  const speaker = decision.prompt.params.speaker;
  if (typeof speaker === "string" && speaker.trim() !== "") return speaker.trim();
  const job = decision.jobId === undefined ? undefined : state.jobs[decision.jobId];
  return job?.issuerPerson.name;
}

/**
 * The port a card naming `speaker` would be held at right now, or undefined when it comes up at
 * once: docked at a port whose dock is alongside, the speaker named and not of the ship, and a
 * way for them to meet (they are on the dock, or it has a gate to the port beyond).
 */
function holdingPort(
  state: ReadonlyWorldState,
  content: Ctx["content"],
  speaker: string | undefined,
): PortDefId | undefined {
  if (speaker === undefined || speaker.trim() === "") return undefined;
  const travel = state.travel;
  if (travel.stage !== "docked") return undefined;
  const berth = dockAlongsideAt(content, state, travel.portId);
  if (berth === undefined) return undefined;
  if (isShipsPerson(state, speaker)) return undefined;
  const reachable =
    localNamed(state, speaker) !== undefined || dockPost(berth.dock, "gate") !== undefined;
  return reachable ? travel.portId : undefined;
}

/**
 * Put a freshly created pending decision in front of the captain: on the queue, or held
 * (§holding-a-card) for delivery in person when its speaker is one of the port's people.
 */
export function queueOrHold(ctx: Ctx, decisionId: DecisionId, speaker: string | undefined): void {
  const portId = holdingPort(ctx.state, ctx.content, speaker);
  if (portId === undefined || speaker === undefined) {
    ctx.state.decisions.queue.push(decisionId);
    return;
  }
  const held: HeldCard = { decisionId, speaker: speaker.trim(), portId, heldTick: ctx.tick };
  ctx.state.decisions.held.push(held);
  ctx.emit({
    type: "cardHeld",
    subjectIds: [decisionId],
    causeIds: [],
    source: "sim",
    locationRef: { kind: "port", portId },
    payload: { decisionId, speaker: held.speaker, portId },
  });
}

/**
 * The tick from which a card is on screen: when it was delivered, for a card held for delivery in
 * person, else when it was created. The client shows the card (and logs it) once playback reaches
 * this tick, so a card never comes up ahead of the meeting the viewer is still watching.
 */
export function decisionShownTick(decision: Pick<Decision, "createdTick" | "deliveredTick">): Tick {
  return decision.deliveredTick ?? decision.createdTick;
}

/** The held card for `decisionId`, if it is still held. */
export function heldCard(
  state: Pick<ReadonlyWorldState, "decisions">,
  decisionId: DecisionId,
): Readonly<HeldCard> | undefined {
  return state.decisions.held.find((h) => h.decisionId === decisionId);
}

/** Why a held card can no longer come up, or undefined when it still can. */
function staleReason(
  state: ReadonlyWorldState,
  decision: Decision | undefined,
): string | undefined {
  if (decision === undefined) return "missing";
  if (decision.status !== "pending") return `already ${decision.status}`;
  if (decision.jobId === undefined) return undefined;
  const job = state.jobs[decision.jobId];
  if (job === undefined) return "its job is gone";
  // Both sides of an offer card act on an open offer; one that closed first could never be
  // answered, and a card that cannot be answered would halt the world for good.
  return job.status === "offered" ? undefined : `the offer was ${job.status} before it was made`;
}

/**
 * Bring a held card up now: onto the decision queue (the world halts on it after this tick), or,
 * when it has gone stale (an offer that closed while the card waited), drop it with a
 * `decisionDropped` event. A no-op for a card that is not held.
 */
export function deliverHeldCard(
  ctx: Ctx,
  decisionId: DecisionId,
  reason: CardDeliveryReason,
): void {
  const decisions = ctx.state.decisions;
  const index = decisions.held.findIndex((h) => h.decisionId === decisionId);
  if (index < 0) return;
  decisions.held.splice(index, 1);
  const decision = decisions.records[decisionId];
  const stale = staleReason(ctx.state, decision);
  if (stale !== undefined) {
    if (decision !== undefined && decision.status === "pending") decision.status = "dropped";
    ctx.emit({
      type: "decisionDropped",
      subjectIds: [decisionId],
      causeIds: [],
      source: "sim",
      payload: { decisionId, reason: stale },
    });
    return;
  }
  decisions.queue.push(decisionId);
  if (decision !== undefined) decision.deliveredTick = ctx.tick;
  ctx.emit({
    type: "cardDelivered",
    subjectIds: [decisionId],
    causeIds: [],
    source: "sim",
    payload: { decisionId, reason },
  });
}
