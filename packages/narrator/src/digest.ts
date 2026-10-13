import { templateCard } from "@crew/content";
/**
 * Digest projection (PLAN §3): a compact, LLM-readable view of the snapshot for one narrator
 * call. Pure and deterministic: the same inputs give the same text, byte for byte, so it can be
 * diffed in the eval harness and tested.
 *
 * It shows truth (D7: no captain-knowledge filtering in V1), with faults nobody has noticed
 * labelled `[undiscovered]`; the prompt forbids mentioning those in player-facing text.
 */
import {
  type ActorId,
  type ConfigDef,
  type ContentBundle,
  type DecisionId,
  type DeepReadonly,
  type ItemDefId,
  type Job,
  type JobIssuer,
  type MachineId,
  type NarratorHook,
  PASSENGER_OVERDUE_PROMPT_KEY,
  type PortDefId,
  type Problem,
  type RaisedCallBackWhen,
  type SimEvent,
  actionLabel,
  dayTicks,
  describeEvent,
  effectiveMarket,
  isSite,
  jobBlockingAcceptance,
  marketBlock,
  siteNearPort,
  ticksToSeconds,
} from "@crew/sim";
import { onDockLines, personLine, stagingDockLines } from "./dockside-digest";
import { fieldBudgetLine, fieldDigestLines } from "./field-digest";
import {
  compartmentDirtyDetail,
  dirtLine,
  galleyLine,
  isProvisions,
  provisionsReserveDetail,
} from "./galley-digest";
import {
  type Snapshot,
  type State,
  faultDiscovery,
  isArmsLocker,
  itemName,
  machineCompartment,
  machineName,
  offerPortNow,
  pathBetween,
  placePhrase,
  portHereOrNext,
  portName,
  transitSecondsLeft,
  voyageAhead,
} from "./lookups";
import { crewWoundedDetail, infirmaryLine } from "./medical-digest";
import {
  type ArcEnding,
  type ArcSketch,
  type CardShown,
  type NarratorNotes,
  PLAN_TIERS,
  type PastArc,
  type PlanTier,
  type PlannedBeat,
} from "./notes";
import { crewOffWatchClauses, offWatchLine, rivalriesLine } from "./offwatch-digest";
import {
  EXPEDITION_ARRIVAL_KEY,
  EXPEDITION_TURN_KEY,
  atSiteLines,
  captiveAboard,
  errandJobPhrase,
} from "./site-digest";
import { currentBeat, currentTempo } from "./story-plan";
import { bodyPhrase, dutyTag, helmEventLines, moodPhrase, watchLine } from "./watch-digest";

/**
 * Policy prompt keys whose template text is the card the captain sees (the gate card,
 * §departure-gate, the passengers §3.3 overdue card; job offers keep their params line).
 */
const TEMPLATED_PROMPT_KEYS: ReadonlySet<string> = new Set([
  "travel.departureGate",
  PASSENGER_OVERDUE_PROMPT_KEY,
  // Expeditions A2 (plan calls 4 and 15): the arrival and turn cards.
  EXPEDITION_ARRIVAL_KEY,
  EXPEDITION_TURN_KEY,
]);

/** ~2.5k tokens at ~4 characters per token. */
export const DIGEST_MAX_CHARS = 10_000;
/** Recent events kept before the character budget applies. */
export const DIGEST_MAX_EVENTS = 15;

export interface NarratorDigest {
  readonly text: string;
  /** Rough token estimate (characters / 4). */
  readonly approxTokens: number;
  readonly truncated: boolean;
}

interface Section {
  readonly heading: string;
  readonly lines: string[];
  /** Lower drops first when over budget; `Infinity` never drops. */
  readonly priority: number;
  /** Which end to trim from. Events trim oldest (top) first. */
  readonly trimFrom: "start" | "end";
}

/** The priority of a section that is never trimmed. */
const NEVER_DROPS = Number.POSITIVE_INFINITY;

/** A section trimmed from its end, the usual case. */
function section(heading: string, lines: string[], priority: number): Section {
  return { heading, lines, priority, trimFrom: "end" };
}

type Actor = State["actors"][keyof State["actors"]];

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function needWord(value: number): string | undefined {
  if (value >= 0.85) return "critical";
  if (value >= 0.6) return "high";
  if (value >= 0.35) return "moderate";
  return undefined;
}

/**
 * §policy-decision-hook: the policy hook line says who brings the card (the template's `speaker`,
 * e.g. the engineer for the departure gate) and which machine it is about, so the model dresses the
 * card in that person's voice rather than picking a messenger of its own.
 */
function policyHookLine(
  hook: DeepReadonly<Extract<NarratorHook, { kind: "policyDecision" }>>,
  state: State,
  content: ContentBundle,
): string {
  const decisionId = hook.context.decisionId as DecisionId;
  const decision = state.decisions.records[decisionId];
  let line = `policyDecision: decision ${decisionId} needs the captain`;
  if (hook.context.machineId !== undefined) {
    const machine = state.machines[hook.context.machineId as MachineId];
    const name = machine === undefined ? undefined : content.machines[machine.defId]?.name;
    line += ` (about ${name ?? hook.context.machineId})`;
  }
  const speaker = decision === undefined ? undefined : templateCard(decision, content).speaker;
  if (speaker !== undefined) {
    line += `; ${speaker} brings it: write the card in their voice with speaker set to their name`;
  }
  return line;
}

/**
 * Passengers-and-galaxy §3.5: `passengerReturned` is the turn of the episode, so the hook line
 * says it in words ("Halla Thorne is back aboard") rather than as an event id alone.
 */
function notableHookLine(
  hook: DeepReadonly<Extract<NarratorHook, { kind: "notableEvent" }>>,
  events: readonly SimEvent[],
  state: State,
  content: ContentBundle,
): string {
  const ids = new Set<string>(hook.context.eventIds);
  const said = events
    .filter((e) => ids.has(e.id))
    .map((e) => describeEvent(e, state as never, content))
    .filter((line) => line !== "");
  const base = `notableEvent: events ${hook.context.eventIds.join(", ")}`;
  const aftermath = events
    .filter((e) => ids.has(e.id))
    .map((e) => AFTERMATH_SUFFIX[e.type])
    .filter((suffix): suffix is string => suffix !== undefined);
  const head = said.length === 0 ? base : `${base}: ${said.join("; ")}`;
  return `${head}${[...new Set(aftermath)].join("")}`;
}

/**
 * §notable-event-hook: what an aftermath call is about, said after the event, so the model reads it
 * as the end of something it set in motion rather than a new turn.
 */
