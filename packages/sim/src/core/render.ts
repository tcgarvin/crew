/**
 * Generic render projection (D7: the map shows truth). Fills `RenderFrame` from state: actor
 * positions and action labels, machine and door states, travel progress, money, and the ticker.
 * Polish A adds the items aboard (D28) and a one-line ship headline (D27). D61 adds the dock
 * alongside, with everyone and everything on it flagged `onDock`.
 */
import { isOnDock } from "./docks";
import { isNobodysFreight } from "./freight";
import type { Actor } from "./types/actor";
import type { DeepReadonly, PhysicalLocation } from "./types/common";
import type { ConfigDef, ContentBundle, ItemDef } from "./types/content";
import type { SimEvent } from "./types/events";
import type { JobId, PortDefId } from "./types/ids";
import type { World } from "./types/kernel";
import type { ReadonlyWorldState } from "./types/pipeline";
import type { Door, Item, Machine } from "./types/ship";
import type { PassageEndReason, TravelState } from "./types/travel";
import type {
  RenderActor,
  RenderDock,
  RenderDockProp,
  RenderFrame,
  RenderItem,
  RenderItemKind,
  RenderItemLocation,
  RenderLocal,
  RenderMachine,
  RenderMachineState,
  RenderTravel,
  TickerEntry,
} from "./types/view";
import type { ActionKind } from "./types/work";

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
};

/** Short present-tense label for an actor: "repairing coolant pump", "sleeping", "walking". */
export function actionLabel(
  actor: DeepReadonly<Actor>,
  state: ReadonlyWorldState,
  content: ContentBundle,
): string {
  if (actor.availability === "dead") return "dead";
  if (actor.availability === "incapacitated") return "incapacitated";
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
  // D35: a machine blocked by an inoperable fault or low integrity (at the config threshold, not
  // only at 0) reads "failed" even though equipment has switched it off.
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
]);

/** Notable events whose information another ticker line already carries. */
const TICKER_HIDDEN: ReadonlySet<SimEvent["type"]> = new Set([
  "problemRaised",
  "problemResolved",
  "decisionPending",
  "commandRejected",
  "invariantViolated",
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
  port(id: string): string;
  item(id: string): string;
  itemDef(defId: string): string;
  faultName(machineId: string, faultKey: string): string;
  symptomName(machineId: string, symptomKey: string): string;
  job(id: string): { issuer: string; name: string; to: string; passenger: boolean } | undefined;
};

function namer(state: ReadonlyWorldState, content: ContentBundle): Names {
  const machineDef = (id: string) => {
    const machine = state.machines[id as Machine["id"]];
    return machine === undefined ? undefined : content.machines[machine.defId];
  };
  return {
    actor: (id) => state.actors[id as Actor["id"]]?.name,
    machine: (id) => machineDef(id)?.name,
    port: (id) => content.ports[id as keyof ContentBundle["ports"]]?.name ?? id,
    item: (id) => {
      const item = state.items[id as keyof ReadonlyWorldState["items"]];
      const def =
        item === undefined
          ? undefined
          : (content.items[item.defId] ?? state.defs.dynamic.items[item.defId]);
      const name = def?.name.toLowerCase() ?? "cargo";
      return item?.stacking === "stack" && item.count > 1 ? `${item.count}× ${name}` : name;
    },
    itemDef: (defId) =>
      (
        content.items[defId as keyof ContentBundle["items"]] ??
        state.defs.dynamic.items[defId as keyof ReadonlyWorldState["defs"]["dynamic"]["items"]]
      )?.name.toLowerCase() ?? "parts",
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
      return `${who} noticed ${n.symptomName(event.payload.machineId, event.payload.symptomKey)} from the ${(n.machine(event.payload.machineId) ?? "machine").toLowerCase()}`;
    case "faultDiagnosed":
      return `Diagnosed the ${(n.machine(event.payload.machineId) ?? "machine").toLowerCase()}: ${n.faultName(event.payload.machineId, event.payload.faultKey)}`;
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
      return STAGE_LINES[event.payload.to] ?? null;
    case "departed":
      return `Left ${n.port(event.payload.fromPortId)} for ${n.port(event.payload.toPortId)}`;
    case "arrived":
      return `Docked at ${n.port(event.payload.portId)}`;
    case "driftingChanged":
      return event.payload.drifting ? "Engines down: drifting" : "Engines back: under way again";
    case "departureHeld":
      return `Holding for repairs to the ${(n.machine(event.payload.machineId) ?? "machine").toLowerCase()}`;
    case "departureRiskAccepted":
      return `Leaving with the ${(n.machine(event.payload.machineId) ?? "machine").toLowerCase()} as it is`;
    case "departureHoldLifted":
      return `Repairs done: departing for ${n.port(event.payload.toPortId)}`;
    case "broughtAboard":
      return `The dock crew brought ${event.payload.name} back aboard at ${n.port(event.payload.portId)}`;
    case "leftOnDock":
      return `Left ${n.item(event.payload.itemId)} on the dock at ${n.port(event.payload.portId)}`;
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
      return job.passenger ? `${job.name}'s fare is paid` : `Delivered for ${job.issuer}`;
    }
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
    case "partsBought": {
      const { count, itemDefId, portId, cost } = event.payload;
      const what = `${count > 1 ? `${count}× ` : ""}${n.itemDef(itemDefId)}`;
      return `Bought ${what} at ${n.port(portId)} (${cost} cr)`;
    }
    case "decisionResolved":
      return null;
    default:
      return undefined;
  }
}

