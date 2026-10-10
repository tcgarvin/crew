/**
 * §looking-for-work: the captain ashore (dockside §6.2, §6.3), run once a tick by commerce after
 * its job sweep.
 *
 * **Looking for work.** Docked at a port with a dock map, with nothing on (`captainIsIdleAt`) and
 * the personnel ramp down, the command actor (D8) is handed `lookForWork` at essential-operation
 * urgency once they are idle or only passing the time ("they finish what they are doing"). The
 * walk goes down the personnel ramp, and `captainAshore` is raised the tick they stand on dock
 * floor (retried every tick while another hook is pending); `narrator.captainAshoreLastAsk`
 * records it, once per docking, and names who went. At a port without a dock map (hand-built test
 * content) there is nowhere to walk, so the ask is raised on the first idle docked tick, as
 * `jobBoard` was.
 *
 * **Delivery in person.** A held card (`core/delivery.ts`) is delivered one at a time, oldest
 * first. How is decided when its meeting starts, from where the walker is (the one who went ashore
 * this docking, else the command actor): on the dock, out through the gate, or on their way, and
 * they go to the speaker (`meetSpeaker`, `systems/work/shore.ts`); aboard, and the speaker comes
 * to the foot of the personnel ramp (a local already on the dock walks over; anyone else walks in
 * from the gate as a visitor), and the card comes up when they get there. Nothing waits forever:
 * a card held `travel.cardDeliveryGiveUpSeconds` comes up anyway, and one held at a port the ship
 * is no longer docked at comes up at once. An offer whose job closed first is dropped instead.
 */
