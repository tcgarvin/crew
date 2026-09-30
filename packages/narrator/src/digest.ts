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
  type DeepReadonly,
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

function hookLine(hook: DeepReadonly<NarratorHook>, content: ContentBundle): string {
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
      return `policyDecision: decision ${hook.context.decisionId} needs the captain`;
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
  const actors = Object.values(state.actors)
    .filter((a) => a.crew)
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
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
    const bio = content.crew[actor.defId]?.bio;
    return `- ${actor.name}${roles}${status}: ${actionLabel(actor, state, content)}${where ? ` in ${where}` : ""}; needs: ${needs || "fine"}; good at: ${skills || "nothing in particular"}${bio ? `. ${bio}` : ""}`;
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
      return `- ${j.id} ${j.status} (${j.origin}): ${j.issuer}, ${portName(content, j.fromPortId)} -> ${portName(content, j.toPortId)}, ${cargo}, pays ${j.pay}`;
    });
  return { heading: "Jobs", lines, priority: 7, trimFrom: "end" };
}

function decisionSection(state: State): Section {
  const lines = state.decisions.queue.map((id) => {
    const d = state.decisions.records[id];
    if (d === undefined) return `- ${id} (missing)`;
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
  for (const thread of notes.openThreads) lines.push(`open thread: ${thread}`);
  for (const c of notes.cast) lines.push(`cast: ${c.name}: ${c.note}`);
  for (const r of notes.lastRejections) lines.push(`rejected last time: ${r}`);
  return { heading: "Your notes so far", lines, priority: 5, trimFrom: "end" };
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
    lines: [hook === undefined ? "no hook recorded" : hookLine(hook, content)],
    priority: Number.POSITIVE_INFINITY,
    trimFrom: "end",
  };
  const sections: Section[] = [
    hookSection,
    shipSection(snapshot, content),
    budgetSection(state),
    decisionSection(state),
    machineSection(state, content, snapshot.config.time.tickRate),
    jobSection(state, content),
    crewSection(state, content),
    notesSection(notes),
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