const AFTERMATH_SUFFIX: Readonly<Partial<Record<string, string>>> = {
  alertCleared:
    "; the field is over and the alert has stood down: the crew have reported in, the hull and damage lines under Ship are what they know",
  navHazard: "; the hazard you placed has been rolled: see the helm check line",
  faultRepaired: "; the fault you caused is repaired",
};

/** §requested-call-back: the moment a requested call came due, as the hook line says it. */
const CALL_BACK_WORDS: Readonly<Record<RaisedCallBackWhen, string>> = {
  departure: "when the ship cast off",
  midLeg: "mid-leg",
  arrival: "as the ship comes in to the next port",
  afterCard: "once the captain had answered the next card",
};

/**
 * §requested-call-back: the call the model asked for, read back with where the ship is: the leg and
 * the transit still ahead (what the hazard and field windows must fit), and the voyage beyond it.
 */
function requestedCallHookLine(
  hook: DeepReadonly<Extract<NarratorHook, { kind: "requestedCall" }>>,
  state: State,
  content: ContentBundle,
  config: DeepReadonly<ConfigDef>,
): string {
  const { when, why, requestedTick } = hook.context;
  const asked = `requestedCall: you asked at t${requestedTick} to be called ${CALL_BACK_WORDS[when]}: "${why}"`;
  const t = state.travel;
  if (t.stage === "docked") return `${asked}. The ship is docked at ${portName(content, t.portId)}`;
  const voyage = voyageAhead(state, content);
  const bound =
    voyage === undefined
      ? ""
      : `, bound for ${portName(content, voyage.destinationId)} (${voyage.destinationId}); ${hopsWord(voyage.hops, voyage.distance)} still to go from there`;
  const left = Math.round(transitSecondsLeft(state, config));
  return `${asked}. ${portName(content, t.fromPortId)} -> ${portName(content, t.toPortId)} (${t.toPortId}), ~${left}s of transit ahead${bound}`;
}

/**
 * §requested-call-back: the standing call-back request under the hook line, so the model restates
 * or replaces it: read back when this call is the next-port call it asked for, or shown as still
 * standing. A departure or midLeg request served by this hook is the hook line itself.
 */
function callBackLine(state: State, hook: DeepReadonly<NarratorHook>): string | undefined {
  const request = state.narrator.callBack;
  if (request === undefined || hook.kind === "stageDock") return undefined;
  if (request.servedByHookId === hook.id) {
    return request.when === "nextPort"
      ? `This is the call you asked for at the next port: "${request.why}" (asked t${request.requestedTick}).`
      : undefined;
  }
  if (request.servedByHookId !== undefined) return undefined;
  const held =
    request.holdQuiet === true ? " The quiet check-in waits twice as long while it stands." : "";
  return `Your standing request: ${request.when} — "${request.why}" (asked t${request.requestedTick}).${held} This call's callBack replaces it.`;
}

function hookLine(
  hook: DeepReadonly<NarratorHook>,
  events: readonly SimEvent[],
  snapshot: Snapshot,
  content: ContentBundle,
): string {
  const state = snapshot.state;
  switch (hook.kind) {
    case "stageDock":
      return `stageDock: dressing the dock at ${portName(content, hook.context.portId)} (${hook.context.portId}) before the ship comes alongside`;
    case "captainAshore": {
      const who = state.actors[hook.context.actorId as ActorId]?.name ?? "The captain";
      return `captainAshore: ${who} has walked down the ramp onto the dock at ${portName(content, hook.context.portId)} (${hook.context.portId}) looking for work; nothing is on offer here`;
    }
    case "quietTooLong":
      return `quietTooLong: nothing story-worthy since tick ${hook.context.quietSinceTick}`;
    case "notableEvent":
      return notableHookLine(hook, events, state, content);
    case "policyDecision":
      return policyHookLine(hook, state, content);
    case "requestedCall":
      return requestedCallHookLine(hook, state, content, snapshot.config);
  }
}

/** "2 hops, 145s" / "1 hop, 120s": what is left of a voyage or a far job. */
function hopsWord(hops: number, distance: number): string {
  return `${hops} ${hops === 1 ? "hop" : "hops"}, ${Math.round(distance)}s transit`;
}

/**
 * Passengers-and-galaxy §2.3: the travel line. A voyage beyond the current leg is said in the
 * spec's words: "stopping at Kessler Drift on the way to Ossory Station" when docked at a
 * waypoint, "under way to Kessler Drift, bound for Ossory Station" on a leg, with what is left.
 */
function travelLine(state: State, content: ContentBundle): string {
  const t = state.travel;
  const voyage = voyageAhead(state, content);
  const bound =
    voyage === undefined
      ? ""
      : `, bound for ${portName(content, voyage.destinationId)} (${voyage.destinationId}); ${hopsWord(voyage.hops, voyage.distance)} still to go from there`;
  if (t.stage === "docked") {
    const next =
      t.plannedDestinationId === undefined ? "" : portName(content, t.plannedDestinationId);
    // Expeditions A2 (§3.3): a site is set down at, not docked at, and left by lifting off.
    const near = siteNearPort(content, t.portId);
    const setDown =
      near === undefined
        ? undefined
        : `travel: set down at ${portName(content, t.portId)} (${t.portId}), a landing site off ${portName(content, near)}`;
    if (voyage !== undefined) {
      const nextLeg = next === "" ? "" : `; next leg to ${next}`;
      if (setDown !== undefined) {
        return `${setDown}; bound for ${portName(content, voyage.destinationId)} (${voyage.destinationId}), ${hopsWord(voyage.hops, voyage.distance)} still to go${nextLeg}; the ship lifts off on her own once nothing holds her here`;
      }
      return `travel: stopping at ${portName(content, t.portId)} (${t.portId}) on the way to ${portName(content, voyage.destinationId)} (${voyage.destinationId}); ${hopsWord(voyage.hops, voyage.distance)} still to go${nextLeg}; the ship continues on her own once nothing holds her here`;
    }
    const course = next === "" ? "" : `; course set for ${next}`;
    if (setDown !== undefined) return `${setDown}${course}`;
    return `travel: docked at ${portName(content, t.portId)} (${t.portId})${course}`;
  }
  const progress = t.routeDistance > 0 ? t.routeProgress / t.routeDistance : 0;
  // §limping: a limp is the engine down with no repair possible aboard; the ship crawls on.
  const drifting =
    t.limping === true
      ? ", LIMPING (propulsion lost, no repair possible aboard; crawling on at a fraction of speed)"
      : t.drifting
        ? ", DRIFTING (propulsion lost)"
        : "";
  const leg = `${portName(content, t.fromPortId)} -> ${portName(content, t.toPortId)} (${t.toPortId})`;
  const how =
    isSite(content, t.toPortId) && (t.stage === "approaching" || t.stage === "docking")
      ? `setting down at ${portName(content, t.toPortId)} (${t.toPortId}), a landing site`
      : isSite(content, t.fromPortId) && (t.stage === "undocking" || t.stage === "departing")
        ? `lifting off from ${portName(content, t.fromPortId)}, under way ${leg}`
        : `under way ${leg}`;
  return `travel: ${t.stage}, ${how}, ${pct(progress)} of route${drifting}${bound}`;
}

