/**
 * Generic render projection (D7: the map shows truth). Fills `RenderFrame` from state: actor
 * positions and action labels, machine and door states, travel progress, money, and the ticker.
 * Polish A adds the items aboard (§rooms-items-and-cargo) and a one-line ship headline
 * (§the-ship-headline). The dock alongside (§living-on-the-dock) is in the frame too, with everyone
 * and everything on it flagged `onDock`.
 */
import { configTicks } from "./clock";
import { findItemDef } from "./defs";
import { isOnDock } from "./docks";
import { isNobodysFreight } from "./freight";
import { byId } from "./ids";
import { isSite } from "./places";
import { roomPhrase } from "./rooms";
import { siteOf } from "./sites";
import type { Actor } from "./types/actor";
import type { DeepReadonly, PhysicalLocation, TileCoord } from "./types/common";
import type { BodyPart, ConfigDef, ContentBundle, HazardKind, ItemDef } from "./types/content";
import type { SimEvent } from "./types/events";
import type { JobId, PortDefId } from "./types/ids";
import type { World } from "./types/kernel";
import type { ReadonlyWorldState } from "./types/pipeline";
import type { Door, Item, Machine } from "./types/ship";
import type { SessionVenue } from "./types/state";
import type { ErrandKind, PassageEndReason, TravelState } from "./types/travel";
import type {
  RenderActor,
  RenderDock,
  RenderDockProp,
  RenderExpedition,
  RenderField,
  RenderFrame,
  RenderHull,
  RenderImpact,
  RenderItem,
  RenderItemKind,
  RenderItemLocation,
  RenderLocal,
  RenderMachine,
  RenderMachineState,
  RenderSession,
  RenderShot,
  RenderTravel,
  SideWord,
  TickerEntry,
} from "./types/view";
import type { DirtFrame } from "./types/view";
import type { ActionKind, ProblemKind } from "./types/work";

const ACTION_VERBS: Readonly<Record<ActionKind, string>> = {
  walk: "walking",
  operateDoor: "working a door",
  pickUp: "picking up",
  putDown: "putting down",
  inspect: "inspecting",
  diagnose: "diagnosing",
  repair: "repairing",
  removeComponent: "removing a part from",
  installComponent: "installing a part in",
  test: "testing",
  eat: "eating",
  sleep: "sleeping",
  operateStation: "operating",
  chat: "chatting",
  wait: "waiting",
  recreate: "taking it easy",
  confer: "having a word",
  report: "on the intercom",
};

/** Short present-tense label for an actor: "repairing coolant pump", "sleeping", "walking". */
export function actionLabel(
  actor: DeepReadonly<Actor>,
  state: ReadonlyWorldState,
  content: ContentBundle,
): string {
  if (actor.availability === "dead") return "dead";
  // Expeditions A1 (§8.6): in a fight, someone incapacitated is "down".
  if (actor.availability === "incapacitated") {
    return actor.combatant === undefined ? "incapacitated" : "down";
  }
  const activity = actor.activity;
  if (activity.kind === "idle") {
    return actor.movement.kind === "moving" ? "walking" : "idle";
  }
  // W4a: the work system keeps a ready-made label on the activity (systems/work/labels.ts).
  if (activity.label !== undefined) return activity.label;
  const action = activity.action;
  if (action.kind === "sleep" && action.stage !== "asleep") {
    return action.stage === "waking" ? "waking up" : "lying down";
  }
  const verb = ACTION_VERBS[action.kind];
  const targetId = action.targetId;
  if (targetId === undefined || action.kind === "walk") return verb;
  const machine = state.machines[targetId as Machine["id"]];
  if (machine !== undefined) {
    const name = content.machines[machine.defId]?.name;
    return name === undefined ? verb : `${verb} ${name.toLowerCase()}`;
  }
  const other = state.actors[targetId as Actor["id"]];
  if (other !== undefined && action.kind === "chat") return `chatting with ${other.name}`;
  return verb;
}

function machineState(
  machine: DeepReadonly<Machine>,
  content: ContentBundle,
  config: ConfigDef,
): RenderMachineState {
  const faultDefs = content.machines[machine.defId]?.faults ?? [];
  const inoperable = machine.faults.some(
    (fault) => faultDefs.find((def) => def.key === fault.faultKey)?.effect.kind === "inoperable",
  );
  // §output-and-blocking: a machine blocked by an inoperable fault or low integrity (at the config
  // threshold, not only at 0) reads "failed" even though equipment has switched it off.
  if (inoperable || machine.integrity < config.equipment.integrityInoperableBelow) return "failed";
  if (machine.actualMode === "off") return "off";
  if (machine.faults.length > 0 || machine.output < 1) return "degraded";
  return "ok";
}

function renderActor(
  actor: DeepReadonly<Actor>,
  state: ReadonlyWorldState,
  content: ContentBundle,
): RenderActor | null {
  let location = actor.location;
  if (location.kind === "carriedBy") {
    location = state.actors[location.actorId]?.location ?? location;
  }
  if (location.kind !== "onDeck") return null;
  return {
    id: actor.id,
    name: actor.name,
    deckId: location.deckId,
    x: location.x,
    y: location.y,
    onDock: isOnDock(content, state, location),
    facing: actor.facing,
    actionLabel: actionLabel(actor, state, content),
    passenger: actor.passenger === true,
    ...(actor.combatant === undefined
      ? {}
      : { state: actor.combatant.state, side: actor.combatant.side }),
    wounded: actor.body.wounds.length > 0,
  };
}

