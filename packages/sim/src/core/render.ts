/**
 * Generic render projection (D7: the map shows truth). Fills `RenderFrame` from state: actor
 * positions and action labels, machine and door states, travel progress, money, and the ticker.
 * Polish A adds the items aboard (D28) and a one-line ship headline (D27).
 */
import type { Actor } from "./types/actor";
import type { DeepReadonly } from "./types/common";
import type { ContentBundle, ItemDef } from "./types/content";
import type { SimEvent } from "./types/events";
import type { JobId, PortDefId } from "./types/ids";
import type { World } from "./types/kernel";
import type { ReadonlyWorldState } from "./types/pipeline";
import type { Item, Machine } from "./types/ship";
import type {
  RenderActor,
  RenderFrame,
  RenderItem,
  RenderItemKind,
  RenderItemLocation,
  RenderMachine,
  RenderMachineState,
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

function machineState(machine: DeepReadonly<Machine>, content: ContentBundle): RenderMachineState {
  if (machine.actualMode === "off") return "off";
  const faultDefs = content.machines[machine.defId]?.faults ?? [];
  const inoperable = machine.faults.some(
    (fault) => faultDefs.find((def) => def.key === fault.faultKey)?.effect.kind === "inoperable",
  );
  if (inoperable || machine.integrity <= 0) return "failed";
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
    facing: actor.facing,
    actionLabel: actionLabel(actor, state, content),
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

type Names = {
  actor(id: string): string | undefined;
  machine(id: string): string | undefined;
  port(id: string): string;
  item(id: string): string;
  faultName(machineId: string, faultKey: string): string;
  symptomName(machineId: string, symptomKey: string): string;
  job(id: string): { issuer: string; to: string } | undefined;
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
        to: content.ports[job.toPortId]?.name ?? job.toPortId,
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
    case "jobOffered": {
      const job = n.job(event.payload.jobId);
      return job === undefined ? "A job is on offer" : `${job.issuer} has freight for ${job.to}`;
    }
    case "jobAccepted": {
      const job = n.job(event.payload.jobId);
      return job === undefined ? "Took the job" : `Took the job for ${job.issuer}`;
    }
    case "jobDeclined":
      return "Passed on the job";
    case "contractCompleted": {
      const job = n.job(event.payload.jobId);
      return job === undefined ? "Delivery complete" : `Delivered for ${job.issuer}`;
    }
    case "paymentMade":
      return `Paid ${event.payload.amount} cr`;
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
  item: DeepReadonly<Item>,
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

/** Is this item physically aboard: on deck, carried, or inside something that is? */
function isAboard(item: DeepReadonly<Item>, state: ReadonlyWorldState): boolean {
  let location = item.location;
  for (let depth = 0; depth < MAX_CONTAINER_DEPTH; depth++) {
    switch (location.kind) {
      case "onDeck":
      case "carriedBy":
      case "equippedBy":
        return true;
      case "inContainer": {
        const container = state.items[location.containerId];
        if (container === undefined) return false;
        location = container.location;
        break;
      }
      default:
        return false;
    }
  }
  return false;
}

function renderItemLocation(item: DeepReadonly<Item>): RenderItemLocation | null {
  const location = item.location;
  switch (location.kind) {
    case "onDeck":
      return { kind: "deck", deckId: location.deckId, x: location.x, y: location.y };
    case "carriedBy":
    case "equippedBy":
      return { kind: "carried", actorId: location.actorId };
    case "inContainer":
      return { kind: "container", containerId: location.containerId };
    default:
      return null;
  }
}

/** Items aboard the ship, for the canvas. Port-store and installed items are left out. */
export function renderItems(state: ReadonlyWorldState, content: ContentBundle): RenderItem[] {
  const items: RenderItem[] = [];
  for (const item of Object.values(state.items)) {
    const location = renderItemLocation(item);
    if (location === null || !isAboard(item, state)) continue;
    const def = itemDef(item, state, content);
    items.push({
      id: item.id,
      defId: item.defId,
      name: def?.name ?? "Cargo",
      kind: itemKind(def),
      ...(def?.cargoClass === undefined ? {} : { cargoClass: def.cargoClass }),
      ...(item.jobId === undefined ? {} : { jobId: item.jobId }),
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
 * Progress over the manifests of the jobs with open `kind` problems, in units (a stack of two
 * crates is two): stowed on deck (load) or no longer aboard (unload). `undefined` when no such
 * problem is open.
 */
function freightProgress(
  state: ReadonlyWorldState,
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
      const where = item.location.kind;
      if (where === "onDeck" || where === "inContainer") stowed += count;
      if (where !== "inExternalStore") aboard += count;
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
    const unloading = freightProgress(state, "cargoToUnload");
    if (unloading !== undefined) {
      return `${here} — unloading cargo (${unloading.done} of ${unloading.total} ${crates(unloading.total)} ashore)`;
    }
    const loading = freightProgress(state, "cargoToLoad");
    if (loading !== undefined) return `${here} — ${loadingLine(loading)}`;
    if (travel.plannedDestinationId !== undefined) {
      return `Preparing to depart for ${portName(content, travel.plannedDestinationId)}`;
    }
    const offer = Object.values(state.jobs).find(
      (job) => job.status === "offered" && job.fromPortId === travel.portId,
    );
    if (offer !== undefined) {
      // The person, not "name, org" (D25); older jobs only have the `issuer` label.
      const who = offer.issuerPerson?.name ?? offer.issuer;
      return `${here} — ${who} is offering freight for ${portName(content, offer.toPortId)}`;
    }
    return `${here} — waiting for work`;
  }

  const to = portName(content, travel.toPortId);
  switch (travel.stage) {
    case "preparingDeparture": {
      const loading = freightProgress(state, "cargoToLoad");
      if (loading !== undefined) return `Preparing to depart for ${to} — ${loadingLine(loading)}`;
      if (hasOpenProblem(state, "stationToStaff")) {
        return `Preparing to depart for ${to} — waiting for someone at the helm`;
      }
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
      return `Under way to ${to} — ${formatEta(remaining / speed)}`;
    }
    case "approaching":
      return `Approaching ${to}`;
    case "docking":
      return hasOpenProblem(state, "stationToStaff")
        ? `Docking at ${to} — waiting for someone at the helm`
        : `Docking at ${to}`;
  }
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
    state: machineState(machine, content),
    temperatureNorm: machine.temperature,
    deckId: machine.deckId,
    placementKey: machine.placementKey,
  }));
  const travel = state.travel;
  const progress =
    travel.stage === "docked"
      ? 0
      : travel.stage === "transit"
        ? travel.routeDistance > 0
          ? travel.routeProgress / travel.routeDistance
          : 0
        : travel.stageProgress;
  const tickerEvents: TickerEntry[] = [];
  for (const event of world.caches.diagnostics.lastEvents) {
    const text = tickerLine(event, state, content);
    if (text !== null) {
      tickerEvents.push({ tick: event.tick, text, significance: event.significance });
    }
  }
  return {
    tick: state.tick,
    actors,
    machines,
    doors: Object.values(state.doors).map((door) => ({
      id: door.id,
      physicalState: door.physicalState,
      deckId: door.deckId,
      placementKey: door.placementKey,
    })),
    travel: { state: travel.stage, progress },
    tickerEvents,
    money: state.money.balance,
    items: renderItems(state, content),
    headline: shipHeadline(state, content, world.config.values.travel.nominalSpeed),
  };
}