function shipSection(
  snapshot: Snapshot,
  content: ContentBundle,
  recentEvents: readonly SimEvent[],
): Section {
  const state = snapshot.state;
  const t = state.travel;
  const lines: string[] = [];
  const secs = Math.round(ticksToSeconds(state.tick, snapshot.config.time.tickRate));
  lines.push(`tick ${state.tick} (${secs}s into the game)`);
  lines.push(travelLine(state, content));
  // §who-has-the-helm, §hazard-roll: who has the watch and the helm, and the helm's stakes since
  // the last call.
  lines.push(watchLine(state, content, snapshot.config));
  lines.push(...helmEventLines(recentEvents, state, content, snapshot.config));
  // §field-lifecycle, §hull-scars-and-ship-loss: the asteroid field, the alert, the hull and its
  // repairs, damage known and unseen.
  lines.push(...fieldDigestLines(state, content, snapshot.config, recentEvents));
  lines.push(`money: ${state.money.balance} credits`);
  // §galley-provisions, §room-tiers: the galley (counter, next meal, provisions) and any room at
  // dirty or worse.
  const galley = galleyLine(state, content, snapshot.config);
  if (galley !== undefined) lines.push(galley);
  const dirt = dirtLine(state, content);
  if (dirt !== undefined) lines.push(dirt);
  // §ship-life-lines, §medicine: the medbay bed, who is treating, and the kits against the reserve.
  const infirmary = infirmaryLine(state, content, snapshot.config);
  if (infirmary !== undefined) lines.push(infirmary);
  // §ship-life-lines: off-watch life now (sessions, solo recreation) and the rivalries worth a
  // story.
  const offWatch = offWatchLine(state, content);
  if (offWatch !== undefined) lines.push(offWatch);
  const rivalries = rivalriesLine(state, content);
  if (rivalries !== undefined) lines.push(rivalries);
  if (t.stage === "docked") {
    // §market-and-parts-lines: what is on sale here, with prices (this is private to the model;
    // cards carry no numbers).
    lines.push(`market here: ${marketHereLine(state, content, t.portId)}`);
    if (t.holdForRepairs === true) {
      lines.push(
        `departure held for repairs (the captain chose to wait); it lifts on its own once no engine or generator is impaired${partsShortfallNote(state, content)}`,
      );
    }
  }
  const offerPort = offerPortNow(state);
  lines.push(
    offerPort === undefined
      ? "job offers possible now: none (not docked; offers are made in person at the dock)"
      : isSite(content, offerPort)
        ? "job offers possible now: none (set down at a landing site; offers are made at ports)"
        : `job offers possible now: fromPort ${offerPort}`,
  );
  return section("Ship", lines, NEVER_DROPS);
}

/**
 * §market-and-parts-lines: "Spare Parts x4 at 120 cr, Coolant Canister x3 at 60 cr", or "nothing".
 */
function marketHereLine(state: State, content: ContentBundle, portId: PortDefId): string {
  const stock = effectiveMarket(state, content, portId);
  const lines = Object.entries(stock)
    .filter(([, line]) => line.count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([itemDefId, line]) => `${itemName(content, itemDefId)} x${line.count} at ${line.price} cr`,
    );
  return lines.length === 0 ? "nothing" : lines.join(", ");
}

/**
 * §market-and-parts-lines: why a `partsNeeded` (or `reserveLow`, §reserve-low-problem) problem is
 * still open, in the prompt's words.
 */
function partsReason(state: State, content: ContentBundle, itemDefId: ItemDefId): string {
  const block = marketBlock(state, content, itemDefId);
  const t = state.travel;
  const here = t.stage === "docked" ? portName(content, t.portId) : undefined;
  switch (block) {
    case "notDocked":
      return "not at a port; only a port market sells it";
    case "notSoldHere":
      return `not available here (${here ?? "this port"})`;
    case "cannotAfford":
      return `cannot afford it here (${state.money.balance} credits)`;
    case undefined:
      return `the crew are buying it here (${here ?? "this port"})`;
  }
}

function openPartsNeeded(state: State): DeepReadonly<Extract<Problem, { kind: "partsNeeded" }>>[] {
  return Object.values(state.work.problems).filter(
    (p): p is DeepReadonly<Extract<Problem, { kind: "partsNeeded" }>> =>
      p.kind === "partsNeeded" && p.status === "open",
  );
}

/**
 * §market-and-parts-lines: appended to the hold line so the model can say why the ship is still
 * here.
 */
function partsShortfallNote(state: State, content: ContentBundle): string {
  const open = openPartsNeeded(state);
  if (open.length === 0) return "";
  const parts = open.map(
    (p) =>
      `${p.payload.count}x ${itemName(content, p.payload.itemDefId)} (${partsReason(state, content, p.payload.itemDefId)})`,
  );
  return `; the repair is waiting on parts: ${parts.join("; ")}`;
}

/**
 * Passengers-and-galaxy §3.2: the "Aboard" line for a passenger: name, passenger, where to and
 * whether they come back, where they are on deck now; while ashore, where and when they are due
 * back (and overdue, once `ashoreSinceTick + overdueDays` has passed); while walking off,
 * "going down the ramp".
 */
