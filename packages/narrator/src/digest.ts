/**
 * Digest projection (PLAN §3): a compact, LLM-readable view of the snapshot for one narrator
 * call. Pure and deterministic: the same inputs give the same text, byte for byte, so it can be
 * diffed in the eval harness and tested.
 *
 * It shows truth (D7: no captain-knowledge filtering in V1), with faults nobody has noticed
 * labelled `[undiscovered]`; the prompt forbids mentioning those in player-facing text.
 */
import {
  type ContentBundle,
  type DecisionId,
  type DeepReadonly,
  type JobIssuer,
  type MachineId,
  type NarratorHook,
  type SimEvent,
  actionLabel,
  describeEvent,
  ticksToSeconds,
} from "@crew/sim";
import {
  type Snapshot,
  type State,
  compartmentNameAt,
  faultDiscovery,
  machineCompartment,
  machineName,
  offerPortNow,
  portName,
} from "./lookups";
import type { NarratorNotes } from "./notes";
import { templateCard } from "./templates";

/** Policy prompt keys whose template text is the card the captain sees (D36 gate; job offers keep their params line). */
const TEMPLATED_PROMPT_KEYS: ReadonlySet<string> = new Set(["travel.departureGate"]);

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

function hookLine(hook: DeepReadonly<NarratorHook>, state: State, content: ContentBundle): string {
  switch (hook.kind) {
    case "approachingPort":
      return `approachingPort: arriving at ${portName(content, hook.context.portId)} (${hook.context.portId}) shortly`;
    case "jobBoard":
      return `jobBoard: docked at ${portName(content, hook.context.portId)} (${hook.context.portId}) with no job offers`;
    case "quietTooLong":
      return `quietTooLong: nothing story-worthy since tick ${hook.context.quietSinceTick}`;
    case "notableEvent":
      return `notableEvent: events ${hook.context.eventIds.join(", ")}`;
    case "policyDecision":
      return policyHookLine(hook, state, content);
  }
}

function shipSection(snapshot: Snapshot, content: ContentBundle): Section {
  const state = snapshot.state;
  const t = state.travel;
  const lines: string[] = [];
  const secs = Math.round(ticksToSeconds(state.tick, snapshot.config.time.tickRate));
  lines.push(`tick ${state.tick} (${secs}s into the game)`);
  if (t.stage === "docked") {
    const planned = t.plannedDestinationId
      ? `; course set for ${portName(content, t.plannedDestinationId)}`
      : "";
    lines.push(`travel: docked at ${portName(content, t.portId)} (${t.portId})${planned}`);
  } else {
    const progress = t.routeDistance > 0 ? t.routeProgress / t.routeDistance : 0;
    lines.push(
      `travel: ${t.stage} ${portName(content, t.fromPortId)} -> ${portName(content, t.toPortId)} (${t.toPortId}), ${pct(progress)} of route${t.drifting ? ", DRIFTING (propulsion lost)" : ""}`,
    );
  }
  lines.push(`money: ${state.money.balance} credits`);
  const offerPort = offerPortNow(state);
  lines.push(
    offerPort === undefined
      ? "job offers possible now: none (not at or approaching a port)"
      : `job offers possible now: fromPort ${offerPort}`,
  );
  return { heading: "Ship", lines, priority: Number.POSITIVE_INFINITY, trimFrom: "end" };
}

function crewSection(state: State, content: ContentBundle): Section {
  const isCaptain = (a: { readonly roleTags: readonly string[] }) => a.roleTags.includes("captain");
  // D41: the captain (the player's avatar) is listed first and never as a speaker.
  const actors = Object.values(state.actors)
    .filter((a) => a.crew)
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
    const loc = actor.location;
    const where =
      loc.kind === "onDeck" ? compartmentNameAt(content, loc.deckId, loc.x, loc.y) : loc.kind;
    const status = actor.availability === "available" ? "" : ` (${actor.availability})`;
    const def = content.crew[actor.defId];
    const bio = def?.bio;
    // D38: the voice line is how this person sounds on every card.
    const voice = def?.voice;
    const doing = `${actionLabel(actor, state, content)}${where ? ` in ${where}` : ""}; needs: ${needs || "fine"}; good at: ${skills || "nothing in particular"}`;
    if (isCaptain(actor)) {
      // D41: the captain's voice is how they come across, for how others react to them.
      return `- ${actor.name}${roles}${status}: this is the captain, the player; never a speaker. ${doing}${bio ? `. ${bio}` : ""}${voice ? ` voice: ${voice}` : ""}`;
    }
    return `- ${actor.name}${roles}${status}: ${doing}${bio ? `. ${bio}` : ""}${voice ? ` voice: ${voice}` : ""}`;
  });
  const npcs = Object.values(state.actors).filter((a) => !a.crew);
  if (npcs.length > 0) {
    lines.push(`- passengers/NPCs: ${npcs.map((a) => a.name).join(", ")}`);
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

function problemSection(state: State): Section {
  const lines = Object.values(state.work.problems)
    .filter((p) => p.status === "open")
    .sort((a, b) => a.createdTick - b.createdTick || a.id.localeCompare(b.id))
    .map((p) => `- ${p.kind} (${p.visibility}) since tick ${p.createdTick}`);
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
      // D24: pay is left out; the model has no use for the amount and must never repeat it.
      return `- ${j.id} ${j.status} (${j.origin}): from ${personLine(j.issuerPerson)}, ${portName(content, j.fromPortId)} -> ${portName(content, j.toPortId)}, ${cargo}`;
    });
  return { heading: "Jobs", lines, priority: 7, trimFrom: "end" };
}

function personLine(person: DeepReadonly<JobIssuer>): string {
  return `${person.name} (${person.org === undefined ? person.role : `${person.role}, ${person.org}`})`;
}

/**
 * D25 / GDD §21: people the captain has already met at the port the ship is at or approaching:
 * the narrator's cast placed there, and whoever offered jobs from there before (the null job
 * source's people too), so the model can bring someone back instead of inventing a stranger.
 */
function peopleSection(snapshot: Snapshot, notes: NarratorNotes, content: ContentBundle): Section {
  const state = snapshot.state;
  const t = state.travel;
  const portId = offerPortNow(state) ?? (t.stage === "docked" ? t.portId : t.toPortId);
  const lines: string[] = [];
  const named = new Set<string>();
  for (const c of notes.cast) {
    if (c.portId !== portId) continue;
    named.add(c.name.toLowerCase());
    const seen = c.lastSeenTick >= 0 ? `; last seen at tick ${c.lastSeenTick}` : "";
    lines.push(`- ${c.name}: ${c.note}${seen}`);
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
      return `- t${c.tick} "${c.title}" (${who}): ${c.gist} → ${chose}`;
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
    lines: [hook === undefined ? "no hook recorded" : hookLine(hook, state, content)],
    priority: Number.POSITIVE_INFINITY,
    trimFrom: "end",
  };
  const sections: Section[] = [
    hookSection,
    shipSection(snapshot, content),
    budgetSection(state),
    decisionSection(state, content),
    machineSection(state, content, snapshot.config.time.tickRate),
    jobSection(state, content),
    crewSection(state, content),
    notesSection(notes),
    cardsSeenSection(notes, hook),
    peopleSection(snapshot, notes, content),
    problemSection(state),
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
