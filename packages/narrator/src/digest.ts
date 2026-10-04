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
  type SimEvent,
  actionLabel,
  configTicks,
  describeEvent,
  effectiveMarket,
  marketBlock,
  ticksToSeconds,
} from "@crew/sim";
import { onDockLines, personLine, stagingDockLines } from "./dockside-digest";
import {
  type Snapshot,
  type State,
  faultDiscovery,
  machineCompartment,
  machineName,
  offerPortNow,
  pathBetween,
  placePhrase,
  portName,
  voyageAhead,
} from "./lookups";
import type { NarratorNotes } from "./notes";
import { templateCard } from "./templates";

/**
 * Policy prompt keys whose template text is the card the captain sees (D36 gate, the passengers
 * §3.3 overdue card; job offers keep their params line).
 */
const TEMPLATED_PROMPT_KEYS: ReadonlySet<string> = new Set([
  "travel.departureGate",
  PASSENGER_OVERDUE_PROMPT_KEY,
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
 * D37: the policy hook line says who brings the card (the template's `speaker`, e.g. the
 * engineer for the departure gate) and which machine it is about, so the model dresses the card
 * in that person's voice rather than picking a messenger of its own.
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
  return said.length === 0 ? base : `${base}: ${said.join("; ")}`;
}

function hookLine(
  hook: DeepReadonly<NarratorHook>,
  events: readonly SimEvent[],
  state: State,
  content: ContentBundle,
): string {
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
    if (voyage !== undefined) {
      const nextLeg = next === "" ? "" : `; next leg to ${next}`;
      return `travel: stopping at ${portName(content, t.portId)} (${t.portId}) on the way to ${portName(content, voyage.destinationId)} (${voyage.destinationId}); ${hopsWord(voyage.hops, voyage.distance)} still to go${nextLeg}; the ship continues on her own once nothing holds her here`;
    }
    const course = next === "" ? "" : `; course set for ${next}`;
    return `travel: docked at ${portName(content, t.portId)} (${t.portId})${course}`;
  }
  const progress = t.routeDistance > 0 ? t.routeProgress / t.routeDistance : 0;
  const drifting = t.drifting ? ", DRIFTING (propulsion lost)" : "";
  return `travel: ${t.stage}, under way ${portName(content, t.fromPortId)} -> ${portName(content, t.toPortId)} (${t.toPortId}), ${pct(progress)} of route${drifting}${bound}`;
}

function shipSection(snapshot: Snapshot, content: ContentBundle): Section {
  const state = snapshot.state;
  const t = state.travel;
  const lines: string[] = [];
  const secs = Math.round(ticksToSeconds(state.tick, snapshot.config.time.tickRate));
  lines.push(`tick ${state.tick} (${secs}s into the game)`);
  lines.push(travelLine(state, content));
  lines.push(`money: ${state.money.balance} credits`);
  if (t.stage === "docked") {
    // D47: what is on sale here, with prices (this is private to the model; cards carry no numbers).
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
      : `job offers possible now: fromPort ${offerPort}`,
  );
  return { heading: "Ship", lines, priority: Number.POSITIVE_INFINITY, trimFrom: "end" };
}

function itemName(content: ContentBundle, itemDefId: string): string {
  return content.items[itemDefId as ItemDefId]?.name ?? itemDefId;
}

/** D47: "Spare Parts x4 at 120 cr, Coolant Canister x3 at 60 cr", or "nothing". */
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

/** D47: why a `partsNeeded` problem is still open, in the words the prompt teaches. */
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

/** D47: appended to the hold line so the model can say why the ship is still here. */
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
 * back (and overdue, once `ashoreSinceTick + overdueSeconds` has passed); while walking off,
 * "going down the ramp".
 */