/** One-line ticker text for an event: a specific human line where one exists, else generic. */
export function describeEvent(
  event: SimEvent,
  state: ReadonlyWorldState,
  content: ContentBundle,
): string {
  const n = namer(state, content);
  const line = specificLine(event, n);
  if (typeof line === "string") return line;
  const names = subjectNames(event, n);
  const head = humanize(event.type);
  return names.length === 0 ? head : `${head}: ${names.join(", ")}`;
}

/** Ticker text, or `null` for an event the ticker should skip. */
export function tickerLine(
  event: SimEvent,
  state: ReadonlyWorldState,
  content: ContentBundle,
): string | null {
  if (!isTickerEvent(event)) return null;
  const line = specificLine(event, namer(state, content));
  if (line === null) return null;
  return describeEvent(event, state, content);
}

// ---------------------------------------------------------------------------------------------
// Items aboard (Polish A, D28)
// ---------------------------------------------------------------------------------------------

function itemDef(
  item: Pick<DeepReadonly<Item>, "defId">,
  state: ReadonlyWorldState,
  content: ContentBundle,
): DeepReadonly<ItemDef> | undefined {
  return content.items[item.defId] ?? state.defs.dynamic.items[item.defId];
}

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
 * is? (D61: before the dock existed this was "aboard"; the dock is now on the map too.)
 */
function isOnMap(item: DeepReadonly<Item>, state: ReadonlyWorldState): boolean {
  return physicalLocation(item, state)?.kind === "onDeck";
}

/** D61: is this item aboard the ship, i.e. on the map and not on the dock? */
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
 * Items on the map, for the canvas: aboard, and (D61) on the dock alongside. Port-store and
 * installed items are left out.
 */