function aboardLine(
  snapshot: Snapshot,
  content: ContentBundle,
  actor: Actor,
  job: DeepReadonly<Job> | undefined,
): string {
  const state = snapshot.state;
  const config = snapshot.config;
  const passage = job?.passage;
  const bound =
    job === undefined
      ? "destination unknown"
      : passage?.roundTrip === true
        ? passage.leg === "back"
          ? `on the way home to ${portName(content, job.fromPortId)}`
          : `bound for ${portName(content, job.toPortId)} and back to ${portName(content, job.fromPortId)}`
        : `bound for ${portName(content, job.toPortId)}, one way`;
  const purpose = job?.description.prose === undefined ? "" : ` Says: ${job.description.prose}`;
  // Expeditions A2 (§6): the errand's target, brought aboard alive, rides home on its passage.
  const captive = job === undefined ? undefined : captiveAboard(content, job);
  if (captive !== undefined) {
    const now =
      actor.disembarking === true
        ? "going down the ramp"
        : `${actionLabel(actor, state, content)}${placePhrase(content, state, actor.location)}`;
    return `- Aboard: ${actor.name}, ${captive}; now ${now}.`;
  }
  if (passage?.leg === "ashore" && job !== undefined) {
    const dueAt = passage.returnsAtTick;
    const back =
      dueAt === undefined
        ? "no word on when they are back"
        : `back at about ${Math.round(ticksToSeconds(dueAt, config.time.tickRate))}s (tick ${dueAt})`;
    const since = passage.ashoreSinceTick;
    const overdueAt =
      since === undefined
        ? undefined
        : since + dayTicks(config, config.commerce.passage.overdueDays);
    const overdue =
      overdueAt !== undefined && state.tick >= overdueAt
        ? `; OVERDUE (expected by tick ${overdueAt})`
        : "";
    return `- Aboard: ${actor.name}, passenger, ${bound}; ashore at ${portName(content, job.toPortId)}, ${back}${overdue}.${purpose}`;
  }
  const now =
    actor.disembarking === true
      ? "going down the ramp"
      : `${actionLabel(actor, state, content)}${placePhrase(content, state, actor.location)}`;
  return `- Aboard: ${actor.name}, passenger, ${bound}; now ${now}.${purpose}`;
}

/** The passage an actor rides (or rode): the latest job whose `passage.actorId` is theirs. */
function passageOf(state: State, actorId: string): DeepReadonly<Job> | undefined {
  return Object.values(state.jobs)
    .filter((j) => j.passage?.actorId === actorId)
    .sort((a, b) => b.offeredTick - a.offeredTick || b.id.localeCompare(a.id))[0];
}

/**
 * Passengers whose passage ended at `portId` with them off the ship (left behind or put off):
 * the kernel keeps them as off-ship actors in the port's lounge, the narrator's to use as cast.
 */
function passengersAshoreAt(
  state: State,
  portId: PortDefId,
): { readonly actor: Actor; readonly job: DeepReadonly<Job> }[] {
  const ashore: { actor: Actor; job: DeepReadonly<Job> }[] = [];
  for (const actor of Object.values(state.actors)) {
    if (actor.passenger !== true || actor.availability !== "offShip") continue;
    const loc = actor.location;
    if (loc.kind !== "inExternalStore" || loc.portId !== portId) continue;
    const job = passageOf(state, actor.id);
    if (job?.passage?.endReason === undefined) continue;
    ashore.push({ actor, job });
  }
  return ashore.sort((a, b) => a.actor.id.localeCompare(b.actor.id, "en", { numeric: true }));
}

const isCaptain = (a: { readonly roleTags: readonly string[] }) => a.roleTags.includes("captain");

/**
 * §crew-lines: one crew member's line, as the digest's crew section shows it.
 * §notes-turn-tools: `crew(name)` returns it whole, however the digest was trimmed.
 */
export function crewLine(snapshot: Snapshot, content: ContentBundle, actor: Actor): string {
  const state = snapshot.state;
  const roles = actor.roleTags.length > 0 ? ` [${actor.roleTags.join(", ")}]` : "";
  const skills = Object.entries(actor.skills)
    // Expeditions A1 (call 4): the narrator hears nothing of fighting until A2.
    .filter(([skill, level]) => skill !== "fighting" && (level ?? 0) >= 3)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([skill, level]) => `${skill} ${level}`)
    .join(", ");
  const needs = [
    ...(["hunger", "fatigue", "comfort", "social"] as const).map((key) => {
      const word = needWord(actor.needs[key]);
      return word === undefined ? undefined : `${key} ${word}`;
    }),
    // Slice 4: recreation is never urgent; past the seek threshold they are simply bored.
    actor.needs.recreation >= snapshot.config.needs.seekThreshold ? "bored" : undefined,
  ]
    .filter((n) => n !== undefined)
    .join(", ");
  const where = placePhrase(content, state, actor.location);
  const status = actor.availability === "available" ? "" : ` (${actor.availability})`;
  // §duty-and-the-sleep-watch: their section and whether they are on now; §mood-and-work-speed:
  // mood and what weighs on them.
  const duty = ` ${dutyTag(actor, state.tick, snapshot.config)}`;
  const mood = moodPhrase(actor, state, content, snapshot.config);
  const def = content.crew[actor.defId];
  const bio = def?.bio;
  // §crew-lines: the voice line is how this person sounds on every card. §captain-never-speaks:
  // the captain's voice is how they come across, for how others react to them.
  const voice = def?.voice;
  const captain = isCaptain(actor) ? "this is the captain, the player; never a speaker. " : "";
  // §crew-lines: who they are off watch (likes, the people they feel strongly about, their berth)
  // follows `good at`.
  const offWatch = crewOffWatchClauses(state, content, actor);
  const doing = `${actionLabel(actor, state, content)}${where}; needs: ${needs || "fine"}; ${mood}${bodyPhrase(actor)}; good at: ${skills || "nothing in particular"}${offWatch}`;
  return `- ${actor.name}${roles}${duty}${status}: ${captain}${doing}${bio ? `. ${bio}` : ""}${voice ? ` voice: ${voice}` : ""}`;
}

/** §notes-turn-tools: a passenger's "Aboard" line, as the crew section shows it while they ride. */
export function passengerLine(snapshot: Snapshot, content: ContentBundle, actor: Actor): string {
  return aboardLine(snapshot, content, actor, passageOf(snapshot.state, actor.id));
}

function crewSection(snapshot: Snapshot, content: ContentBundle): Section {
  const state = snapshot.state;
  // §captain-never-speaks: the captain (the player's avatar) is listed first and never as a
  // speaker.
  const actors = Object.values(state.actors)
    .filter((a) => a.crew && a.passenger !== true)
    .sort(
      (a, b) =>
        Number(isCaptain(b)) - Number(isCaptain(a)) ||
        a.id.localeCompare(b.id, "en", { numeric: true }),
    );
  const lines = actors.map((actor) => crewLine(snapshot, content, actor));
  // §3.2: passengers aboard (or ashore mid-passage) each get an "Aboard" line after the crew.
  // One whose passage has ended is not aboard: left behind or put off, they are off ship at a
  // port and appear under "People you know here" there (`peopleSection`); put off while still on
  // deck, they are aboard only until the next docking, and the line says so.
  const passengers = Object.values(state.actors)
    .filter((a) => a.crew && a.passenger === true)
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  for (const passenger of passengers) {
    const job = passageOf(state, passenger.id);
    const ended = job?.passage?.endReason;
    if (ended === undefined) {
      lines.push(aboardLine(snapshot, content, passenger, job));
      continue;
    }
    if (ended === "putOff" && passenger.location.kind === "onDeck") {
      lines.push(
        `- Aboard: ${passenger.name}, passenger, put off: leaves the ship at the next docking; now ${actionLabel(passenger, state, content)}.`,
      );
    }
  }
  return section(`Crew (${actors.length})`, lines, 6);
}