function aboardLine(
  snapshot: Snapshot,
  content: ContentBundle,
  actor: State["actors"][keyof State["actors"]],
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
        : since + configTicks(config, config.commerce.passage.overdueSeconds);
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
): { readonly actor: State["actors"][keyof State["actors"]]; readonly job: DeepReadonly<Job> }[] {
  const ashore: { actor: State["actors"][keyof State["actors"]]; job: DeepReadonly<Job> }[] = [];
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

function crewSection(snapshot: Snapshot, content: ContentBundle): Section {
  const state = snapshot.state;
  const isCaptain = (a: { readonly roleTags: readonly string[] }) => a.roleTags.includes("captain");
  // D41: the captain (the player's avatar) is listed first and never as a speaker.
  const actors = Object.values(state.actors)
    .filter((a) => a.crew && a.passenger !== true)
    .sort(
      (a, b) =>
        Number(isCaptain(b)) - Number(isCaptain(a)) ||
        a.id.localeCompare(b.id, "en", { numeric: true }),
    );
  const lines = actors.map((actor) => {
    const roles = actor.roleTags.length > 0 ? ` [${actor.roleTags.join(", ")}]` : "";
    const skills = Object.entries(actor.skills)
      .filter(([, level]) => (level ?? 0) >= 3)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([skill, level]) => `${skill} ${level}`)
      .join(", ");
    const needs = (["hunger", "fatigue", "comfort", "social"] as const)
      .map((key) => {
        const word = needWord(actor.needs[key]);
        return word === undefined ? undefined : `${key} ${word}`;
      })
      .filter((n) => n !== undefined)
      .join(", ");
    const where = placePhrase(content, state, actor.location);
    const status = actor.availability === "available" ? "" : ` (${actor.availability})`;
    const def = content.crew[actor.defId];
    const bio = def?.bio;
    // D38: the voice line is how this person sounds on every card.
    const voice = def?.voice;
    const doing = `${actionLabel(actor, state, content)}${where}; needs: ${needs || "fine"}; good at: ${skills || "nothing in particular"}`;
    if (isCaptain(actor)) {
      // D41: the captain's voice is how they come across, for how others react to them.
      return `- ${actor.name}${roles}${status}: this is the captain, the player; never a speaker. ${doing}${bio ? `. ${bio}` : ""}${voice ? ` voice: ${voice}` : ""}`;
    }
    return `- ${actor.name}${roles}${status}: ${doing}${bio ? `. ${bio}` : ""}${voice ? ` voice: ${voice}` : ""}`;
  });
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
  const npcs = Object.values(state.actors).filter((a) => !a.crew);
  if (npcs.length > 0) {
    lines.push(`- NPCs: ${npcs.map((a) => a.name).join(", ")}`);
  }
  return { heading: `Crew (${actors.length})`, lines, priority: 6, trimFrom: "end" };
}

function machineSection(state: State, content: ContentBundle, tickRate: number): Section {
  const machines = Object.values(state.machines).sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true }),
  );
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
  return { heading: "Machines", lines, priority: 8, trimFrom: "end" };
}

function problemLine(p: DeepReadonly<Problem>, state: State, content: ContentBundle): string {
  const base = `- ${p.kind} (${p.visibility}) since tick ${p.createdTick}`;
  if (p.kind !== "partsNeeded") return base;
  // D47: the stalled repair and what would unstick it, so the model can stock a market or tell
  // the story of a part that is not here.
  const machine = state.machines[p.payload.machineId];
  const who = machine === undefined ? p.payload.machineId : machineName(content, machine);
  return `${base}: ${who} needs ${p.payload.count}x ${itemName(content, p.payload.itemDefId)}; ${partsReason(state, content, p.payload.itemDefId)}`;
}

function problemSection(state: State, content: ContentBundle): Section {
  const lines = Object.values(state.work.problems)
    .filter((p) => p.status === "open")
    .sort((a, b) => a.createdTick - b.createdTick || a.id.localeCompare(b.id))
    .map((p) => problemLine(p, state, content));
  return { heading: "Open problems", lines, priority: 4, trimFrom: "end" };
}