function humanize(type: string): string {
  const words = type
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Trace-level events the ticker still shows (Integration 2): they are what makes the crew's day
 * readable. Everything `notable`+ is shown too, except the bookkeeping types in `TICKER_HIDDEN`.
 */
const TICKER_TRACE_TYPES: ReadonlySet<SimEvent["type"]> = new Set([
  "needThresholdCrossed",
  "faultOccurred",
  "taskCompleted",
  "travelStageChanged",
  "fellAsleep",
  // Expeditions A1 (§8.6): every shot reaches the frame's tracers (`RenderFrame.shots`); its
  // line is null, so the log never shows it.
  "shotFired",
  // The party armed and walking out: the "takes four down the ramp" line.
  "partyMustered",
]);

/** Notable events whose information another ticker line already carries. */
const TICKER_HIDDEN: ReadonlySet<SimEvent["type"]> = new Set([
  "problemRaised",
  "problemResolved",
  "decisionPending",
  "commandRejected",
  "invariantViolated",
  // §hazard-roll: the narrator's bookkeeping (its hazard came to nothing); the player saw nothing
  // happen.
  "navHazardMissed",
  // §field-lifecycle: likewise for a field whose leg ended before it began.
  "fieldMissed",
  // §policy-decision-cards: the card itself follows at once; the line read like a dev string.
  "policyDecisionNeeded",
]);

/** Should `event` reach the ticker at all? (`describeEvent` may still drop it with `null`.) */
export function isTickerEvent(event: SimEvent): boolean {
  if (TICKER_HIDDEN.has(event.type)) return false;
  return event.significance !== "trace" || TICKER_TRACE_TYPES.has(event.type);
}

const NEED_WORDS: Readonly<Record<string, readonly [string, string]>> = {
  hunger: ["is getting hungry", "is starving"],
  fatigue: ["is getting tired", "is exhausted"],
  comfort: ["could use a rest", "is aching for a rest"],
  social: ["wants company", "is desperately lonely"],
};

const STAGE_LINES: Readonly<Record<string, string>> = {
  preparingDeparture: "Preparing to depart",
  undocking: "Undocking",
  transit: "Under way",
  approaching: "On approach",
  docking: "Docking",
};

/** Expeditions A2 (§known-sites): a ship sets down at a site and lifts off from one. */
const SITE_STAGE_LINES: Readonly<Record<string, string>> = {
  undocking: "Lifting off",
  approaching: "Coming in to land",
  docking: "Setting down",
};

/** §debris-fields-and-ion-storms: how each navigation hazard kind reads in the ticker. */
const HAZARD_NAMES: Readonly<Record<HazardKind, string>> = {
  debrisField: "Debris field",
  ionStorm: "Ion storm",
};

/** §the-bell: "white" → "White", for "Bell. White section has the watch." */
function sectionName(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** §hazard-roll: the ticker line for a navigation hazard's outcome. */
function navHazardLine(event: Extract<SimEvent, { type: "navHazard" }>, n: Names): string {
  const { kind, outcome, standerId, scrapedMachineId, lostSeconds } = event.payload;
  const head = HAZARD_NAMES[kind];
  const scraped =
    scrapedMachineId === undefined
      ? "scraped through"
      : `scraped through, the ${n.machineLower(scrapedMachineId)} took it`;
  const lost = `lost ${Math.round(lostSeconds)} s`;
  switch (outcome) {
    case "clean":
      return `${head}: ${n.actor(standerId ?? "") ?? "the helm"} took us through clean`;
    case "scrape":
      return `${head}: ${scraped}`;
    case "delay":
      return `${head}: ${lost} working round it`;
    case "unattended":
      return `${head}: nobody at the helm; scraped through and ${lost}`;
  }
}

/** Passengers §3.5: how a passage's ending reads in the ticker, by `PassageEndReason`. */
const PASSAGE_END_LINES: Readonly<
  Record<PassageEndReason, (name: string, port: string) => string>
> = {
  completed: (name, port) => `${name} went down the ramp at ${port}`,
  leftBehind: (name, port) => `Left ${port} without ${name}`,
  putOff: (name, port) => `Put ${name} off at ${port}`,
};

type Names = {
  actor(id: string): string | undefined;
  machine(id: string): string | undefined;
  /** The machine's name in lower case, or "machine", for mid-sentence use. */
  machineLower(id: string): string;
  port(id: string): string;
  /** Expeditions A2: is this port a landing site (§landing-sites)? */
  isSite(id: string): boolean;
  /** Expeditions A2: is the ship setting down at, or lifting off from, a site right now? */
  atSite(): boolean;
  item(id: string): string;
  itemDef(defId: string): string;
  faultName(machineId: string, faultKey: string): string;
  symptomName(machineId: string, symptomKey: string): string;
  job(id: string): { issuer: string; name: string; to: string; passenger: boolean } | undefined;
  /** §room-tiers: "the galley" for the room `key` of the ship's deck; "the room" if unknown. */
  room(key: string): string;
  /** "The galley": `room` capitalised to start a line. */
  roomCap(key: string): string;
  /** Slice 4: "the lounge" for a compartment instance; "the room" if unknown. */
  compartment(id: string): string;
  /** Slice 4: the activity's running label ("playing cards"). */
  activityLabel(id: string): string;
  /** Slice 4: what one plays, from the label without a leading "playing " ("cards"). */
  activityNoun(id: string): string;
  /** Slice 4: "the Guild": a topic's label. */
  topic(id: string): string;
  /** Slice 4: "the captain's cabin" (or "the first officer's cabin"), by the caller's rank. */
  cabinOf(actorId: string): string;
  /** Slice 4: "played the harmonica in the lounge": a performance, said from where they are. */
  performed(actorId: string, activityId: string): string;
  /** Expeditions A1: is this actor crew (a party member) rather than one of the site's cast? */
  isCrew(actorId: string): boolean;
  /** Expeditions A1: the site's exit post's name ("the jetty"), or "the way out". */
  siteExit(): string;
  /**
   * Expeditions A2: a job's errand, for its lines: what it fetches, the site mid-sentence ("the
   * Boathouse"), and whether the expedition for it ended with the target gone by the exit.
   */
  errand(
    jobId: string,
  ): { kind: ErrandKind; target: string; site: string; targetFled: boolean } | undefined;
};

function namer(state: ReadonlyWorldState, content: ContentBundle): Names {
  const machineDef = (id: string) => {
    const machine = state.machines[id as Machine["id"]];
    return machine === undefined ? undefined : content.machines[machine.defId];
  };
  const machine = (id: string) => machineDef(id)?.name;
  const room = (key: string) => {
    for (const deckId of Object.keys(state.deck.tiles)) {
      const def = content.decks[deckId as keyof ContentBundle["decks"]]?.compartments.find(
        (c) => c.key === key,
      );
      if (def !== undefined) return roomPhrase(def);
    }
    return "the room";
  };
  const compartment = (id: string) => {
    const instance = state.compartments[id as keyof ReadonlyWorldState["compartments"]];
    return instance === undefined ? "the room" : room(instance.key);
  };
  const activityLabel = (id: string) =>
    content.activities[id as keyof ContentBundle["activities"]]?.label ?? "taking it easy";
  return {
    room,
    compartment,
    activityLabel,
    activityNoun: (id) => activityLabel(id).replace(/^playing /, ""),
    topic: (id) => content.topics[id as keyof ContentBundle["topics"]]?.label ?? "this and that",
    cabinOf: (actorId) =>
      state.actors[actorId as Actor["id"]]?.roleTags.includes("captain") === true
        ? "the captain's cabin"
        : "the first officer's cabin",
    performed: (actorId, activityId) => {
      const played = activityLabel(activityId).replace(/^playing /, "played ");
      const where = roomOfActor(state, content, actorId as Actor["id"]);
      return where === undefined ? played : `${played} in ${room(where)}`;
    },
    roomCap: (key) => {
      const text = room(key);
      return text.charAt(0).toUpperCase() + text.slice(1);
    },
    actor: (id) => state.actors[id as Actor["id"]]?.name,
    isCrew: (id) => state.actors[id as Actor["id"]]?.crew === true,
    siteExit: () => {
      const exit = siteOf(content, state)?.dock.posts.find((p) => p.kind === "exit");
      return exit?.name ?? "the way out";
    },
    errand: (id) => {
      const errand = state.jobs[id as keyof ReadonlyWorldState["jobs"]]?.errand;
      if (errand === undefined) return undefined;
      const expedition = state.expedition;
      return {
        kind: errand.kind,
        target: errand.targetName,
        site: midSentence(portName(content, errand.siteId)),
        targetFled: expedition?.jobId === id && expedition.outcome === "targetFled",
      };
    },
    machine,
    machineLower: (id) => (machine(id) ?? "machine").toLowerCase(),
    port: (id) => portName(content, id as PortDefId),
    isSite: (id) => isSite(content, id as PortDefId),
    atSite: () => {
      const travel = state.travel;
      if (travel.stage === "docked") return isSite(content, travel.portId);
      const leaving = travel.stage === "preparingDeparture" || travel.stage === "undocking";
      return isSite(content, leaving ? travel.fromPortId : travel.toPortId);
    },
    item: (id) => {
      const item = state.items[id as keyof ReadonlyWorldState["items"]];
      const def = item === undefined ? undefined : findItemDef(content, state, item.defId);
      const name = def?.name.toLowerCase() ?? "cargo";
      return item?.stacking === "stack" && item.count > 1 ? `${item.count}× ${name}` : name;
    },
    itemDef: (defId) =>
      findItemDef(content, state, defId as Item["defId"])?.name.toLowerCase() ?? "parts",
    faultName: (machineId, faultKey) =>
      machineDef(machineId)
        ?.faults.find((f) => f.key === faultKey)
        ?.name.toLowerCase() ?? humanize(faultKey).toLowerCase(),
    // Symptoms have no display name in content (`{key, channel}`); the key reads well enough.
    symptomName: (_machineId, symptomKey) => humanize(symptomKey).toLowerCase(),
    job: (id) => {
      const job = state.jobs[id as keyof ReadonlyWorldState["jobs"]];
      if (job === undefined) return undefined;
      return {
        issuer: job.issuer,
        name: job.issuerPerson.name,
        to: content.ports[job.toPortId]?.name ?? job.toPortId,
        passenger: job.passage !== undefined,
      };
    },
  };
}

/** The key of the room `actorId` stands in on the ship's deck, if any. */
function roomOfActor(
  state: ReadonlyWorldState,
  content: ContentBundle,
  actorId: Actor["id"],
): string | undefined {
  const location = state.actors[actorId]?.location;
  if (location?.kind !== "onDeck") return undefined;
  const deck = content.decks[location.deckId];
  const symbol = deck?.tiles[Math.floor(location.y)]?.[Math.floor(location.x)];
  return deck?.compartments.find((c) => c.symbol === symbol)?.key;
}

function subjectNames(event: SimEvent, n: Names): string[] {
  return event.subjectIds
    .map((id) => n.actor(id) ?? n.machine(id) ?? null)
    .filter((name): name is string => name !== null);
}

/** Specific ticker line, or `null` when the event is not worth a line. */
function specificLine(event: SimEvent, n: Names): string | null | undefined {
  const who = n.actor(event.subjectIds[0] ?? "") ?? "Someone";
  switch (event.type) {
    case "conversation":
      return event.payload.line;
    case "needThresholdCrossed": {
      if (!event.payload.rising) return null;
      const words = NEED_WORDS[event.payload.need];
      if (words === undefined) return null;
      return `${who} ${event.significance === "notable" ? words[1] : words[0]}`;
    }
    case "fellAsleep":
      return `${who} fell asleep`;
    case "faultOccurred":
      return `${n.machine(event.payload.machineId) ?? "A machine"}: ${n.faultName(event.payload.machineId, event.payload.faultKey)}`;
    case "faultObserved":
      return `${who} noticed ${n.symptomName(event.payload.machineId, event.payload.symptomKey)} from the ${n.machineLower(event.payload.machineId)}`;
    case "faultDiagnosed":
      return `Diagnosed the ${n.machineLower(event.payload.machineId)}: ${n.faultName(event.payload.machineId, event.payload.faultKey)}`;
    case "faultRepaired":
      return `${n.machine(event.payload.machineId) ?? "Machine"} repaired`;
    case "machineDerated": {
      const name = n.machine(event.payload.machineId) ?? "A machine";
      const pct = Math.round(event.payload.output * 100);
      return pct <= 0
        ? `${name} down (${event.payload.cause})`
        : `${name} at ${pct}% (${event.payload.cause})`;
    }
    case "breakerTripped":
      return "A breaker tripped";
    case "taskCompleted": {
      const haul = event.payload.haul;
      if (haul === undefined) return null;
      const worker = n.actor(event.subjectIds[2] ?? "") ?? "The crew";
      return haul.to === "ship"
        ? `${worker} stowed ${n.item(haul.itemId)} aboard`
        : `${worker} carried ${n.item(haul.itemId)} ashore`;
    }
    case "travelStageChanged":
      return (
        (n.atSite() ? SITE_STAGE_LINES[event.payload.to] : undefined) ??
        STAGE_LINES[event.payload.to] ??
        null
      );
    case "departed":
      return n.isSite(event.payload.fromPortId)
        ? `Lifted off from ${n.port(event.payload.fromPortId)} for ${n.port(event.payload.toPortId)}`
        : `Left ${n.port(event.payload.fromPortId)} for ${n.port(event.payload.toPortId)}`;
    case "arrived":
      return n.isSite(event.payload.portId)
        ? `Set down at ${n.port(event.payload.portId)}`
        : `Docked at ${n.port(event.payload.portId)}`;
    case "driftingChanged":
      return event.payload.drifting ? "Engines down: drifting" : "Engines back: under way again";
    case "shipLimping": {
      const { machineId, faultKey, itemDefId, need, speedFraction } = event.payload;
      const what = need === "tool" ? "No" : "Not enough";
      return `${what} ${n.itemDef(itemDefId)} aboard to fix the ${n.machineLower(machineId)}'s ${n.faultName(machineId, faultKey)}: limping on at ${Math.round(speedFraction * 100)}% speed`;
    }
    case "departureHeld":
      return `Holding for repairs to the ${n.machineLower(event.payload.machineId)}`;
    case "departureRiskAccepted":
      return `Leaving with the ${n.machineLower(event.payload.machineId)} as it is`;
    case "departureHoldLifted":
      return `Repairs done: departing for ${n.port(event.payload.toPortId)}`;
    case "departureRepairOutOfReach": {
      const { machineId, faultKey, itemDefId, need, portId } = event.payload;
      const machine = n.machineLower(machineId);
      const what = need === "tool" ? "No" : "Not enough";
      return `${what} ${n.itemDef(itemDefId)} aboard and none to be had at ${n.port(portId)}: leaving with the ${machine}'s ${n.faultName(machineId, faultKey)} unrepaired`;
    }
    case "broughtAboard":
      return `The dock crew brought ${event.payload.name} back aboard at ${n.port(event.payload.portId)}`;
    case "leftOnDock": {
      // A site keeps nothing: the item is gone by the time the line is read, so name its def.
      const { itemId, defId, portId } = event.payload;
      if (n.isSite(portId)) return `Left ${n.itemDef(defId)} behind at ${n.port(portId)}`;
      return `Left ${n.item(itemId)} on the dock at ${n.port(portId)}`;
    }
    case "dockAmbience":
      return event.payload.line;
    case "lookingForWork":
      return `${event.payload.name} is ashore looking for work`;
    case "talkingWith":
      return `${event.payload.name} is talking with ${event.payload.withName}`;
    case "wentToSee":
      return `${event.payload.name} went out through the gate to see ${event.payload.withName}`;
    case "cameToSee":
      return event.payload.fromGate
        ? `${event.payload.name} came in through the gate to see the captain`
        : `${event.payload.name} is coming over to the ship`;
    case "gearBroughtAboard":
      return `The dock crew handed ${n.item(event.payload.itemId)} aboard at ${n.port(event.payload.portId)}`;
    case "jobOffered": {
      const job = n.job(event.payload.jobId);
      if (job === undefined) return "A job is on offer";
      const errand = n.errand(event.payload.jobId);
      if (errand !== undefined) {
        const how = errand.kind === "fetchPerson" ? "brought back" : "fetched";
        return `${job.name} wants ${errand.target} ${how} from ${errand.site}`;
      }
      return job.passenger
        ? `${job.name} wants passage to ${job.to}`
        : `${job.issuer} has freight for ${job.to}`;
    }
    case "jobAccepted": {
      const job = n.job(event.payload.jobId);
      return job === undefined ? "Took the job" : `Took the job for ${job.issuer}`;
    }
    case "jobDeclined":
      return "Passed on the job";
    case "contractCompleted": {
      const job = n.job(event.payload.jobId);
      if (job === undefined) return "Delivery complete";
      // Expeditions A2: an errand's captive rides as its passage, but the job is the issuer's.
      const errand = n.errand(event.payload.jobId);
      if (errand !== undefined) return `Brought ${errand.target} back for ${job.name}`;
      return job.passenger ? `${job.name}'s fare is paid` : `Delivered for ${job.issuer}`;
    }
    case "jobFailed":
      return jobFailedLine(event, n);
    case "passengerBoarded":
      return `${event.payload.name} came aboard`;
    case "passengerAshore":
      return `${event.payload.name} went ashore at ${n.port(event.payload.portId)}`;
    case "passengerReturned":
      return `${event.payload.name} is back aboard`;
    case "passageEnded": {
      const { name, reason, portId } = event.payload;
      const port = n.port(portId);
      return PASSAGE_END_LINES[reason](name, port);
    }
    case "paymentMade":
      return `Paid ${event.payload.amount} cr`;
    case "transacted":
      return transactedLine(event);
    case "partsBought": {
      const { count, itemDefId, portId, cost } = event.payload;
      const what = `${count > 1 ? `${count}× ` : ""}${n.itemDef(itemDefId)}`;
      return `Bought ${what} at ${n.port(portId)} (${cost} cr)`;
    }
    case "decisionResolved":
      return null;
    // §tried-sides: the roll shows in the aftermath and the card that follows; the number stays the
    // narrator's to say. A refused failure lever is the narrator's bookkeeping.
    case "attemptRolled":
    case "failLeverRefused":
      return null;
    case "bell": {
      const key = event.payload.sectionKey;
      return key === undefined ? "Bell." : `Bell. ${sectionName(key)} section has the watch.`;
    }
    case "helmRelieved": {
      const by = n.actor(event.payload.byActorId) ?? "Someone";
      const fromId = event.payload.fromActorId;
      const from = fromId === undefined ? undefined : (n.actor(fromId) ?? "someone");
      return from === undefined ? `${by} takes the helm` : `${by} relieves ${from} at the helm`;
    }
    case "helmUnattended":
      return "Nobody at the helm";
    case "mealServed": {
      const { cookId, servings, quality } = event.payload;
      const cook = n.actor(cookId) ?? "The cook";
      const what = quality === "poor" ? "a poor dinner" : "dinner";
      return `${cook} served ${what}: ${servings} hot meal${servings === 1 ? "" : "s"}`;
    }
    case "mealMissed":
      return "No hot meal this watch";
    case "provisionsLow": {
      const days = event.payload.days;
      const left =
        days < 0.75
          ? "less than a day left"
          : `about ${days < 1.5 ? "a day" : `${Math.round(days)} days`} left`;
      return `Provisions are running low: ${left}`;
    }
    case "roomDirty":
      return `${n.roomCap(event.payload.key)} is dirty`;
    case "roomFilthy":
      return `${n.roomCap(event.payload.key)} is filthy`;
    case "roomCleaned":
      return `${n.actor(event.payload.byActorId) ?? "Someone"} mopped ${n.room(event.payload.key)}`;
    case "coursePlotted":
      return `Course plotted for ${n.port(event.payload.toPortId)}`;
    case "navHazard":
      return navHazardLine(event, n);
    // Slice 4 (call 18): the ticker says who won and little else.
    case "sessionStarted": {
      const { memberIds, activityId, compartmentId } = event.payload;
      const who = nameList(memberIds.map((id) => n.actor(id) ?? "someone"));
      const verb = memberIds.length === 1 ? "is" : "are";
      return `${who} ${verb} ${n.activityLabel(activityId)} in ${n.compartment(compartmentId)}`;
    }
    case "sessionEnded":
      return sessionEndedLine(event, n);
    case "rivalryStreak": {
      const { winnerId, loserId, activityId, streak } = event.payload;
      return `${n.actor(winnerId) ?? "Someone"} has beaten ${n.actor(loserId) ?? "someone"} ${timesRunning(streak)} at ${n.activityNoun(activityId)}`;
    }
    case "tookAKnock":
      return `${n.actor(event.payload.actorId) ?? "Someone"} took a knock ${n.activityLabel(event.payload.activityId)}`;
    case "treatsBaked":
      return `${n.actor(event.payload.cookId) ?? "Someone"} baked a tray of treats`;
    case "argument": {
      // A debate's: the `sessionEnded` line carries it. §memory-levers: a falling-out's own line.
      if (!("over" in event.payload)) return null;
      const { aId, bId, over } = event.payload;
      return `${n.actor(aId) ?? "Someone"} and ${n.actor(bId) ?? "someone"} have fallen out over ${over}`;
    }
    case "memoryPlanted":
    case "thoughtGiven":
      // §memory-levers: a feeling is a card's to show, never the log's.
      return null;
    case "privateTalkCalled": {
      const { captainId, actorId } = event.payload;
      return `${n.actor(captainId) ?? "The captain"} asked ${n.actor(actorId) ?? "someone"} for a word in ${n.cabinOf(captainId)}`;
    }
    case "privateTalkHeld":
      return `${n.actor(event.payload.captainId) ?? "The captain"} had a word with ${n.actor(event.payload.actorId) ?? "someone"}`;
    case "privateTalkMissed":
      return `${n.actor(event.payload.actorId) ?? "Someone"} never made it to ${n.cabinOf(event.payload.captainId)}`;
    default:
      return fieldLine(event, n);
  }
}

/**
 * Slice 5 (§sighting-and-the-alert, §reporting-damage): the asteroid field's lines: the rocks, the
 * alert, the crew's answer and the intercom. `undefined` for any other event (the generic line).
 */
function fieldLine(event: SimEvent, n: Names): string | null | undefined {
  switch (event.type) {
    case "fieldSighted":
      return `${n.actor(event.payload.standerId) ?? "The helm"}: rocks ahead`;
    case "fieldEntered":
      // A sighted field's first hit is the impact's own line.
      return event.payload.noticedBefore ? null : "The ship shudders: we're in rocks";
    case "asteroidImpact":
      return impactLine(event, n);
    case "machineKnockedOut":
      return capitalise(`the ${n.machineLower(event.payload.machineId)} is out`);
    case "nearMiss":
      return `A rock came through ${n.compartment(event.payload.compartmentId)} a step from ${n.actor(event.payload.actorId) ?? "someone"}`;
    case "alertRaised":
      return "General alert";
    case "alertCleared":
      return "Alert stood down";
    case "shipStuck":
      return "Engines out: we're stuck in the rocks";
    case "shipUnstuck":
      return "Engines back: under way again";
    case "fieldCleared": {
      const { how, integrity, max } = event.payload;
      const head = how === "drifted" ? "Drifted clear of the rocks" : "Clear of the rocks";
      return `${head}: hull at ${Math.round(integrity)} of ${max}`;
    }
    case "shipLost":
      return "The hull gave way. The ship is lost.";
    case "scoutSent":
      return `${n.actor(event.payload.officerId) ?? "The officer of the watch"} sent ${n.actor(event.payload.scoutId) ?? "someone"} to check ${n.compartment(event.payload.compartmentId)}`;
    case "hullPatched":
      return `${n.actor(event.payload.actorId) ?? "Someone"} patched the hull in ${n.compartment(event.payload.compartmentId)}`;
    case "hullPlated":
      return `${n.actor(event.payload.actorId) ?? "Someone"} plated the hull in ${n.compartment(event.payload.compartmentId)}`;
    case "machineMended":
      return `${n.actor(event.payload.actorId) ?? "Someone"} repaired the ${n.machineLower(event.payload.machineId)}`;
    case "intercomReport":
      return intercomLine(event, n);
    default:
      return expeditionLine(event, n);
  }
}

const COUNT_WORDS = ["no one", "one", "two", "three", "four", "five", "six", "seven", "eight"];

/** "four", for a ticker line; digits past eight. */
function countWord(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

/** Expeditions A1 (§8.6): where a wound landed, for "is hit in the leg". */
const PART_WORDS: Readonly<Record<BodyPart, string>> = {
  head: "the head",
  torso: "the body",
  leftArm: "the arm",
  rightArm: "the arm",
  leftLeg: "the leg",
  rightLeg: "the leg",
};

/**
 * Expeditions A1 (§8.6): the fight's lines: the party going down the ramp, contact, hits, people
 * going down, breaking and dying, the pull-back and the end. `undefined` for any other event.
 */
function expeditionLine(event: SimEvent, n: Names): string | null | undefined {
  switch (event.type) {
    // The party goes down the ramp once it is armed, not when the ship sets down: on a landing
    // nobody moves until the arrival card's plan is chosen, and the plan picks the party again.
    // The landing has its own line ("Set down at Harrow End"), so the start has none.
    case "expeditionStarted":
      return null;
    // §unseen-odds: the roll shows in what the fight does (contact at once, or none), and in the
    // end's line; the number stays the narrator's to say on the card.
    case "unseenRolled":
      return null;
    case "partyMustered": {
      const [leaderId] = event.payload.party;
      if (leaderId === undefined) return null;
      const leader = n.actor(leaderId) ?? "The captain";
      const others = event.payload.party.length - 1;
      return others === 0
        ? `${leader} goes down the ramp alone`
        : `${leader} takes ${countWord(others)} down the ramp`;
    }
    case "expeditionContact":
      return `Shots at ${midSentence(n.port(event.payload.siteId))}`;
    case "shotFired":
      return null;
    case "accident":
      // §accidents-aboard: the configured line, with who and the machine filled in.
      return capitalise(event.payload.how);
    case "struck":
      // §strike-lever: off the fight the narrator's line is the news; in it, the fight's lines are.
      return event.payload.inFight ? null : capitalise(event.payload.how);
    case "wounded": {
      // §strike-lever: the narrator's strike off the fight was told by its `struck` line.
      if (event.payload.narrated === true) return null;
      const who = n.actor(event.payload.actorId) ?? "Someone";
      if (event.payload.type === "stun") return `${who} is stunned`;
      return n.isCrew(event.payload.actorId)
        ? `${who} is hit in ${PART_WORDS[event.payload.part]}`
        : `${who} is hit`;
    }
    case "incapacitated":
      return `${n.actor(event.payload.actorId) ?? "Someone"} is down`;
    case "died":
      return `${n.actor(event.payload.actorId) ?? "Someone"} is dead`;
    case "woundHealed":
      return null;
    case "woundTreated":
      return treatedLine(event, n);
    case "casualtyCarried":
      // §extraction: "Bettina Ruiz carries Priya Kessler to the medbay".
      return `${n.actor(event.payload.byActorId) ?? "Someone"} carries ${
        n.actor(event.payload.actorId) ?? "someone"
      } to the medbay`;
    case "executed":
      return `${n.actor(event.payload.byActorId) ?? "The party"} executes ${event.payload.name}`;
    case "combatantBroke": {
      const who = n.actor(event.payload.actorId) ?? "Someone";
      if (event.payload.how === "surrendered") return `${who} gives up`;
      return event.payload.side === "us"
        ? `${who} runs for the ship`
        : `${who} runs for ${n.siteExit()}`;
    }
    case "partyWithdrew":
      return "The party pulls back to the ramp";
    case "expeditionResolved":
      return resolvedLine(event, n);
    default:
      return undefined;
  }
}

/** §treatment-at-the-medbay-bed: a treated wound's part, as the possessive names it. */
const TREATED_PART_WORDS: Readonly<Record<BodyPart, string>> = {
  head: "head",
  torso: "chest",
  leftArm: "arm",
  rightArm: "arm",
  leftLeg: "leg",
  rightLeg: "leg",
};

/** §treatment-at-the-medbay-bed: "Oyelaran Abiodun treats Priya Kessler's leg and arm". */
function treatedLine(event: Extract<SimEvent, { type: "woundTreated" }>, n: Names): string {
  const { actorId, byActorId, parts } = event.payload;
  const medic = n.actor(byActorId) ?? "Someone";
  const patient = n.actor(actorId) ?? "someone";
  const words = [...new Set(parts.map((part) => TREATED_PART_WORDS[part]))];
  const what = words.length === 0 ? "wounds" : nameList(words);
  return `${medic} treats ${patient}'s ${what}`;
}

/**
 * "Corran Vale taken; two of ours hurt", "Corran Vale got away", and the rest; D105 adds how the
 * site noticed us when the narrator marked the arrival card ("; they were waiting for us", or
 * "; nobody saw us" while no shot was fired).
 */
function resolvedLine(event: Extract<SimEvent, { type: "expeditionResolved" }>, n: Names): string {
  return `${resolvedHead(event, n)}${noticeSuffix(event)}`;
}

function noticeSuffix(event: Extract<SimEvent, { type: "expeditionResolved" }>): string {
  const { notice, shots } = event.payload;
  if (notice === "seen") return "; they were waiting for us";
  // Unseen, contact comes only from our own first shot: with none fired, nobody saw us at all.
  if (notice === "unseen" && shots === 0) return "; nobody saw us";
  return "";
}

function resolvedHead(event: Extract<SimEvent, { type: "expeditionResolved" }>, n: Names): string {
  const { outcome, targetName, hurtUs, deadUs, siteId } = event.payload;
  const target = targetName ?? "The target";
  switch (outcome) {
    case "targetTaken": {
      const cost =
        deadUs > 0
          ? `; ${countWord(deadUs)} of ours dead`
          : hurtUs > 0
            ? `; ${countWord(hurtUs)} of ours hurt`
            : "";
      return `${target} taken${cost}`;
    }
    case "targetFled":
      return `${target} got away`;
    case "partyRouted":
      return "The party is driven back to the ship";
    case "partyWithdrew":
      return `The party came back without ${targetName ?? "the target"}`;
    case "timedOut":
      return `The fight at ${midSentence(n.port(siteId))} peters out`;
  }
}

/**
 * Expeditions A2: "The job for Ysolde Maren is lost: Corran Vale got away", "... the party came
 * back without Corran Vale", "... Corran Vale was put off" (the name table has no pronouns).
 */
/**
 * §money-levers: "Paid Harbourmaster Osei 200 cr: the gate fine", "Received 500 cr from Ysolde
 * Maren: a reward"; with no counterparty, "Paid 200 cr: ..." and "Received 500 cr: ...".
 */
function transactedLine(event: Extract<SimEvent, { type: "transacted" }>): string {
  const { amount, memo, counterparty } = event.payload;
  const sum = `${Math.abs(amount)} cr`;
  const head =
    amount < 0
      ? `Paid ${counterparty === "" ? sum : `${counterparty} ${sum}`}`
      : `Received ${sum}${counterparty === "" ? "" : ` from ${counterparty}`}`;
  return `${head}: ${memo}`;
}

function jobFailedLine(event: Extract<SimEvent, { type: "jobFailed" }>, n: Names): string {
  const { jobId, outcome } = event.payload;
  const job = n.job(jobId);
  const errand = n.errand(jobId);
  const head = `The job for ${job?.name ?? "the client"} is lost`;
  const target = errand?.target ?? job?.name ?? "the passenger";
  switch (outcome) {
    case "failed":
      return errand?.targetFled === true
        ? `${head}: ${target} got away`
        : `${head}: the party came back without ${target}`;
    case "putOff":
      return `${head}: ${target} was put off`;
    case "leftBehind":
      return `${head}: ${target} was left behind`;
    // A success never fails a job; the line still reads.
    case "broughtAlive":
    case "broughtDead":
    case "broughtItem":
    case "completed":
      return head;
  }
}

/** "Docked at Crossroads Hub" → "docked at Crossroads Hub": only the first letter goes down. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** "The Boathouse" → "the Boathouse": a place's name as it reads mid-sentence. */
function midSentence(name: string): string {
  return name.replace(/^The /, "the ");
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "Rock strike in the galley; the galley stove took it", or null when it hit no machine. */
function impactLine(event: Extract<SimEvent, { type: "asteroidImpact" }>, n: Names): string | null {
  const struck = event.payload.hits.filter((hit) => hit.effect !== "none");
  if (struck.length === 0) return null;
  const machines = nameList(struck.map((hit) => `the ${n.machineLower(hit.machineId)}`));
  return `Rock strike in ${n.compartment(event.payload.compartmentId)}; ${machines} took it`;
}

/** "Bettina Solheim on the intercom: the galley's hit, the galley stove's out". */
function intercomLine(event: Extract<SimEvent, { type: "intercomReport" }>, n: Names): string {
  const who = n.actor(event.payload.actorId) ?? "Someone";
  const parts = event.payload.damage.map((damage) =>
    damage.kind === "scar"
      ? `${n.compartment(damage.compartmentId)}'s hit`
      : `the ${n.machineLower(damage.machineId)}'s ${damage.out ? "out" : "damaged"}`,
  );
  const said =
    parts.length === 0
      ? `no damage in ${n.compartment(event.payload.compartmentId)}`
      : [...new Set(parts)].join(", ");
  return `${who} on the intercom: ${said}`;
}

/** "Jax", "Jax and Tomas", "Jax, Tomas and Dane". */
function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "Nobody";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const TIMES_WORDS = ["", "once", "twice", "three times", "four times", "five times", "six times"];

/** "three times running", for a rivalry's streak. */
function timesRunning(streak: number): string {
  const runs = Math.abs(streak);
  return `${TIMES_WORDS[runs] ?? `${runs} times`} running`;
}

/**
 * Slice 4: a session's end. A contest says who won, a debate whether it was an argument or a
 * spirited talk and about what, a performance who played; a bond, nothing, or an abandoned game
 * makes no line.
 */
function sessionEndedLine(
  event: Extract<SimEvent, { type: "sessionEnded" }>,
  n: Names,
): string | null {
  const { outcome, activityId, memberIds, winnerId, topicId, argued } = event.payload;
  switch (outcome) {
    case "contest":
      return winnerId === undefined
        ? null
        : `${n.actor(winnerId) ?? "Someone"} won at ${n.activityNoun(activityId)}`;
    case "debate": {
      const who = nameList(memberIds.map((id) => n.actor(id) ?? "someone"));
      const about = topicId === undefined ? "" : ` about ${n.topic(topicId)}`;
      return argued === true ? `${who} argued${about}` : `${who} had a spirited talk${about}`;
    }
    case "perform": {
      const [performerId] = memberIds;
      if (performerId === undefined) return null;
      return `${n.actor(performerId) ?? "Someone"} ${n.performed(performerId, activityId)}`;
    }
    case "bond":
    case "none":
    case "abandoned":
      return null;
  }
}

/** The event type humanized, followed by the names of its actor and machine subjects. */
function genericLine(event: SimEvent, n: Names): string {
  const names = subjectNames(event, n);
  const head = humanize(event.type);
  return names.length === 0 ? head : `${head}: ${names.join(", ")}`;
}

/** One-line ticker text for an event: a specific human line where one exists, else generic. */
export function describeEvent(
  event: SimEvent,
  state: ReadonlyWorldState,
  content: ContentBundle,
): string {
  const n = namer(state, content);
  return specificLine(event, n) ?? genericLine(event, n);
}

/** Ticker text, or `null` for an event the ticker should skip. */
export function tickerLine(
  event: SimEvent,
  state: ReadonlyWorldState,
  content: ContentBundle,
): string | null {
  if (!isTickerEvent(event)) return null;
  const n = namer(state, content);
  const line = specificLine(event, n);
  return line === null ? null : (line ?? genericLine(event, n));
}

// ---------------------------------------------------------------------------------------------
// Items aboard (Polish A, §rooms-items-and-cargo)
// ---------------------------------------------------------------------------------------------

function itemKind(def: DeepReadonly<ItemDef> | undefined): RenderItemKind {
  if (def === undefined) return "other";
  if (def.cargoClass !== undefined || def.tags.includes("cargo")) return "crate";
  if (def.tags.includes("tool")) return "tool";
  if (def.tags.includes("food")) return "food";
  return "other";
}

/** Containment is acyclic (invariant), but a bad save must not hang the renderer. */
const MAX_CONTAINER_DEPTH = 8;

/**
 * Where an item physically is, through containers and the hands holding it: an on-deck point
 * (the deck or the dock), a port store, or `undefined` for anything else (installed, lost, or a
 * containment chain too deep to trust).
 */
function physicalLocation(
  item: DeepReadonly<Item>,
  state: ReadonlyWorldState,
): DeepReadonly<PhysicalLocation> | undefined {
  let location: DeepReadonly<PhysicalLocation> = item.location;
  for (let depth = 0; depth < MAX_CONTAINER_DEPTH; depth++) {
    switch (location.kind) {
      case "onDeck":
      case "inExternalStore":
        return location;
      case "carriedBy":
      case "equippedBy": {
        const holder = state.actors[location.actorId];
        if (holder === undefined) return undefined;
        location = holder.location;
        break;
      }
      case "inContainer": {
        const container = state.items[location.containerId];
        if (container === undefined) return undefined;
        location = container.location;
        break;
      }
      default:
        return undefined;
    }
  }
  return undefined;
}

/**
 * Is this item on the map: on the deck or the dock alongside, carried, or inside something that
 * is?
 */
function isOnMap(item: DeepReadonly<Item>, state: ReadonlyWorldState): boolean {
  return physicalLocation(item, state)?.kind === "onDeck";
}

/** §living-on-the-dock: is this item aboard the ship, i.e. on the map and not on the dock? */
function isAboardShip(
  item: DeepReadonly<Item>,
  state: ReadonlyWorldState,
  content: ContentBundle,
): boolean {
  const location = physicalLocation(item, state);
  return location?.kind === "onDeck" && !isOnDock(content, state, location);
}

function renderItemLocation(
  item: DeepReadonly<Item>,
  state: ReadonlyWorldState,
  content: ContentBundle,
): RenderItemLocation | null {
  const location = item.location;
  switch (location.kind) {
    case "onDeck":
      return {
        kind: "deck",
        deckId: location.deckId,
        x: location.x,
        y: location.y,
        onDock: isOnDock(content, state, location),
      };
    case "carriedBy":
    case "equippedBy":
      return { kind: "carried", actorId: location.actorId };
    case "inContainer":
      return { kind: "container", containerId: location.containerId };
    default:
      return null;
  }
}

/**
 * Items on the map, for the canvas: aboard, and on the dock alongside (§living-on-the-dock).
 * Port-store and installed items are left out.
 */
export function renderItems(state: ReadonlyWorldState, content: ContentBundle): RenderItem[] {
  const items: RenderItem[] = [];
  for (const item of Object.values(state.items)) {
    const location = renderItemLocation(item, state, content);
    if (location === null || !isOnMap(item, state)) continue;
    const def = findItemDef(content, state, item.defId);
    items.push({
      id: item.id,
      defId: item.defId,
      name: def?.name ?? "Cargo",
      kind: itemKind(def),
      ...(def?.cargoClass === undefined ? {} : { cargoClass: def.cargoClass }),
      ...(item.jobId === undefined ? {} : { jobId: item.jobId }),
      ...(isNobodysFreight(state, item) ? { offered: true as const } : {}),
      location,
      count: item.stacking === "stack" ? item.count : 1,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------------------------
// Ship headline (Polish A, §the-ship-headline)
// ---------------------------------------------------------------------------------------------

function portName(content: ContentBundle, portId: PortDefId): string {
  return content.ports[portId]?.name ?? portId;
}

/** "34 s", "2 min 05 s". Sim seconds, rounded up so it never reads "0 s" while under way. */
export function formatEta(seconds: number): string {
  const total = Math.max(1, Math.ceil(seconds));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  return `${minutes} min ${(total % 60).toString().padStart(2, "0")} s`;
}

/** Mean engine output, as travel's propulsion factor (no engines = unconstrained). */
function engineFactor(state: ReadonlyWorldState, content: ContentBundle): number {
  const engines = Object.values(state.machines).filter((m) =>
    (content.machines[m.defId]?.tags ?? []).includes("engine"),
  );
  if (engines.length === 0) return 1;
  const sum = engines.reduce((acc, m) => acc + (m.actualMode === "on" ? m.output : 0), 0);
  return sum / engines.length;
}

interface FreightCount {
  readonly done: number;
  readonly total: number;
}

/**
 * Is this item in someone's hands, directly or in a container they hold (a crate on the hand
 * truck being pushed is not stowed yet, §hand-truck-trips)?
 */
function inHands(item: DeepReadonly<Item>, state: ReadonlyWorldState): boolean {
  let location: DeepReadonly<PhysicalLocation> = item.location;
  for (let depth = 0; depth < MAX_CONTAINER_DEPTH; depth++) {
    if (location.kind === "carriedBy" || location.kind === "equippedBy") return true;
    if (location.kind !== "inContainer") return false;
    const container = state.items[location.containerId];
    if (container === undefined) return false;
    location = container.location;
  }
  return false;
}

/**
 * Progress over the manifests of the jobs with open `kind` problems, in units (a stack of two
 * crates is two): stowed aboard, set down rather than in someone's hands (load), or no longer
 * aboard (unload). §living-on-the-dock: freight on the dock is not aboard, whether it lies there or
 * someone standing there holds it. `undefined` when no such problem is open.
 */
function freightProgress(
  state: ReadonlyWorldState,
  content: ContentBundle,
  kind: "cargoToLoad" | "cargoToUnload",
): FreightCount | undefined {
  const jobIds = new Set<JobId>();
  for (const problem of Object.values(state.work.problems)) {
    if (problem.kind === kind && problem.status === "open") jobIds.add(problem.payload.jobId);
  }
  if (jobIds.size === 0) return undefined;
  let done = 0;
  let total = 0;
  for (const jobId of jobIds) {
    const job = state.jobs[jobId];
    if (job === undefined) continue;
    const units = job.cargo.reduce((sum, line) => sum + line.count, 0);
    total += units;
    let stowed = 0;
    let aboard = 0;
    for (const itemId of job.cargoItemIds) {
      const item = state.items[itemId];
      if (item === undefined) continue;
      const count = item.stacking === "stack" ? item.count : 1;
      const onShip = isAboardShip(item, state, content);
      if (onShip && !inHands(item, state)) stowed += count;
      if (onShip) aboard += count;
    }
    done += kind === "cargoToLoad" ? stowed : Math.max(0, units - aboard);
  }
  return { done: Math.min(done, total), total };
}

function crates(n: number): string {
  return n === 1 ? "crate" : "crates";
}

function loadingLine(count: FreightCount): string {
  return `loading cargo (${count.done} of ${count.total} ${crates(count.total)} aboard)`;
}

function hasOpenProblem(state: ReadonlyWorldState, kind: ProblemKind): boolean {
  return Object.values(state.work.problems).some((p) => p.kind === kind && p.status === "open");
}

/**
 * §helm-vacancy: the helm is empty while its watch is wanted. The watch post is open for the whole
 * of underway, so an open `stationToStaff` problem no longer means nobody is at the helm; the
 * watch system's vacancy mark does.
 */
function helmWaiting(state: ReadonlyWorldState): boolean {
  return state.watch.helm.unattendedSinceTick !== undefined;
}

/**
 * Passengers §3.3: the name of the passenger the docked ship is waiting for: one ashore at this
 * port whose passage is still live, or one walking down the ramp. Mirrors `systems/travel`
 * `waitingForPassenger` (core may not import systems).
 */
function passengerAshoreHere(state: ReadonlyWorldState): string | undefined {
  const travel = state.travel;
  if (travel.stage !== "docked") return undefined;
  for (const job of Object.values(state.jobs)) {
    const passage = job.passage;
    if (passage === undefined) continue;
    const actor = state.actors[passage.actorId];
    if (actor?.disembarking === true) return actor.name;
    if (passage.leg !== "ashore" || passage.endReason !== undefined) continue;
    if (job.toPortId !== travel.portId) continue;
    return actor?.name ?? job.issuerPerson.name;
  }
  return undefined;
}

/**
 * §calling-the-crew-aboard: the name of someone on the dock while departure prep waits for them to
 * come aboard (the lowest actor id, so the line is stable). A passenger walking off is not waited
 * for here. Mirrors `systems/travel/ashore.ts` (core may not import systems).
 */
function awaitedAboard(state: ReadonlyWorldState, content: ContentBundle): string | undefined {
  if (state.deck.dock === undefined) return undefined;
  const ashore = Object.values(state.actors)
    .filter((a) => a.disembarking !== true && isOnDock(content, state, a.location))
    .sort(byId);
  return ashore[0]?.name;
}

/**
 * §calling-the-crew-aboard: departure prep's clock has run out but a ramp is still coming up (or
 * cannot).
 */
function waitingOnRamps(state: ReadonlyWorldState): boolean {
  const travel = state.travel;
  if (travel.stage !== "preparingDeparture" || travel.stageProgress < 1) return false;
  return Object.values(state.doors).some((d) => d.kind === "ramp" && d.physicalState !== "closed");
}

/**
 * §looking-for-work: the captain ashore, for the headline: "Mara Osei is ashore looking for work",
 * and on the way to (or with) someone a held card names, "Mara Osei is talking with Fenwick Adair"
 * (the activity's own label, `systems/work/labels.ts`). Undefined when nobody is.
 */
function captainAshoreLine(state: ReadonlyWorldState): string | undefined {
  for (const actor of Object.values(state.actors)) {
    const activity = actor.activity;
    if (activity.kind !== "personal") continue;
    if (activity.activity === "lookForWork") return `${actor.name} is ashore looking for work`;
    const label = activity.label;
    if (activity.activity !== "meetSpeaker" || label === undefined) continue;
    if (/^(talking with|going to see|ashore to see) /.test(label))
      return `${actor.name} is ${label}`;
  }
  return undefined;
}

/**
 * One plain-language line of what the ship is doing (§the-ship-headline), derived from travel
 * stage, open freight problems and the job board. Pure; cheap enough to compute every frame.
 */
export function shipHeadline(
  state: ReadonlyWorldState,
  content: ContentBundle,
  speeds: Pick<ConfigDef["travel"], "nominalSpeed" | "limpSpeedFraction">,
): string {
  const travel = state.travel;
  if (travel.stage === "docked") {
    // Expeditions A1 (§3.1): a landing site is set down on, and has no work to look for.
    const site = isSite(content, travel.portId);
    const here = `${site ? "Set down at" : "Docked at"} ${portName(content, travel.portId)}`;
    // §looking-for-work: the captain ashore is the moment to watch; the freight count comes back
    // after.
    const ashore = captainAshoreLine(state);
    if (ashore !== undefined) return `${here} — ${ashore}`;
    const unloading = freightProgress(state, content, "cargoToUnload");
    if (unloading !== undefined) {
      return `${here} — unloading cargo (${unloading.done} of ${unloading.total} ${crates(unloading.total)} ashore)`;
    }
    const loading = freightProgress(state, content, "cargoToLoad");
    if (loading !== undefined) return `${here} — ${loadingLine(loading)}`;
    const awaited = passengerAshoreHere(state);
    if (awaited !== undefined) return `Waiting for ${awaited} — ${lowerFirst(here)}`;
    const voyage = travel.voyageDestinationId;
    // Expeditions A2 (§3.5): a site is never a stop on the way; the ship lifts off from it.
    const bound = voyage ?? travel.plannedDestinationId;
    if (site && bound !== undefined && bound !== travel.portId) {
      return `${here} — lifting off for ${portName(content, bound)}`;
    }
    // §voyages: a waypoint is a stop on the way, whether or not the next hop is planned yet; the
    // port a job in hand starts from is not one (the ship has not left it yet).
    const atOrigin = Object.values(state.jobs).some(
      (job) => job.status === "accepted" && job.fromPortId === travel.portId,
    );
    if (voyage !== undefined && voyage !== travel.portId && !atOrigin) {
      const stop = `Stopping at ${portName(content, travel.portId)} on the way to ${portName(content, voyage)}`;
      return travel.holdForRepairs === true ? `${stop} — holding for repairs` : stop;
    }
    if (travel.plannedDestinationId !== undefined) {
      const hop = portName(content, travel.plannedDestinationId);
      const to =
        voyage !== undefined && voyage !== travel.plannedDestinationId
          ? `${hop}, bound for ${portName(content, voyage)}`
          : hop;
      if (travel.holdForRepairs === true) {
        return `${here} — holding for repairs before departing for ${to}`;
      }
      // §course-plotting: the course is travel's open `courseToPlot` until someone plots it.
      return hasOpenProblem(state, "courseToPlot")
        ? `Preparing to depart for ${to} — waiting on a course`
        : `Preparing to depart for ${to}`;
    }
    // Offers are the card's story to tell, not the headline's (§the-ship-headline): the headline
    // only says what the ship is doing.
    return site ? here : `${here} — looking for work`;
  }

  const to = portName(content, travel.toPortId);
  // Expeditions A2 (§3.3, §3.5): a ship sets down at a site and lifts off from one.
  const fromSite = isSite(content, travel.fromPortId);
  const toSite = isSite(content, travel.toPortId);
  switch (travel.stage) {
    case "preparingDeparture": {
      if (travel.holdForRepairs === true) return `Holding for repairs before departing for ${to}`;
      const loading = freightProgress(state, content, "cargoToLoad");
      if (loading !== undefined) return `Preparing to depart for ${to} — ${loadingLine(loading)}`;
      const ashore = awaitedAboard(state, content);
      if (ashore !== undefined) {
        return `Waiting for ${ashore} to come aboard — preparing to depart for ${to}`;
      }
      if (helmWaiting(state)) {
        return `Preparing to depart for ${to} — waiting for someone at the helm`;
      }
      if (waitingOnRamps(state)) return `Preparing to depart for ${to} — raising the ramps`;
      return `Preparing to depart for ${to}`;
    }
    case "undocking":
    case "departing": {
      const from = portName(content, travel.fromPortId);
      if (fromSite) return `Lifting off from ${from} — bound for ${to}`;
      return travel.stage === "undocking"
        ? `Undocking from ${from} — bound for ${to}`
        : `Departing ${from} for ${to}`;
    }
    case "transit": {
      const remaining = Math.max(0, travel.routeDistance - travel.routeProgress);
      if (travel.limping === true) {
        // §limping: the engine is down and nothing aboard can fix it; the engineer coaxes it along.
        const crawl = speeds.nominalSpeed * speeds.limpSpeedFraction;
        return `Limping on to ${to} on a crippled engine — ${formatEta(remaining / crawl)}`;
      }
      const speed = speeds.nominalSpeed * engineFactor(state, content);
      if (travel.drifting || speed <= 0) return `Adrift on the way to ${to} — engines down`;
      const voyage = travel.voyageDestinationId;
      const leg =
        voyage === undefined || voyage === travel.toPortId
          ? `Under way to ${to}`
          : `Under way to ${to}, bound for ${portName(content, voyage)}`;
      return `${leg} — ${formatEta(remaining / speed)}`;
    }
    case "approaching":
      return toSite ? `Setting down at ${to}` : `Approaching ${to}`;
    case "docking": {
      const arriving = toSite ? `Setting down at ${to}` : `Docking at ${to}`;
      return helmWaiting(state) ? `${arriving} — waiting for someone at the helm` : arriving;
    }
  }
}

/**
 * Dockside §2.2: the renderer's view of travel. While docked both port ids are the dock's port, so
 * every stage names two ports and the scenery never has to ask which one is meant.
 */
export function renderTravel(travel: DeepReadonly<TravelState>): RenderTravel {
  if (travel.stage === "docked") {
    return {
      state: "docked",
      progress: 0,
      fromPortId: travel.portId,
      toPortId: travel.portId,
      drifting: false,
    };
  }
  const progress =
    travel.stage === "transit"
      ? travel.routeDistance > 0
        ? travel.routeProgress / travel.routeDistance
        : 0
      : travel.stageProgress;
  return {
    state: travel.stage,
    progress,
    fromPortId: travel.fromPortId,
    toPortId: travel.toPortId,
    drifting: travel.drifting,
  };
}

/** §dock-drawing: 0 shut to 1 open; a jammed door is impassable, so it reads shut. */
export function doorOpenFraction(door: Pick<Door, "physicalState" | "transitionProgress">): number {
  switch (door.physicalState) {
    case "open":
      return 1;
    case "opening":
      return door.transitionProgress;
    case "closing":
      return 1 - door.transitionProgress;
    case "closed":
    case "jammed":
      return 0;
  }
}

/** §locals-table: the locals on the dock alongside, in id order. */
function renderLocals(state: ReadonlyWorldState): RenderLocal[] {
  return Object.values(state.dockside.locals)
    .sort(byId)
    .map((local) => ({
      id: local.id,
      name: local.name,
      role: local.role,
      deckId: local.location.deckId,
      x: local.location.x,
      y: local.location.y,
      facing: local.facing,
      lookSeed: local.lookSeed,
      postKey: local.postKey,
      ...(local.label === undefined ? {} : { label: local.label }),
      ...(local.look === undefined ? {} : { look: local.look }),
      carrying: local.carrying.length,
    }));
}

/** §staging-plan-dressing: the staging plan's props on the dock alongside. */
function renderDockProps(state: ReadonlyWorldState, content: ContentBundle): RenderDockProp[] {
  const deckId = state.deck.dock?.deckId;
  if (deckId === undefined) return [];
  return state.dockside.props.map((prop) => {
    const def = findItemDef(content, state, prop.itemDefId);
    return {
      defId: prop.itemDefId,
      name: def?.name ?? "Crate",
      kind: itemKind(def),
      ...(def?.cargoClass === undefined ? {} : { cargoClass: def.cargoClass }),
      count: prop.count,
      deckId,
      x: prop.tile.x + 0.5,
      y: prop.tile.y + 0.5,
    };
  });
}

/**
 * §dirt-grid: the ship deck's dirt grid at the current tick (`WorldState.dirt.cells` as bytes), for
 * the renderer's grime tint. Throws if the state has no ship deck or the deck no cells, which world
 * creation and the migration rule out.
 */
export function getDirtFrame(world: World): DirtFrame {
  const { state, content } = world;
  const deckIds = Object.keys(state.deck.tiles);
  const [deckId] = deckIds;
  if (deckId === undefined || deckIds.length !== 1) {
    throw new Error(`getDirtFrame: expected one ship deck, found ${deckIds.length}`);
  }
  const deck = content.decks[deckId as keyof ContentBundle["decks"]];
  const cells = state.dirt.cells[deckId as keyof typeof state.dirt.cells];
  if (deck === undefined || cells === undefined) {
    throw new Error(`getDirtFrame: deck ${deckId} has no dirt cells`);
  }
  return {
    tick: state.tick,
    deckId: deck.id,
    width: deck.width,
    height: deck.height,
    cells: Uint8Array.from(cells),
    tiers: { ...state.dirt.tiers },
  };
}

// ---------------------------------------------------------------------------------------------
// Group sessions (slice 4, call 17)
// ---------------------------------------------------------------------------------------------

/**
 * A placement offset rotated clockwise by `rotation` (the spatial system's `rotateOffset`, which
 * core may not import).
 */
function rotated(offset: TileCoord, rotation: 0 | 90 | 180 | 270): TileCoord {
  switch (rotation) {
    case 0:
      return offset;
    case 90:
      return { x: -offset.y + 0, y: offset.x + 0 };
    case 180:
      return { x: -offset.x + 0, y: -offset.y + 0 };
    case 270:
      return { x: offset.y + 0, y: -offset.x + 0 };
  }
}

/** The centre (tile units) of a set of tiles, or undefined for none. */
function centreOf(tiles: readonly TileCoord[]): { x: number; y: number } | undefined {
  if (tiles.length === 0) return undefined;
  const sum = tiles.reduce((acc, t) => ({ x: acc.x + t.x + 0.5, y: acc.y + t.y + 0.5 }), {
    x: 0,
    y: 0,
  });
  return { x: sum.x / tiles.length, y: sum.y / tiles.length };
}

/** The tiles a session's venue covers: the machine's footprint, the zone, or the room. */
function venueTiles(
  state: ReadonlyWorldState,
  content: ContentBundle,
  venue: DeepReadonly<SessionVenue>,
): TileCoord[] {
  const compartment = state.compartments[venue.compartmentId];
  const deck = compartment === undefined ? undefined : content.decks[compartment.deckId];
  if (compartment === undefined || deck === undefined) return [];
  if ("machineId" in venue) {
    const machine = state.machines[venue.machineId];
    const placement = deck.machines.find((p) => p.key === machine?.placementKey);
    const def = machine === undefined ? undefined : content.machines[machine.defId];
    if (placement === undefined || def === undefined) return [];
    return def.footprint.map((offset) => {
      const r = rotated(offset, placement.rotation);
      return { x: placement.origin.x + r.x, y: placement.origin.y + r.y };
    });
  }
  if ("zoneKey" in venue) {
    return [...(deck.zones.find((z) => z.key === venue.zoneKey)?.tiles ?? [])];
  }
  const symbol = deck.compartments.find((c) => c.key === compartment.key)?.symbol;
  const tiles: TileCoord[] = [];
  deck.tiles.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === symbol) tiles.push({ x, y });
  });
  return tiles;
}

/** One plate per open or running session, at its venue's centre. */
export function renderSessions(state: ReadonlyWorldState, content: ContentBundle): RenderSession[] {
  const out: RenderSession[] = [];
  for (const session of Object.values(state.social.sessions)) {
    const def = content.activities[session.activityId];
    const at = centreOf(venueTiles(state, content, session.venue));
    if (def === undefined || at === undefined) continue;
    const running = session.startedTick !== undefined;
    out.push({
      id: session.id,
      activityId: session.activityId,
      label: running ? def.label : def.waitingLabel,
      x: at.x,
      y: at.y,
      memberIds: [...session.members],
      running,
    });
  }
  return out;
}

/** §hull-scars-and-ship-loss: the hull bar and its scars. */
export function renderHull(state: ReadonlyWorldState): RenderHull {
  const hull = state.hull;
  return {
    integrity: hull.integrity,
    max: hull.max,
    scars: hull.scars.map((scar) => ({
      id: scar.id,
      x: scar.tile.x,
      y: scar.tile.y,
      patched: scar.patched,
      rock: scar.rock,
    })),
    lost: hull.lostAtTick !== undefined,
  };
}

/**
 * §sighting-and-the-alert: the field as the rock layers see it: `near` in transit within
 * `field.warningSeconds` of its start, `active` while the ship is in it, `clearing` once it ended
 * and the alert still stands; undefined otherwise (call 16).
 */
export function renderField(state: ReadonlyWorldState, config: ConfigDef): RenderField | undefined {
  const field = state.field;
  if (field === undefined) return undefined;
  const { severity, phase } = field;
  switch (phase.kind) {
    case "scheduled": {
      const warning = configTicks(config, config.field.warningSeconds);
      const near = state.travel.stage === "transit" && state.tick >= field.startsAtTick - warning;
      return near ? { phase: "near", severity, stuck: false } : undefined;
    }
    case "active":
      return { phase: "active", severity, stuck: phase.stuckSinceTick !== undefined };
    case "ended":
      return state.alert === undefined ? undefined : { phase: "clearing", severity, stuck: false };
  }
}

/** §rock-impacts: an impact for the flash, from its event. */
function renderImpact(event: Extract<SimEvent, { type: "asteroidImpact" }>): RenderImpact {
  const { tile, rock, tiles } = event.payload;
  return { tick: event.tick, x: tile.x, y: tile.y, rock, tiles: tiles.map((t) => ({ ...t })) };
}

/** Expeditions A1 (§8.6): a shot for the tracer, from where shooter and target stand now. */
function renderShot(
  event: Extract<SimEvent, { type: "shotFired" }>,
  state: ReadonlyWorldState,
): RenderShot | undefined {
  const at = (id: Actor["id"]) => {
    let location = state.actors[id]?.location;
    if (location?.kind === "carriedBy") location = state.actors[location.actorId]?.location;
    return location?.kind === "onDeck" ? location : undefined;
  };
  const from = at(event.payload.byActorId);
  const to = at(event.payload.atActorId);
  if (from === undefined || to === undefined) return undefined;
  return {
    tick: event.tick,
    fromX: from.x,
    fromY: from.y,
    toX: to.x,
    toY: to.y,
    hit: event.payload.hit,
  };
}

/**
 * Expeditions A1 (§8.6): one word for a side: `done` when nobody on it can fight, `breaking` when
 * anyone breaks, `shaky` when anyone wavers, else `steady` (also before anyone is in it). Only
 * those who fight count: the target and a bystander have no morale ladder of their own.
 */
function sideWord(state: ReadonlyWorldState, side: "us" | "them"): SideWord {
  const onSide = Object.values(state.actors).flatMap((actor) =>
    actor.combatant?.side === side ? [actor.combatant] : [],
  );
  if (onSide.length === 0) return "steady";
  const states = onSide
    .filter((c) => side === "us" || c.disposition.part === "guard" || c.disposition.part === "ally")
    .map((c) => c.state);
  const fighting = states.filter((s) => s === "steady" || s === "wavering" || s === "breaking");
  if (fighting.length === 0) return "done";
  if (fighting.includes("breaking")) return "breaking";
  if (fighting.includes("wavering")) return "shaky";
  return "steady";
}

/** Expeditions A1 (§8.6): the expedition for the HUD, while its site is alongside. */
export function renderExpedition(
  state: ReadonlyWorldState,
  content: ContentBundle,
): RenderExpedition | undefined {
  const expedition = state.expedition;
  if (expedition === undefined) return undefined;
  if (siteOf(content, state)?.dock.portId !== expedition.siteId) return undefined;
  // Before contact nobody is in the fight yet: a shaky cast member starts out wavering, and the
  // header would give that away behind the arrival card (§the-shore-header).
  if (expedition.fightStartedTick === undefined) {
    return { phase: expedition.phase, us: "steady", them: "steady" };
  }
  return { phase: expedition.phase, us: sideWord(state, "us"), them: sideWord(state, "them") };
}

export function getRenderFrame(world: World): RenderFrame {
  const { state, content } = world;
  const actors = Object.values(state.actors).flatMap(
    (actor) => renderActor(actor, state, content) ?? [],
  );
  const machines: RenderMachine[] = Object.values(state.machines).map((machine) => ({
    id: machine.id,
    state: machineState(machine, content, world.config.values),
    temperatureNorm: machine.temperature,
    deckId: machine.deckId,
    placementKey: machine.placementKey,
  }));
  const tickerEvents: TickerEntry[] = [];
  const impacts: RenderImpact[] = [];
  const shots: RenderShot[] = [];
  for (const event of world.caches.diagnostics.lastEvents) {
    if (event.type === "asteroidImpact") impacts.push(renderImpact(event));
    if (event.type === "shotFired") {
      const shot = renderShot(event, state);
      if (shot !== undefined) shots.push(shot);
    }
    const text = tickerLine(event, state, content);
    if (text !== null) {
      tickerEvents.push({ tick: event.tick, text, significance: event.significance });
    }
  }
  const field = renderField(state, world.config.values);
  const expedition = renderExpedition(state, content);
  const presence = state.deck.dock;
  const dock: RenderDock | undefined =
    presence === undefined ? undefined : { dockId: presence.dockId, deckId: presence.deckId };
  return {
    tick: state.tick,
    actors,
    machines,
    doors: Object.values(state.doors).map((door) => ({
      id: door.id,
      physicalState: door.physicalState,
      openFraction: doorOpenFraction(door),
      deckId: door.deckId,
      placementKey: door.placementKey,
    })),
    travel: renderTravel(state.travel),
    tickerEvents,
    money: state.money.balance,
    items: renderItems(state, content),
    ...(dock === undefined ? {} : { dock }),
    locals: renderLocals(state),
    dockProps: renderDockProps(state, content),
    headline: shipHeadline(state, content, world.config.values.travel),
    sessions: renderSessions(state, content),
    hull: renderHull(state),
    alert: state.alert !== undefined,
    ...(field === undefined ? {} : { field }),
    impacts,
    shots,
    ...(expedition === undefined ? {} : { expedition }),
  };
}