function machineSection(state: State, content: ContentBundle, tickRate: number): Section {
  const machines = Object.values(state.machines)
    // Expeditions A1 (call 4): the arms locker is not the narrator's until A2.
    .filter((machine) => !isArmsLocker(content, machine))
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  const lines: string[] = [];
  const quiet = new Map<string, number>();
  for (const machine of machines) {
    const def = content.machines[machine.defId];
    const faults = machine.faults.map((fault) => {
      const name = def?.faults.find((f) => f.key === fault.faultKey)?.name ?? fault.faultKey;
      const discovery = faultDiscovery(state, machine, fault);
      const label =
        discovery === "undiscovered"
          ? "[undiscovered]"
          : discovery === "symptomNoticed"
            ? "[symptom noticed, not diagnosed]"
            : "[diagnosed]";
      return `${fault.faultKey} "${name}" ${label}`;
    });
    const scheduled = machine.scheduledFaults.map((s) => {
      const inSecs = Math.max(0, Math.round((s.fireAtTick - state.tick) / tickRate));
      return `${s.faultKey} due in ~${inSecs}s [undiscovered, scheduled]`;
    });
    const worn = machine.condition < 0.7 || machine.integrity < 1 || machine.output < 1;
    if (faults.length === 0 && scheduled.length === 0 && !worn) {
      const name = machineName(content, machine);
      quiet.set(name, (quiet.get(name) ?? 0) + 1);
      continue;
    }
    const where = machineCompartment(content, machine);
    const parts = [
      `condition ${pct(machine.condition)}`,
      `output ${pct(machine.output)}`,
      `mode ${machine.actualMode}`,
    ];
    if (faults.length > 0) parts.push(`faults: ${faults.join("; ")}`);
    if (scheduled.length > 0) parts.push(`scheduled: ${scheduled.join("; ")}`);
    lines.push(
      `- ${machine.id} ${machineName(content, machine)}${where ? ` (${where})` : ""}: ${parts.join(", ")}`,
    );
  }
  if (quiet.size > 0) {
    const names = [...quiet].map(([name, n]) => (n > 1 ? `${name} x${n}` : name));
    lines.push(`- running normally: ${names.join(", ")}`);
  }
  return section("Machines", lines, 8);
}

function problemLine(p: DeepReadonly<Problem>, snapshot: Snapshot, content: ContentBundle): string {
  const state = snapshot.state;
  const base = `- ${p.kind} (${p.visibility}) since tick ${p.createdTick}`;
  if (p.kind === "reserveLow") {
    const reason = partsReason(state, content, p.payload.itemDefId);
    // §galley-provisions: provisions are the galley's stores, counted in days of meals.
    if (isProvisions(content, p.payload.itemDefId)) {
      return `${base}: ${provisionsReserveDetail(state, content, snapshot.config, p.payload.count, reason)}`;
    }
    // §reserve-low-problem: routine restocking at a port that sells it; nothing is broken.
    return `${base}: the ship's stores are low; ${p.payload.count}x ${itemName(content, p.payload.itemDefId)} would restock them; ${reason}`;
  }
  if (p.kind === "compartmentDirty") {
    // §room-cleaning-problem: the ship's own failing, and who is mopping it, if anyone.
    return `${base}: ${compartmentDirtyDetail(state, content, p)}`;
  }
  if (p.kind === "crewWounded") {
    // §the-wounded-problem: who is hurt and who is seeing to them, or why nobody is.
    return `${base}: ${crewWoundedDetail(state, content, snapshot.config, p)}`;
  }
  if (p.kind !== "partsNeeded") return base;
  // §market-and-parts-lines: the stalled repair and what would unstick it, so the model can stock a
  // market or tell the story of a part that is not here.
  const machine = state.machines[p.payload.machineId];
  const who = machine === undefined ? p.payload.machineId : machineName(content, machine);
  return `${base}: ${who} needs ${p.payload.count}x ${itemName(content, p.payload.itemDefId)}; ${partsReason(state, content, p.payload.itemDefId)}`;
}

function problemSection(snapshot: Snapshot, content: ContentBundle): Section {
  const lines = Object.values(snapshot.state.work.problems)
    .filter((p) => p.status === "open")
    .sort((a, b) => a.createdTick - b.createdTick || a.id.localeCompare(b.id))
    .map((p) => problemLine(p, snapshot, content));
  return section("Open problems", lines, 4);
}

/**
 * Slice-4 playtest: freight unloading at its destination still reads `inTransit`, and the model
 * took that for a job in hand and offered nothing when the captain went ashore, so the ship sat
 * idle until the next check-in. A job past offering that no longer blocks acceptance says so.
 */
const FINISHING_HERE = "; being finished here, not in hand: new work can be offered and taken now";

function jobSection(state: State, content: ContentBundle): Section {
  const live = new Set(["offered", "accepted", "inTransit", "delivered"]);
  const blocking = jobBlockingAcceptance(state);
  const lines = Object.values(state.jobs)
    .filter((j) => live.has(j.status))
    .sort((a, b) => a.offeredTick - b.offeredTick || a.id.localeCompare(b.id))
    .map((j) => {
      const cargo = j.cargo.map((c) => `${c.count}x ${itemName(content, c.itemDefId)}`).join(", ");
      // §2.3: a far destination says how far, so the model knows the job is a voyage.
      // Expeditions A2 (§6): an errand's far end is its site.
      const farEnd = j.errand?.siteId ?? j.toPortId;
      const path = pathBetween(content, state, j.fromPortId, farEnd);
      const far =
        path === undefined || path.hops <= 1
          ? ""
          : ` (${hopsWord(path.hops, path.distance)} via ${path.path
              .slice(1, -1)
              .map((id) => portName(content, id))
              .join(", ")})`;
      // §cards-never-mention-pay: pay is left out; the model has no use for the amount and must
      // never repeat it. §3.1: a passage says so, with the leg it is on; its cargo line is luggage.
      const passage = j.passage;
      const passageWords =
        passage === undefined
          ? undefined
          : `${passage.roundTrip ? "round-trip passage" : "one-way passage"} (${passage.endReason ?? `leg ${passage.leg}`})`;
      const kind =
        j.errand !== undefined
          ? `${errandJobPhrase(content, j.errand)}${passageWords === undefined ? "" : `; ${j.errand.targetName} aboard on a ${passageWords}`}`
          : passageWords === undefined
            ? cargo
            : `${passageWords}${cargo === "" ? ", no luggage" : `, luggage: ${cargo}`}`;
      const finishing = j.status !== "offered" && blocking === undefined ? FINISHING_HERE : "";
      return `- ${j.id} ${j.status} (${j.origin}): from ${personLine(j.issuerPerson)}, ${portName(content, j.fromPortId)} -> ${portName(content, farEnd)}${far}, ${kind}${finishing}`;
    });
  return section("Jobs", lines, 7);
}