export function renderItems(state: ReadonlyWorldState, content: ContentBundle): RenderItem[] {
  const items: RenderItem[] = [];
  for (const item of Object.values(state.items)) {
    const location = renderItemLocation(item, state, content);
    if (location === null || !isOnMap(item, state)) continue;
    const def = itemDef(item, state, content);
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
// Ship headline (Polish A, D27)
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
 * Is this item in someone's hands, directly or in a container they hold (D65: a crate on the hand
 * truck being pushed is not stowed yet)?
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
 * aboard (unload). D61: freight on the dock is not aboard, whether it lies there or someone
 * standing there holds it. `undefined` when no such problem is open.
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

function hasOpenProblem(state: ReadonlyWorldState, kind: "stationToStaff"): boolean {
  return Object.values(state.work.problems).some((p) => p.kind === kind && p.status === "open");
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
 * D61: the name of someone on the dock while departure prep waits for them to come aboard (the
 * lowest actor id, so the line is stable). A passenger walking off is not waited for here.
 * Mirrors `systems/travel/ashore.ts` (core may not import systems).
 */
function awaitedAboard(state: ReadonlyWorldState, content: ContentBundle): string | undefined {
  if (state.deck.dock === undefined) return undefined;
  const ashore = Object.values(state.actors)
    .filter((a) => a.disembarking !== true && isOnDock(content, state, a.location))
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  return ashore[0]?.name;
}

/** D61: departure prep's clock has run out but a ramp is still coming up (or cannot). */
function waitingOnRamps(state: ReadonlyWorldState): boolean {
  const travel = state.travel;
  if (travel.stage !== "preparingDeparture" || travel.stageProgress < 1) return false;
  return Object.values(state.doors).some((d) => d.kind === "ramp" && d.physicalState !== "closed");
}

/**
 * D70: the captain ashore, for the headline: "Mara Osei is ashore looking for work", and on the
 * way to (or with) someone a held card names, "Mara Osei is talking with Fenwick Adair" (the
 * activity's own label, `systems/work/labels.ts`). Undefined when nobody is.
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
 * One plain-language line of what the ship is doing (D27), derived from travel stage, open
 * freight problems and the job board. Pure; cheap enough to compute every frame.
 */
export function shipHeadline(
  state: ReadonlyWorldState,
  content: ContentBundle,
  nominalSpeed: number,
): string {
  const travel = state.travel;
  if (travel.stage === "docked") {
    const here = `Docked at ${portName(content, travel.portId)}`;
    const unloading = freightProgress(state, content, "cargoToUnload");
    if (unloading !== undefined) {
      return `${here} — unloading cargo (${unloading.done} of ${unloading.total} ${crates(unloading.total)} ashore)`;
    }
    const loading = freightProgress(state, content, "cargoToLoad");
    if (loading !== undefined) return `${here} — ${loadingLine(loading)}`;
    const awaited = passengerAshoreHere(state);
    if (awaited !== undefined) return `Waiting for ${awaited} — ${here.toLowerCase()}`;
    const voyage = travel.voyageDestinationId;
    if (voyage !== undefined && voyage !== travel.portId) {
      // §2.3: a waypoint is a stop on the way, whether or not the next hop is planned yet.
      const stop = `Stopping at ${portName(content, travel.portId)} on the way to ${portName(content, voyage)}`;
      return travel.holdForRepairs === true ? `${stop} — holding for repairs` : stop;
    }
    if (travel.plannedDestinationId !== undefined) {
      const to = portName(content, travel.plannedDestinationId);
      return travel.holdForRepairs === true
        ? `${here} — holding for repairs before departing for ${to}`
        : `Preparing to depart for ${to}`;
    }
    const ashore = captainAshoreLine(state);
    if (ashore !== undefined) return `${here} — ${ashore}`;
    // Offers are the card's story to tell, not the headline's (D34): the headline only says what
    // the ship is doing.
    return `${here} — looking for work`;
  }

  const to = portName(content, travel.toPortId);
  switch (travel.stage) {
    case "preparingDeparture": {
      if (travel.holdForRepairs === true) return `Holding for repairs before departing for ${to}`;
      const loading = freightProgress(state, content, "cargoToLoad");
      if (loading !== undefined) return `Preparing to depart for ${to} — ${loadingLine(loading)}`;
      const ashore = awaitedAboard(state, content);
      if (ashore !== undefined) {
        return `Waiting for ${ashore} to come aboard — preparing to depart for ${to}`;
      }
      if (hasOpenProblem(state, "stationToStaff")) {
        return `Preparing to depart for ${to} — waiting for someone at the helm`;
      }
      if (waitingOnRamps(state)) return `Preparing to depart for ${to} — raising the ramps`;
      return `Preparing to depart for ${to}`;
    }
    case "undocking":
      return `Undocking from ${portName(content, travel.fromPortId)} — bound for ${to}`;
    case "departing":
      return `Departing ${portName(content, travel.fromPortId)} for ${to}`;
    case "transit": {
      const speed = nominalSpeed * engineFactor(state, content);
      if (travel.drifting || speed <= 0) return `Adrift on the way to ${to} — engines down`;
      const remaining = Math.max(0, travel.routeDistance - travel.routeProgress);
      const voyage = travel.voyageDestinationId;
      const leg =
        voyage === undefined || voyage === travel.toPortId
          ? `Under way to ${to}`
          : `Under way to ${to}, bound for ${portName(content, voyage)}`;
      return `${leg} — ${formatEta(remaining / speed)}`;
    }
    case "approaching":
      return `Approaching ${to}`;
    case "docking":
      return hasOpenProblem(state, "stationToStaff")
        ? `Docking at ${to} — waiting for someone at the helm`
        : `Docking at ${to}`;
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

/** D58: 0 shut to 1 open; a jammed door is impassable, so it reads shut. */
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

/** D66: the locals on the dock alongside, in id order. */
export function renderLocals(state: ReadonlyWorldState): RenderLocal[] {
  return Object.values(state.dockside.locals)
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }))
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

/** D66: the staging plan's props on the dock alongside. */
export function renderDockProps(
  state: ReadonlyWorldState,
  content: ContentBundle,
): RenderDockProp[] {
  const deckId = state.deck.dock?.deckId;
  if (deckId === undefined) return [];
  return state.dockside.props.map((prop) => {
    const def = itemDef({ defId: prop.itemDefId }, state, content);
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

export function getRenderFrame(world: World): RenderFrame {
  const { state, content } = world;
  const actors: RenderActor[] = [];
  for (const actor of Object.values(state.actors)) {
    const rendered = renderActor(actor, state, content);
    if (rendered !== null) actors.push(rendered);
  }
  const machines: RenderMachine[] = Object.values(state.machines).map((machine) => ({
    id: machine.id,
    state: machineState(machine, content, world.config.values),
    temperatureNorm: machine.temperature,
    deckId: machine.deckId,
    placementKey: machine.placementKey,
  }));
  const tickerEvents: TickerEntry[] = [];
  for (const event of world.caches.diagnostics.lastEvents) {
    const text = tickerLine(event, state, content);
    if (text !== null) {
      tickerEvents.push({ tick: event.tick, text, significance: event.significance });
    }
  }
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
    headline: shipHeadline(state, content, world.config.values.travel.nominalSpeed),
  };
}