function jobSection(state: State, content: ContentBundle): Section {
  const live = new Set(["offered", "accepted", "inTransit", "delivered"]);
  const lines = Object.values(state.jobs)
    .filter((j) => live.has(j.status))
    .sort((a, b) => a.offeredTick - b.offeredTick || a.id.localeCompare(b.id))
    .map((j) => {
      const cargo = j.cargo
        .map((c) => `${c.count}x ${content.items[c.itemDefId]?.name ?? c.itemDefId}`)
        .join(", ");
      // §2.3: a far destination says how far, so the model knows the job is a voyage.
      const path = pathBetween(content, j.fromPortId, j.toPortId);
      const far =
        path === undefined || path.hops <= 1
          ? ""
          : ` (${hopsWord(path.hops, path.distance)} via ${path.path
              .slice(1, -1)
              .map((id) => portName(content, id))
              .join(", ")})`;
      // D24: pay is left out; the model has no use for the amount and must never repeat it.
      // §3.1: a passage says so, with the leg it is on; its cargo line is luggage.
      const passage = j.passage;
      const kind =
        passage === undefined
          ? cargo
          : `${passage.roundTrip ? "round-trip passage" : "one-way passage"} (${passage.endReason ?? `leg ${passage.leg}`})${cargo === "" ? ", no luggage" : `, luggage: ${cargo}`}`;
      return `- ${j.id} ${j.status} (${j.origin}): from ${personLine(j.issuerPerson)}, ${portName(content, j.fromPortId)} -> ${portName(content, j.toPortId)}${far}, ${kind}`;
    });
  return { heading: "Jobs", lines, priority: 7, trimFrom: "end" };
}

/** D63, D67: "On the dock" with a dock alongside; none in flight. */
function dockSections(state: State, content: ContentBundle): Section[] {
  const dock = onDockLines(state, content);
  return dock === undefined ? [] : [{ ...dock, priority: 6, trimFrom: "end" }];
}

/** D67: the staging call's own section, the dock it is dressing; never trimmed. */
function stagingSections(content: ContentBundle, hook: DeepReadonly<NarratorHook>): Section[] {
  if (hook.kind !== "stageDock") return [];
  return [
    {
      ...stagingDockLines(content, hook),
      priority: Number.POSITIVE_INFINITY,
      trimFrom: "end",
    },
  ];
}

/**
 * D25 / GDD §21: people the captain has already met at the port the ship is at or approaching:
 * the narrator's cast placed there, and whoever offered jobs from there before (the null job
 * source's people too), so the model can bring someone back instead of inventing a stranger.
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
  const t = state.travel;
  const portId = offerPortNow(state) ?? (t.stage === "docked" ? t.portId : t.toPortId);
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
  return {
    heading: `People you know here (${portName(content, portId)})`,
    lines,
    priority: 5.5,
    trimFrom: "end",
  };
}

function decisionSection(state: State, content: ContentBundle): Section {
  const lines = state.decisions.queue.map((id) => {
    const d = state.decisions.records[id];
    if (d === undefined) return `- ${id} (missing)`;
    // Template cards (policy decisions) read as the captain will see them, not as key+params,
    // with both sides named so `card` keeps the kernel's left/right order (D37).
    if (d.prompt.prose === undefined && TEMPLATED_PROMPT_KEYS.has(d.prompt.key)) {
      const card = templateCard(d, content);
      const who = card.speaker === undefined ? "" : ` (brought by ${card.speaker})`;
      return `- ${d.id} (${d.origin}): ${card.title}${who}: ${card.situation} Left: "${card.leftLabel}". Right: "${card.rightLabel}".`;
    }
    const prompt = d.prompt.prose ?? `${d.prompt.key} ${JSON.stringify(d.prompt.params)}`;
    return `- ${d.id} (${d.origin}): ${prompt}`;
  });
  return { heading: "Pending decisions", lines, priority: 9, trimFrom: "end" };
}

/**
 * D70: cards held to be delivered in person. They are not on screen yet (not "Pending decisions",
 * not seen), so the model must not treat them as shown; they are this call's card if it has one.
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
  return {
    heading: "Cards on their way to the captain in person",
    lines,
    priority: 9,
    trimFrom: "end",
  };
}

function eventSection(events: readonly SimEvent[], state: State, content: ContentBundle): Section {
  const lines = events
    .filter((e) => e.significance !== "trace")
    .slice(-DIGEST_MAX_EVENTS)
    .map((e) => {
      const payload = JSON.stringify(e.payload);
      const detail = payload.length > 100 ? `${payload.slice(0, 99)}…` : payload;
      return `- t${e.tick} ${describeEvent(e, state as never, content)} ${detail}`;
    });
  return { heading: "Recent events (oldest first)", lines, priority: 3, trimFrom: "start" };
}

function budgetSection(state: State): Section {
  const b = state.narrator.budget;
  return {
    heading: "Your budget",
    lines: [`spawns remaining: ${b.spawnsRemaining}`, `faults remaining: ${b.faultsRemaining}`],
    priority: Number.POSITIVE_INFINITY,
    trimFrom: "end",
  };
}

function notesSection(notes: NarratorNotes): Section {
  const lines: string[] = [];
  lines.push(`summary: ${notes.summary || "(nothing yet: this is the first call)"}`);
  for (const t of notes.threads) {
    const people = t.people.length > 0 ? t.people.join(", ") : "nobody yet";
    const last = t.lastBeatTick === null ? "none yet" : `t${t.lastBeatTick}`;
    // D39: a thread that has had its beat card gets no second one; the next card pays it off.
    const foreshadowed = t.beatCardShown ? " (foreshadowed)" : "";
    lines.push(
      `- [${t.scale}] ${t.title} (${people}): ${t.stage}. Next: ${t.nextBeat || "(none set)"}. Last beat ${last}${foreshadowed}`,
    );
  }
  for (const c of notes.cast) {
    const where = c.portId === null ? "" : ` [at ${c.portId}]`;
    lines.push(`cast: ${c.name}${where}: ${c.note}`);
  }
  for (const r of notes.lastRejections) lines.push(`rejected last time: ${r}`);
  return { heading: "Your notes so far", lines, priority: 5, trimFrom: "end" };
}

/**
 * D31: what the captain actually knows. The captain experiences the story only through the
 * cards, so this list (newest first) is the ground truth for "has the captain seen this?". It
 * outranks the machine list in the trim order.
 */