/**
 * §dock-sections: "On the dock" with a dock alongside; none in flight. Expeditions A2: with a site
 * map alongside it is "At the site" instead.
 */
function dockSections(state: State, content: ContentBundle): Section[] {
  const dock = atSiteLines(state, content) ?? onDockLines(state, content);
  return dock === undefined ? [] : [section(dock.heading, dock.lines, 6)];
}

/** §staging-prompt: the staging call's own section, the dock it is dressing; never trimmed. */
function stagingSections(content: ContentBundle, hook: DeepReadonly<NarratorHook>): Section[] {
  if (hook.kind !== "stageDock") return [];
  const dock = stagingDockLines(content, hook);
  return [section(dock.heading, dock.lines, NEVER_DROPS)];
}

/**
 * §issuers-and-pitches / GDD §21: people the captain has already met at the port the ship is at or
 * approaching: the narrator's cast placed there, and whoever offered jobs from there before (the
 * null job source's people too), so the model can bring someone back instead of inventing a
 * stranger.
 *
 * Passengers-and-galaxy §2.4: the port's character and its seeded locals (`PortDef.castSeed`)
 * follow, as locals the model may bring in. They live in content, not in `notes.cast`: a seed
 * never costs one of the twelve cast slots, is never stamped with a sighting, and reappears here
 * every visit whether or not the model wrote about them. Once the model does write one into its
 * cast (same name), the cast entry is shown and the seed line is not, so the model's own note on
 * that person wins.
 */
function peopleSection(snapshot: Snapshot, notes: NarratorNotes, content: ContentBundle): Section {
  const state = snapshot.state;
  const portId = portHereOrNext(state);
  const lines: string[] = [];
  const named = new Set<string>();
  const port = content.ports[portId];
  if (port !== undefined) lines.push(`the place: ${port.character}`);
  for (const c of notes.cast) {
    if (c.portId !== portId) continue;
    named.add(c.name.toLowerCase());
    const seen = c.lastSeenTick >= 0 ? `; last seen at tick ${c.lastSeenTick}` : "";
    lines.push(`- ${c.name}: ${c.note}${seen}`);
  }
  // Passengers-and-galaxy §3.3: a passenger left behind or put off here is a local now.
  for (const { actor, job } of passengersAshoreAt(state, portId)) {
    const key = actor.name.toLowerCase();
    if (named.has(key)) continue;
    named.add(key);
    const how = job.passage?.endReason === "putOff" ? "put off the ship" : "left behind";
    const purpose = job.description.prose === undefined ? "" : ` Said: ${job.description.prose}`;
    lines.push(
      `- ${actor.name}: passenger ${how} here, off ship (was bound for ${portName(content, job.toPortId)}${job.passage?.roundTrip === true ? ` and back to ${portName(content, job.fromPortId)}` : ""}); yours to use.${purpose}`,
    );
  }
  const issuers = Object.values(state.jobs)
    .filter((j) => j.fromPortId === portId)
    .sort((a, b) => b.offeredTick - a.offeredTick || a.id.localeCompare(b.id));
  for (const job of issuers) {
    const key = job.issuerPerson.name.toLowerCase();
    if (named.has(key)) continue;
    named.add(key);
    lines.push(
      `- ${personLine(job.issuerPerson)}: offered a job to ${portName(content, job.toPortId)} at tick ${job.offeredTick} (${job.status})`,
    );
  }
  const seeds = (port?.castSeed ?? []).filter((seed) => !named.has(seed.name.toLowerCase()));
  if (seeds.length > 0) {
    lines.push(
      "locals you have not met yet but may bring in (not in your cast until you write about them):",
    );
    for (const seed of seeds) lines.push(`- ${seed.name}, ${seed.role}: ${seed.note}`);
  }
  return section(`People you know here (${portName(content, portId)})`, lines, 5.5);
}

function decisionSection(state: State, content: ContentBundle): Section {
  const lines = state.decisions.queue.map((id) => {
    const d = state.decisions.records[id];
    if (d === undefined) return `- ${id} (missing)`;
    // Template cards (policy decisions) read as the captain will see them, not as key+params,
    // with both sides named so `card` keeps the kernel's left/right order (§policy-decision-hook).
    if (d.prompt.prose === undefined && TEMPLATED_PROMPT_KEYS.has(d.prompt.key)) {
      const card = templateCard(d, content);
      const who = card.speaker === undefined ? "" : ` (brought by ${card.speaker})`;
      return `- ${d.id} (${d.origin}): ${card.title}${who}: ${card.situation} Left: "${card.leftLabel}". Right: "${card.rightLabel}".`;
    }
    const prompt = d.prompt.prose ?? `${d.prompt.key} ${JSON.stringify(d.prompt.params)}`;
    return `- ${d.id} (${d.origin}): ${prompt}`;
  });
  return section("Pending decisions", lines, 9);
}

/**
 * §held-cards: cards held to be delivered in person. They are not on screen yet (not "Pending
 * decisions", not seen), so the model must not treat them as shown; they are this call's card if it
 * has one.
 */
function heldSection(state: State): Section {
  const lines = state.decisions.held.map((held) => {
    const d = state.decisions.records[held.decisionId];
    const what = d?.prompt.prose ?? (d?.jobId === undefined ? "a card" : `the offer ${d.jobId}`);
    const how =
      held.delivery === undefined
        ? "about to meet the captain"
        : held.delivery.via === "captain"
          ? "the captain is on the way to them"
          : "walking over to the ship";
    return `- ${held.decisionId} from ${held.speaker} (${how}; not shown yet): ${what}`;
  });
  return section("Cards on their way to the captain in person", lines, 9);
}