import { configTicks } from "../../core/clock";
import { commandActor, isFitForCommand } from "../../core/command-actor";
import { deliverHeldCard, localNamed } from "../../core/delivery";
import { type BerthedDock, dockAlongsideAt, dockPost, isOnDock, postTile } from "../../core/docks";
import { raiseHookIfIdle } from "../../core/hooks";
import { postFacing, spawnLocal, waitingSpotByRamp } from "../../core/locals";
import type { Actor } from "../../core/types/actor";
import type { TileCoord } from "../../core/types/common";
import type { HeldCard } from "../../core/types/decisions";
import type { Local } from "../../core/types/dockside";
import type { CardDeliveryReason } from "../../core/types/events";
import type { DecisionId, PortDefId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import { URGENCY_CLASSES, type UrgencyClass } from "../../core/types/work";
import { captainIsIdleAt } from "../travel/hooks";
import { sendLocalAway, sendLocalTo, settleLocal, standingOn } from "../travel/locals";
import { backoffRef, isBackingOff, isOutThroughGate } from "../work/activity";
import { abortActivity } from "../work/execute";
import { meetingAhead } from "../work/shore";

type Ctx = StepCtx;

const urgencyIndex = (u: UrgencyClass) => URGENCY_CLASSES.indexOf(u);

const LOOK_FOR_WORK_REF = backoffRef.personal("lookForWork");
const MEET_SPEAKER_REF = backoffRef.personal("meetSpeaker");

function onShoreActivity(actor: Pick<Actor, "activity">, kind: "lookForWork" | "meetSpeaker") {
  return actor.activity.kind === "personal" && actor.activity.activity === kind;
}

// ---------------------------------------------------------------------------------------------
// Looking for work
// ---------------------------------------------------------------------------------------------

/** The personnel ramp is down and passable (fully open, and travel still wants it open). */
function personnelRampDown(ctx: Ctx): boolean {
  const deckId = ctx.state.deck.dock?.deckId;
  const key =
    deckId === undefined ? undefined : ctx.content.decks[deckId]?.docking.personnelRampDoorKey;
  const ramps = Object.values(ctx.state.doors).filter((d) => d.kind === "ramp");
  const ramp = ramps.find((d) => d.placementKey === key) ?? ramps[0];
  return ramp !== undefined && ramp.physicalState === "open" && ramp.requestedState === "open";
}

/** "They finish what they are doing": idle, or only passing the time. */
function freeToGoAshore(actor: Actor): boolean {
  if (actor.availability !== "available" || actor.disembarking === true) return false;
  const activity = actor.activity;
  return activity.kind === "idle" || activity.urgency === "voluntaryActivity";
}

/** Raise this docking's ask for `actor`, and say in the log that they are looking for work. */
function raiseAsk(ctx: Ctx, portId: PortDefId, actor: Actor, ashore: boolean): void {
  if (!raiseHookIfIdle(ctx, "captainAshore", { portId, actorId: actor.id })) return;
  ctx.state.narrator.captainAshoreLastAsk = { portId, tick: ctx.tick, actorId: actor.id };
  if (!ashore) return;
  ctx.emit({
    type: "lookingForWork",
    subjectIds: [actor.id],
    causeIds: [],
    source: "sim",
    locationRef: { kind: "port", portId },
    payload: { actorId: actor.id, name: actor.name, portId },
  });
}

/** Once a tick: hand out `lookForWork`, and raise `captainAshore` when they step onto the dock. */
function sweepLookingForWork(ctx: Ctx): void {
  const travel = ctx.state.travel;
  if (travel.stage !== "docked") {
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete ctx.state.narrator.captainAshoreLastAsk;
    return;
  }
  const portId = travel.portId;
  if (ctx.state.narrator.captainAshoreLastAsk?.portId === portId) return;
  const looking = Object.values(ctx.state.actors).find((a) => onShoreActivity(a, "lookForWork"));
  if (looking !== undefined) {
    // Something came up on the way down (an offer, a course): the walk has no point now. The ask
    // is not spent, so a later idle spell this docking sends them again.
    if (!captainIsIdleAt(ctx, portId)) abortActivity(ctx, looking, "cancelled");
    else if (isOnDock(ctx.content, ctx.state, looking.location)) {
      raiseAsk(ctx, portId, looking, true);
    }
    return;
  }
  if (!captainIsIdleAt(ctx, portId)) return;
  const walker = ctx.state.actors[commandActor(ctx.state)];
  if (walker === undefined) return;
  if (dockAlongsideAt(ctx.content, ctx.state, portId) === undefined) {
    // A port without a dock map: nowhere to walk, so the narrator is asked at once (D40 as was).
    raiseAsk(ctx, portId, walker, false);
    return;
  }
  if (!personnelRampDown(ctx) || !freeToGoAshore(walker)) return;
  if (isBackingOff(walker.workBackoff, LOOK_FOR_WORK_REF, ctx.tick)) return;
  // Handed out every tick until it starts: the planner may overwrite a pending intent on its tick.
  walker.pendingIntent = {
    kind: "personal",
    activity: "lookForWork",
    urgency: "essentialOperation",
    trace: { candidates: 0, chosenReason: "ashore to look for work", rejected: [] },
  };
}

// ---------------------------------------------------------------------------------------------
// Delivery in person
// ---------------------------------------------------------------------------------------------

/** Who meets the people the narrator names: whoever went ashore this docking, else D8's choice. */
function walkerFor(ctx: Ctx, portId: PortDefId): Actor | undefined {
  const ask = ctx.state.narrator.captainAshoreLastAsk;
  const pinned = ask?.portId === portId ? ctx.state.actors[ask.actorId] : undefined;
  if (pinned !== undefined && isFitForCommand(pinned)) return pinned;
  return ctx.state.actors[commandActor(ctx.state)];
}

/** On the dock, out through the gate, or on the way to either for work or a meeting. */
function isAshore(ctx: Ctx, actor: Actor): boolean {
  return (
    isOnDock(ctx.content, ctx.state, actor.location) ||
    isOutThroughGate(actor) ||
    onShoreActivity(actor, "lookForWork") ||
    onShoreActivity(actor, "meetSpeaker")
  );
}

/** Some actor is on the way to deliver this card (a `deliverCard` for it is still ahead). */
function meetingUnderWay(ctx: Ctx, decisionId: DecisionId): boolean {
  return Object.values(ctx.state.actors).some((a) => meetingAhead(a) === decisionId);
}

/**
 * Can `actor` be sent to a meeting now? Anything below essential operation gives way (someone is
 * waiting with word), as does the walk ashore itself or a meeting already done; a need or an
 * emergency at essential or above does not, and neither does the call aboard or an errand through
 * the gate.
 */
function freeForMeeting(ctx: Ctx, actor: Actor): boolean {
  if (actor.availability !== "available" || actor.disembarking === true) return false;
  if (isBackingOff(actor.workBackoff, MEET_SPEAKER_REF, ctx.tick)) return false;
  const activity = actor.activity;
  if (activity.kind === "idle") return true;
  if (onShoreActivity(actor, "lookForWork") || onShoreActivity(actor, "meetSpeaker")) {
    return meetingAhead(actor) === undefined;
  }
  return urgencyIndex(activity.urgency) > urgencyIndex("essentialOperation");
}

/** A speaker who came over is done: a visitor goes back out, anyone else back to their post. */
function releaseSpeaker(ctx: Ctx, held: HeldCard, berth: BerthedDock | undefined): void {
  const delivery = held.delivery;
  if (delivery?.via !== "speaker") return;
  const local = ctx.state.dockside.locals[delivery.localId];
  if (local === undefined) return;
  // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
  delete local.label;
  const post = berth?.dock.posts.find((p) => p.key === local.postKey);
  const postAt = berth === undefined || post === undefined ? undefined : postTile(berth, post);
  if (local.origin.kind === "visitor") {
    if (postAt !== undefined) sendLocalAway(ctx, local, postAt);
    else delete ctx.state.dockside.locals[local.id];
    return;
  }
  if (postAt === undefined || !sendLocalTo(ctx, local, postAt)) {
    settleLocal(ctx, local);
  }
}

function finish(ctx: Ctx, held: HeldCard, reason: CardDeliveryReason, berth?: BerthedDock): void {
  releaseSpeaker(ctx, held, berth);
  deliverHeldCard(ctx, held.decisionId, reason);
}

/** The role a visitor gets: an offer's issuer's, else "visitor". */
function visitorRole(ctx: Ctx, held: HeldCard): string {
  const jobId = ctx.state.decisions.records[held.decisionId]?.jobId;
  const job = jobId === undefined ? undefined : ctx.state.jobs[jobId];
  return job?.issuerPerson.role.toLowerCase() ?? "visitor";
}

/** The speaker who will walk to the ramp: the local with their name, or a visitor at the gate. */
function speakerToWalk(ctx: Ctx, held: HeldCard, berth: BerthedDock): Local | undefined {
  const named = localNamed(ctx.state, held.speaker);
  if (named !== undefined) {
    // A dock hand carting freight finishes that first; the give-up clock covers a long errand.
    return named.errand === undefined ? ctx.state.dockside.locals[named.id] : undefined;
  }
  const gate = dockPost(berth.dock, "gate");
  const presence = ctx.state.deck.dock;
  if (gate === undefined || presence === undefined) return undefined;
  const shuffle = configTicks(ctx.config, ctx.config.travel.localShuffleSeconds);
  return spawnLocal(
    ctx.state,
    presence.deckId,
    {
      name: held.speaker,
      role: visitorRole(ctx, held),
      origin: { kind: "visitor" },
      postKey: gate.key,
    },
    postTile(berth, gate),
    postFacing(gate),
    ctx.tick,
    shuffle,
  );
}

/** Start the speaker's walk to the foot of the ramp. False when there is no way to. */
function sendSpeaker(ctx: Ctx, held: HeldCard, berth: BerthedDock): boolean {
  const presence = ctx.state.deck.dock;
  if (presence === undefined) return false;
  const spot = waitingSpotByRamp(ctx.state, ctx.content, presence.deckId, berth);
  const local = spot === undefined ? undefined : speakerToWalk(ctx, held, berth);
  if (spot === undefined || local === undefined) return false;
  const fromGate = local.origin.kind === "visitor";
  if (!sendLocalTo(ctx, local, spot)) {
    if (fromGate) delete ctx.state.dockside.locals[local.id];
    return false;
  }
  local.label = "coming over to the ship";
  held.delivery = { via: "speaker", sinceTick: ctx.tick, localId: local.id, tile: spot };
  ctx.emit({
    type: "cameToSee",
    subjectIds: [local.id],
    causeIds: [],
    source: "sim",
    locationRef: { kind: "port", portId: held.portId },
    payload: { localId: local.id, name: local.name, fromGate },
  });
  return true;
}

const within = (local: Local, tile: TileCoord, reach: number) =>
  Math.abs(local.location.x - (tile.x + 0.5)) <= reach &&
  Math.abs(local.location.y - (tile.y + 0.5)) <= reach;

/** One tick of the oldest held card's meeting. */
function advanceMeeting(ctx: Ctx, held: HeldCard, berth: BerthedDock): void {
  if (held.delivery === undefined) {
    const walker = walkerFor(ctx, held.portId);
    if (meetingUnderWay(ctx, held.decisionId) || (walker !== undefined && isAshore(ctx, walker))) {
      held.delivery = { via: "captain", sinceTick: ctx.tick };
    } else if (!sendSpeaker(ctx, held, berth)) {
      finish(ctx, held, "noWayToMeet", berth);
      return;
    }
  }
  const delivery = held.delivery;
  if (delivery === undefined) return;
  if (delivery.via === "captain") {
    if (meetingUnderWay(ctx, held.decisionId)) return;
    const walker = walkerFor(ctx, held.portId);
    if (walker === undefined || !freeForMeeting(ctx, walker)) return;
    // Handed out every tick until it starts, as `comeAboard` is (§calling-the-crew-aboard).
    walker.pendingIntent = {
      kind: "personal",
      activity: "meetSpeaker",
      decisionId: held.decisionId,
      urgency: "essentialOperation",
      trace: { candidates: 0, chosenReason: `to see ${held.speaker}`, rejected: [] },
    };
    return;
  }
  const local = ctx.state.dockside.locals[delivery.localId];
  if (local === undefined) {
    finish(ctx, held, "noWayToMeet", berth);
    return;
  }
  if (local.movement.kind === "moving") return;
  if (standingOn(local, delivery.tile) || within(local, delivery.tile, 1.5)) {
    local.label = "waiting at the ramp";
    finish(ctx, held, "met", berth);
    return;
  }
  // Stopped short (someone in the way, a tile gone): try again, or give the word where they are.
  if (!sendLocalTo(ctx, local, delivery.tile)) finish(ctx, held, "noWayToMeet", berth);
}

/** Once a tick: retire what cannot wait, then move the oldest held card's meeting along. */
function sweepHeldCards(ctx: Ctx): void {
  const travel = ctx.state.travel;
  const giveUp = configTicks(ctx.config, ctx.config.travel.cardDeliveryGiveUpSeconds);
  for (const held of [...ctx.state.decisions.held]) {
    const docked = travel.stage === "docked" && travel.portId === held.portId;
    const berth = docked ? dockAlongsideAt(ctx.content, ctx.state, held.portId) : undefined;
    if (berth === undefined) finish(ctx, held, "leaving");
    else if (ctx.tick - held.heldTick >= giveUp) finish(ctx, held, "gaveUp", berth);
  }
  const head = ctx.state.decisions.held[0];
  if (head === undefined) return;
  const berth = dockAlongsideAt(ctx.content, ctx.state, head.portId);
  if (berth !== undefined) advanceMeeting(ctx, head, berth);
}

/** The captain ashore: looking for work, and cards delivered in person (§offers-in-person). */
export function sweepCaptainAshore(ctx: Ctx): void {
  sweepHeldCards(ctx);
  sweepLookingForWork(ctx);
}