function cardsSeenSection(
  notes: NarratorNotes,
  hook: DeepReadonly<NarratorHook> | undefined,
): Section {
  // D37: the card this call is dressing has not been shown yet, though its `decisionPending`
  // event has already been folded into the history.
  const pendingId = hook?.kind === "policyDecision" ? hook.context.decisionId : undefined;
  const lines = [...notes.cardsShown]
    .filter((c) => c.decisionId !== pendingId)
    .reverse()
    .map((c) => {
      const who = c.speaker ?? "observed";
      const chose =
        c.chosen === null
          ? "unresolved"
          : `chose "${c.chosen === "left" ? c.leftLabel : c.rightLabel}"`;
      // D56: the thread is retired; this is how the model knows it is finished.
      const closed = c.closedThread === null ? "" : ` (closed thread "${c.closedThread}")`;
      return `- t${c.tick} "${c.title}" (${who}): ${c.gist} → ${chose}${closed}`;
    });
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
  const hookSection: Section = {
    heading: "Why you were called",
    lines: [hook === undefined ? "no hook recorded" : hookLine(hook, recentEvents, state, content)],
    priority: Number.POSITIVE_INFINITY,
    trimFrom: "end",
  };
  // D67: the staging call has no story levers, so it is not shown the story budget.
  const staging = hook?.kind === "stageDock";
  const sections: Section[] = [
    hookSection,
    ...(hook === undefined ? [] : stagingSections(content, hook)),
    shipSection(snapshot, content),
    ...(staging ? [] : [budgetSection(state)]),
    decisionSection(state, content),
    heldSection(state),
    machineSection(state, content, snapshot.config.time.tickRate),
    jobSection(state, content),
    crewSection(snapshot, content),
    notesSection(notes),
    cardsSeenSection(notes, hook),
    peopleSection(snapshot, notes, content),
    ...dockSections(state, content),
    problemSection(state, content),
    eventSection(recentEvents, state, content),
  ];

  let dropped = 0;
  const noteFor = (n: number) =>
    n === 0 ? undefined : `[digest truncated: ${n} lower-priority lines omitted to fit the budget]`;
  let text = render(sections, undefined);
  while (text.length > maxChars) {
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