/** One recent event as the digest shows it (§notes-turn-tools: `eventsSince` too). */
export function eventLine(e: SimEvent, state: State, content: ContentBundle): string {
  const payload = JSON.stringify(e.payload);
  const detail = payload.length > 100 ? `${payload.slice(0, 99)}…` : payload;
  return `- t${e.tick} ${describeEvent(e, state as never, content)} ${detail}`;
}

function eventSection(events: readonly SimEvent[], state: State, content: ContentBundle): Section {
  const lines = events
    .filter((e) => e.significance !== "trace")
    .slice(-DIGEST_MAX_EVENTS)
    .map((e) => eventLine(e, state, content));
  return { heading: "Recent events (oldest first)", lines, priority: 3, trimFrom: "start" };
}

/** §narrator-lever-budgets: a counter as advice: what is left, or how far past it. */
function budgetLine(what: string, remaining: number): string {
  return remaining >= 0
    ? `${what} remaining: ${remaining}`
    : `${what} remaining: 0 (${-remaining} past it)`;
}

/**
 * §narrator-lever-budgets: the counters, read as advice on how much pressure this stretch has had;
 * nothing is refused for them.
 */
function budgetSection(state: State): Section {
  const b = state.narrator.budget;
  const lines = [
    "Advice, not a limit: how much pressure this stretch has had. A lever past it still works.",
    budgetLine("spawns", b.spawnsRemaining),
    budgetLine("faults", b.faultsRemaining),
    budgetLine("hazards", b.hazardsRemaining),
    fieldBudgetLine(state),
  ];
  return section("Your budget", lines, NEVER_DROPS);
}

/** Arc notes are free text; the thread line reads as sentences whether or not they end in one. */
function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?…"”]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function notesSection(notes: NarratorNotes): Section {
  const lines: string[] = [];
  lines.push(`summary: ${notes.summary || "(nothing yet: this is the first call)"}`);
  for (const t of notes.threads) {
    const people = t.people.length > 0 ? t.people.join(", ") : "nobody yet";
    const last = t.lastBeatTick === null ? "none yet" : `t${t.lastBeatTick}`;
    // §beat-cards: a thread that has had its beat card gets no second one; the next card pays it
    // off.
    const foreshadowed = t.beatCardShown ? " (foreshadowed)" : "";
    lines.push(
      `- [${t.scale}] "${t.title}" (${people}): ${asSentence(t.arcNotes)} Next: ${t.nextBeat || "(none set)"}. Last beat ${last}${foreshadowed}`,
    );
  }
  for (const c of notes.cast) {
    const where = c.portId === null ? "" : ` [at ${c.portId}]`;
    lines.push(`cast: ${c.name}${where}: ${c.note}`);
  }
  for (const r of notes.lastRejections) lines.push(`rejected last time: ${r}`);
  return section("Your notes so far", lines, 5);
}

/** §seasons-and-stalls: episodes without an arc beat before the digest says the arc has stalled. */
export const ARC_STALL_EPISODES = 3;

const TIER_LABEL: Readonly<Record<PlanTier, string>> = {
  season: "Season",
  arc: "Arc",
  episode: "Episode",
};

/** §your-plan-in-the-digest: one beat with its record. */
function beatLine(beat: PlannedBeat): string {
  const decided = beat.decided ? ", decided" : "";
  const thread = beat.thread === "" ? "" : `, thread "${beat.thread}"`;
  const tick = beat.landedTick === null ? "" : ` t${beat.landedTick}`;
  const motion =
    beat.inMotion.length === 0
      ? ""
      : ` (in motion: ${beat.inMotion.map((m) => `${m.kind} since t${m.sinceTick}`).join(", ")})`;
  return `  - [${beat.tension}${decided}${thread}] "${beat.name}": ${beat.what} → ${beat.status}${tick}${motion}`;
}

/** §your-plan-in-the-digest: a tier's premise and record, then its beats. */
function sketchLines(tier: PlanTier, sketch: ArcSketch): string[] {
  if (sketch.premise === "") return [`${TIER_LABEL[tier]}: none sketched.`];
  const revisions =
    sketch.revisions === 0 ? "never revised" : `revised ${sketch.revisions}x: ${sketch.revised}`;
  const was = sketch.previousPremise === "" ? "" : ` (was: ${sketch.previousPremise})`;
  const until = sketch.until === "" ? "" : ` Until: ${sketch.until}`;
  return [
    `${TIER_LABEL[tier]} (tempo ${sketch.tempo}, since t${sketch.openedTick}, ${revisions}): ${asSentence(sketch.premise)}${was}${until}`,
    ...sketch.beats.map(beatLine),
  ];
}

/**
 * §your-plan-in-the-digest: the plan as the server has kept it, never trimmed: each tier, the
 * beat the episode is at, and a stalled arc. The record only, never advice (D46).
 */
function planSection(notes: NarratorNotes): Section {
  const { plan } = notes;
  if (PLAN_TIERS.every((tier) => plan[tier].premise === "")) {
    return section("Your plan", ["(nothing sketched yet)"], NEVER_DROPS);
  }
  const lines = PLAN_TIERS.flatMap((tier) => sketchLines(tier, plan[tier]));
  const at = currentBeat(plan);
  const tempo = currentTempo(plan);
  if (at !== undefined && tempo !== undefined) {
    lines.push(`You are at ${at.tension} (tempo: ${tempo}): "${at.name}".`);
  } else if (plan.episode.premise !== "") {
    lines.push("Every beat of the episode has landed or been set aside.");
  }
  if (plan.arc.premise !== "" && plan.episodesSinceArcBeat >= ARC_STALL_EPISODES) {
    lines.push(`No arc beat has landed in the last ${plan.episodesSinceArcBeat} episodes.`);
  }
  return section("Your plan", lines, NEVER_DROPS);
}

const ARC_ENDING_TEXT: Readonly<Record<ArcEnding, string>> = {
  closingCard: "ended on its closing card",
  retired: "ended without a card",
  planEnded: "ended by your plan",
};

/**
 * §past-arcs: every story that has ended this game, oldest first, so the narrator sees the shape of
 * what it has told (a run of cargo runs with no trouble shows as one). Never trimmed, and outside
 * the digest's character budget: the owner chose the tokens over a narrator that forgets.
 */
/** §past-arcs: one past arc's line (§notes-turn-tools: `pastArcs` too). */
export function pastArcLine(a: PastArc): string {
  const people = a.people.length > 0 ? a.people.join(", ") : "nobody named";
  const shape = a.shape === "" ? "" : ` ${a.shape}.`;
  return `- t${a.openedTick}-t${a.closedTick} [${a.scale}] "${a.title}" (${people}):${shape} ${a.summary} (${ARC_ENDING_TEXT[a.ending]})`;
}

function pastArcsSection(notes: NarratorNotes): Section {
  const arcs = notes.pastArcs;
  const lines =
    arcs.length === 0
      ? ["(none yet: no story has ended this game)"]
      : [
          `${arcs.length === 1 ? "1 story has" : `${arcs.length} stories have`} ended this game:`,
          ...arcs.map(pastArcLine),
        ];
  return section("Past arcs", lines, NEVER_DROPS);
}

/**
 * §open-threads-list: the open thread titles on their own, never trimmed. A closing card's
 * closesThread (and a beat card's beatOfThread) must copy one exactly; buried in the thread lines,
 * the model wrote the offer's card title or the issuer's name instead.
 */
function openThreadsSection(notes: NarratorNotes): Section {
  const lines =
    notes.threads.length === 0
      ? ["(none: a closing card has nothing to close, so leave closesThread empty)"]
      : [
          "Copy one of these exactly into closesThread (a closing card) or beatOfThread (a beat card):",
          ...notes.threads.map((t) => `- "${t.title}"`),
        ];
  return section("Open threads", lines, NEVER_DROPS);
}

/**
 * §card-history: what the captain actually knows. The captain experiences the story only through
 * the cards, so this list (newest first) is the ground truth for "has the captain seen this?". It
 * outranks the machine list in the trim order.
 */
/**
 * §card-history: the roll after the choice: on the way in unseen, ` (the way in unseen, 70%): it
 * worked, they got in unseen` (§unseen-odds); on a tried side, ` (70%): it failed` (§tried-sides).
 */
function triedWords(card: CardShown): string {
  const tried = card.tried;
  if (tried === undefined) return "";
  if (tried.kind === "try") return ` (${tried.odds}%): it ${tried.worked ? "worked" : "failed"}`;
  const how = tried.worked ? "it worked, they got in unseen" : "it failed, they were waiting";
  return ` (the way in unseen, ${tried.odds}%): ${how}`;
}

/** §card-history: one card the captain saw (§notes-turn-tools: `cardsShown` too). */
export function cardShownLine(c: CardShown): string {
  const who = c.speaker ?? "observed";
  const chose =
    c.chosen === null
      ? "unresolved"
      : `chose "${c.chosen === "left" ? c.leftLabel : c.rightLabel}"`;
  // §closing-cards: the thread is retired; this is how the model knows it is finished.
  const closed = c.closedThread === null ? "" : ` (closed thread "${c.closedThread}")`;
  return `- t${c.tick} "${c.title}" (${who}): ${c.gist} → ${chose}${triedWords(c)}${closed}`;
}

function cardsSeenSection(
  notes: NarratorNotes,
  hook: DeepReadonly<NarratorHook> | undefined,
): Section {
  // §policy-decision-hook: the card this call is dressing has not been shown yet, though its
  // `decisionPending` event has already been folded into the history.
  const pendingId = hook?.kind === "policyDecision" ? hook.context.decisionId : undefined;
  const lines = [...notes.cardsShown]
    .filter((c) => c.decisionId !== pendingId)
    .reverse()
    .map(cardShownLine);
  return { heading: "What the captain has seen", lines, priority: 8.5, trimFrom: "start" };
}

function render(sections: readonly Section[], note: string | undefined): string {
  const body = sections
    .filter((s) => s.lines.length > 0)
    .map((s) => `## ${s.heading}\n${s.lines.join("\n")}`)
    .join("\n\n");
  return note === undefined ? body : `${body}\n\n${note}`;
}

/**
 * Build the digest. `hook` defaults to the snapshot's pending hook. Over `maxChars`, lines are
 * dropped deterministically from the lowest-priority sections first (events oldest-first) and a
 * note says how many.
 */
export function buildDigest(
  snapshot: Snapshot,
  recentEvents: readonly SimEvent[],
  notes: NarratorNotes,
  content: ContentBundle,
  hook: DeepReadonly<NarratorHook> | undefined = snapshot.state.narrator.pendingHook,
  maxChars: number = DIGEST_MAX_CHARS,
): NarratorDigest {
  const state = snapshot.state;
  const callBack = hook === undefined ? undefined : callBackLine(state, hook);
  const hookSection = section(
    "Why you were called",
    [
      hook === undefined ? "no hook recorded" : hookLine(hook, recentEvents, snapshot, content),
      ...(callBack === undefined ? [] : [callBack]),
    ],
    NEVER_DROPS,
  );
  // §staging-prompt: the staging call has no story levers, so it is not shown the story budget.
  const staging = hook?.kind === "stageDock";
  const sections: Section[] = [
    hookSection,
    ...(hook === undefined ? [] : stagingSections(content, hook)),
    shipSection(snapshot, content, recentEvents),
    ...(staging ? [] : [budgetSection(state)]),
    decisionSection(state, content),
    heldSection(state),
    machineSection(state, content, snapshot.config.time.tickRate),
    jobSection(state, content),
    crewSection(snapshot, content),
    notesSection(notes),
    ...(staging ? [] : [planSection(notes)]),
    ...(staging ? [] : [openThreadsSection(notes)]),
    ...(staging ? [] : [pastArcsSection(notes)]),
    cardsSeenSection(notes, hook),
    peopleSection(snapshot, notes, content),
    ...dockSections(state, content),
    problemSection(snapshot, content),
    eventSection(recentEvents, state, content),
  ];

  let dropped = 0;
  const noteFor = (n: number) =>
    n === 0 ? undefined : `[digest truncated: ${n} lower-priority lines omitted to fit the budget]`;
  let text = render(sections, undefined);
  // §past-arcs: past arcs are outside the budget, so a long game never trims the rest to fit them.
  const arcsSection = sections.find((s) => s.heading === "Past arcs");
  const budget =
    maxChars + (arcsSection === undefined ? 0 : render([arcsSection], undefined).length);
  while (text.length > budget) {
    const victim = sections
      .filter((s) => s.lines.length > 0 && Number.isFinite(s.priority))
      .sort((a, b) => a.priority - b.priority)[0];
    if (victim === undefined) break;
    if (victim.trimFrom === "start") victim.lines.shift();
    else victim.lines.pop();
    dropped += 1;
    text = render(sections, noteFor(dropped));
  }
  return { text, approxTokens: Math.ceil(text.length / 4), truncated: dropped > 0 };
}
