/**
 * §notes-turn-tools: the read-only tools the notes turn may call before it writes its notes, over
 * what the server already holds for the call: the snapshot, the stored notes (as the digest showed
 * them) and the request's recent events. Each answers in compact text of bounded size; a bad
 * argument or an unknown name is an answer that says so, never an exception, so the model can try
 * again.
 */
import { type ContentBundle, type PortDefId, type SimEvent, dockAlongside } from "@crew/sim";
import { z } from "zod";
import { cardShownLine, crewLine, eventLine, passengerLine, pastArcLine } from "./digest";
import { onDockLines, personLine } from "./dockside-digest";
import { type Snapshot, portName } from "./lookups";
import { NOTES_LIMITS, type NarratorNotes, PAST_ARC_SCALES, type Thread } from "./notes";
import { atSiteLines } from "./site-digest";
import type { ModelTool } from "./transport";

/** What the tools read. */
export interface NotesToolData {
  readonly snapshot: Snapshot;
  /** The notes as this call's digest showed them. */
  readonly notes: NarratorNotes;
  readonly recentEvents: readonly SimEvent[];
  readonly content: ContentBundle;
}

/** A tool's own answer stays under this, so the loop's cut (`MAX_TOOL_RESULT_CHARS`) rarely bites. */
const ANSWER_CHARS = 1_900;

const norm = (text: string) => text.trim().toLowerCase();

/** Lines in order until the next would pass the budget, and how many were left out. */
function budgetLines(lines: readonly string[]): { readonly kept: string[]; readonly left: number } {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > ANSWER_CHARS) break;
    kept.push(line);
    used += line.length + 1;
  }
  return { kept, left: lines.length - kept.length };
}

/** `budgetLines` as text, ending with a line saying how many were left out, if any. */
function budgetText(lines: readonly string[], more: (left: number) => string): string {
  const { kept, left } = budgetLines(lines);
  return (left === 0 ? kept : [...kept, more(left)]).join("\n");
}

function quoteList(values: readonly string[]): string {
  return values.length === 0 ? "(none)" : values.map((v) => `"${v}"`).join(", ");
}

// ---------------------------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------------------------

/** Models fill an optional argument with "" as often as they leave it out: both mean "any". */
const anyWhenEmpty = <T extends string>(value: T | undefined): Exclude<T, ""> | undefined =>
  value === "" || value === undefined ? undefined : (value as Exclude<T, "">);

const pastArcsArgs = z.strictObject({
  scale: z
    .union([z.enum(PAST_ARC_SCALES), z.literal("")])
    .optional()
    .transform(anyWhenEmpty),
});

function pastArcs(data: NotesToolData, args: z.infer<typeof pastArcsArgs>): string {
  const all = data.notes.pastArcs;
  const arcs = args.scale === undefined ? all : all.filter((a) => a.scale === args.scale);
  const which = args.scale === undefined ? "" : ` at scale ${args.scale}`;
  if (arcs.length === 0) {
    return `No past arcs${which}: ${all.length} have ended this game in all.`;
  }
  const head = `${arcs.length} past arcs${which}, newest first (the notes keep the last ${NOTES_LIMITS.pastArcs}):`;
  return budgetText(
    [head, ...[...arcs].reverse().map(pastArcLine)],
    (left) => `(${left} older not shown: ask by scale)`,
  );
}

const threadArgs = z.strictObject({ title: z.string().min(1) });

function threadText(thread: Thread, data: NotesToolData): string {
  const people = thread.people.length > 0 ? thread.people.join(", ") : "nobody yet";
  const last = thread.lastBeatTick === null ? "none yet" : `t${thread.lastBeatTick}`;
  const beats = (["season", "arc", "episode"] as const).flatMap((tier) =>
    data.notes.plan[tier].beats
      .filter((b) => norm(b.thread) === norm(thread.title))
      .map((b) => `- ${tier} beat "${b.name}" [${b.tension}] ${b.status}: ${b.what}`),
  );
  return [
    `Open thread "${thread.title}" [${thread.scale}], opened t${thread.openedTick}, last beat ${last}${thread.beatCardShown ? ", foreshadowed (its next card pays it off)" : ""}.`,
    `People: ${people}.`,
    `Arc notes: ${thread.arcNotes || "(none)"}`,
    `Next beat: ${thread.nextBeat || "(none set)"}`,
    ...(beats.length === 0 ? ["No beat of your plan names it."] : ["Plan beats:", ...beats]),
  ].join("\n");
}

function thread(data: NotesToolData, args: z.infer<typeof threadArgs>): string {
  const open = data.notes.threads.find((t) => norm(t.title) === norm(args.title));
  if (open !== undefined) return threadText(open, data);
  const ended = data.notes.pastArcs.filter((a) => norm(a.title) === norm(args.title));
  if (ended.length > 0) {
    return [`"${args.title}" has ended:`, ...ended.map(pastArcLine)].join("\n");
  }
  return `No such thread "${args.title}". Open threads: ${quoteList(data.notes.threads.map((t) => t.title))}. Ended ones are under pastArcs.`;
}

const nameArgs = z.strictObject({ name: z.string().min(1) });

/** Who in the ship's company answers to `name` (full name, or one word of it). */
function crewNamed(data: NotesToolData, name: string) {
  const actors = Object.values(data.snapshot.state.actors).filter((a) => a.crew);
  const exact = actors.filter((a) => norm(a.name) === norm(name));
  if (exact.length > 0) return exact;
  return actors.filter((a) => norm(a.name).split(/\s+/).includes(norm(name)));
}

function castMember(data: NotesToolData, args: z.infer<typeof nameArgs>): string {
  const { notes, content, snapshot } = data;
  const key = norm(args.name);
  const lines: string[] = [];
  for (const c of notes.cast.filter((c) => norm(c.name) === key)) {
    const where =
      c.portId === null
        ? "no port (aboard, or nowhere in particular)"
        : portName(content, c.portId);
    const seen = c.lastSeenTick >= 0 ? `, last seen t${c.lastSeenTick}` : "";
    lines.push(`In your cast: ${c.name}, at ${where}${seen}: ${c.note}`);
  }
  for (const port of Object.values(content.ports)) {
    for (const seed of port.castSeed.filter((s) => norm(s.name) === key)) {
      lines.push(`A local at ${port.name} (${port.id}): ${seed.name}, ${seed.role}: ${seed.note}`);
    }
  }
  for (const dock of Object.values(content.docks ?? {})) {
    for (const entry of (dock.defaultCast ?? []).filter((e) => norm(e.name) === key)) {
      lines.push(
        `At the site ${portName(content, dock.portId)} (${dock.portId}) by default: ${entry.name}, ${entry.role}; ${entry.look}`,
      );
    }
  }
  const jobs = Object.values(snapshot.state.jobs)
    .filter((j) => norm(j.issuerPerson.name) === key)
    .sort((a, b) => a.offeredTick - b.offeredTick);
  for (const job of jobs) {
    lines.push(
      `Offered a job at t${job.offeredTick} as ${personLine(job.issuerPerson)}: ${portName(content, job.fromPortId)} to ${portName(content, job.toPortId)}${job.passage === undefined ? "" : " (a passage)"}, ${job.status}.`,
    );
  }
  const threads = notes.threads.filter((t) => t.people.some((p) => norm(p) === key));
  if (threads.length > 0) lines.push(`In open threads: ${quoteList(threads.map((t) => t.title))}.`);
  const arcs = notes.pastArcs.filter((a) => a.people.some((p) => norm(p) === key));
  if (arcs.length > 0) lines.push(`In past arcs: ${quoteList(arcs.map((a) => a.title))}.`);
  const cards = notes.cardsShown.filter((c) => c.speaker !== null && norm(c.speaker) === key);
  if (cards.length > 0) lines.push(`Spoke on cards: ${quoteList(cards.map((c) => c.title))}.`);
  if (lines.length === 0) {
    const crew = crewNamed(data, args.name);
    if (crew.length > 0) {
      return `${crew.map((a) => a.name).join(", ")}: one of the ship's company, not cast; call crew.`;
    }
    return `No such person "${args.name}" in your cast, the ports' locals, the sites or the job issuers. Your cast: ${quoteList(notes.cast.map((c) => c.name))}.`;
  }
  return budgetText(lines, (left) => `(${left} more lines not shown)`);
}

const siteArgs = z.strictObject({ id: z.string().min(1) });

function site(data: NotesToolData, args: z.infer<typeof siteArgs>): string {
  const { content, notes, snapshot } = data;
  const port =
    content.ports[args.id as PortDefId] ??
    Object.values(content.ports).find((p) => norm(p.name) === norm(args.id));
  if (port === undefined) {
    return `No such port or site "${args.id}". Ids: ${Object.keys(content.ports).join(", ")}.`;
  }
  const kind =
    port.kind === "site"
      ? `a landing site${port.nearPortId === undefined ? "" : ` near ${portName(content, port.nearPortId)}`}`
      : `a ${port.setting} port`;
  const lines = [
    `${port.name} (${port.id}), ${kind}: ${port.description}`,
    `The place: ${port.character}`,
  ];
  if (port.castSeed.length > 0) {
    lines.push("Locals:", ...port.castSeed.map((s) => `- ${s.name}, ${s.role}: ${s.note}`));
  }
  const cast = notes.cast.filter((c) => c.portId === port.id);
  if (cast.length > 0) lines.push("Your cast here:", ...cast.map((c) => `- ${c.name}: ${c.note}`));
  const dock = Object.values(content.docks ?? {}).find((d) => d.portId === port.id);
  if (dock !== undefined) {
    lines.push(`Its ${dock.kind === "site" ? "site map" : "dock"}: ${dock.name}. ${dock.ambience}`);
    lines.push(`Posts: ${dock.posts.map((p) => p.name).join("; ")}.`);
    const defaults = dock.defaultCast ?? [];
    if (defaults.length > 0) {
      lines.push(
        "Its people when nobody stages it:",
        ...defaults.map((e) => `- ${e.name}, ${e.role} (${e.part}): ${e.look}`),
      );
    }
  }
  // The ship alongside: what is there now, as the digest shows it.
  if (dockAlongside(content, snapshot.state)?.dock.portId === port.id) {
    const now = atSiteLines(snapshot.state, content) ?? onDockLines(snapshot.state, content);
    if (now !== undefined) lines.push(`Now (${now.heading}):`, ...now.lines);
  }
  return budgetText(lines, (left) => `(${left} more lines not shown)`);
}

const cardsArgs = z.strictObject({ n: z.number().int().min(1).max(50) });

function cardsShown(data: NotesToolData, args: z.infer<typeof cardsArgs>): string {
  const cards = data.notes.cardsShown;
  if (cards.length === 0) return "The captain has seen no cards yet.";
  const shown = cards.slice(-args.n).reverse();
  const head =
    args.n > cards.length
      ? `The card history keeps the last ${NOTES_LIMITS.cardsShown} cards and holds ${cards.length}; older cards live on only in your past arcs and summary. All ${cards.length}, newest first:`
      : `The last ${shown.length} cards, newest first:`;
  return budgetText([head, ...shown.map(cardShownLine)], (left) => `(${left} older not shown)`);
}

function crew(data: NotesToolData, args: z.infer<typeof nameArgs>): string {
  const found = crewNamed(data, args.name);
  if (found.length === 0) {
    const names = Object.values(data.snapshot.state.actors)
      .filter((a) => a.crew)
      .map((a) => a.name);
    return `No such crew member or passenger "${args.name}". Aboard: ${names.join(", ")}.`;
  }
  return found
    .map((a) =>
      a.passenger === true
        ? passengerLine(data.snapshot, data.content, a)
        : crewLine(data.snapshot, data.content, a),
    )
    .join("\n");
}

const eventsArgs = z.strictObject({
  tick: z.number().int().min(0),
  type: z.string().optional().transform(anyWhenEmpty),
});

function eventsSince(data: NotesToolData, args: z.infer<typeof eventsArgs>): string {
  const all = data.recentEvents;
  const first = all[0];
  const last = all.at(-1);
  if (first === undefined || last === undefined) {
    return "No events are held: the request carries only events since the last story call.";
  }
  const span = `The request holds ${all.length} events, t${first.tick} to t${last.tick} (since the last story call).`;
  const since = all.filter((e) => e.tick >= args.tick);
  // Trace events (a fault breaking unnoticed) only when asked for by type.
  const picked =
    args.type === undefined
      ? since.filter((e) => e.significance !== "trace")
      : since.filter((e) => e.type === args.type);
  if (picked.length === 0) {
    const types = [...new Set(all.map((e) => e.type))].sort();
    const which = args.type === undefined ? "" : ` of type ${args.type}`;
    return `No events${which} since t${args.tick}. ${span} Types held: ${types.join(", ")}.`;
  }
  const state = data.snapshot.state;
  // The newest are kept when they do not all fit, then shown oldest first.
  const { kept, left } = budgetLines(
    [...picked].reverse().map((e) => eventLine(e, state, data.content)),
  );
  const more = left === 0 ? [] : [`(${left} earlier not shown: ask from a later tick)`];
  return [span, ...more, ...kept.reverse()].join("\n");
}

// ---------------------------------------------------------------------------------------------
// The toolbox
// ---------------------------------------------------------------------------------------------

interface ToolDef<A> {
  readonly tool: ModelTool;
  readonly args: z.ZodType<A>;
  readonly answer: (data: NotesToolData, args: A) => string;
}

function def<A>(
  name: string,
  description: string,
  parameters: Readonly<Record<string, unknown>>,
  args: z.ZodType<A>,
  answer: (data: NotesToolData, args: A) => string,
): ToolDef<A> {
  return { tool: { name, description, parameters }, args, answer };
}

const objectOf = (properties: Record<string, unknown>, required: readonly string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

/** §notes-turn-tools: the tools, in the order the model is shown them. */
const TOOLS = [
  def(
    "pastArcs",
    "Every story that has ended this game (title, people, shape, summary), newest first; optionally only one scale.",
    objectOf(
      {
        scale: {
          type: "string",
          enum: [...PAST_ARC_SCALES],
          description: "leave out for every scale",
        },
      },
      [],
    ),
    pastArcsArgs,
    pastArcs,
  ),
  def(
    "thread",
    "One thread in full by its exact title: scale, people, arc notes, next beat, ticks and the plan beats that name it; or, for an ended one, its past arc.",
    objectOf({ title: { type: "string" } }, ["title"]),
    threadArgs,
    thread,
  ),
  def(
    "castMember",
    "Everything held on one person who is not crew: your cast note, where they are a local, the jobs they offered, and the threads, past arcs and cards they appear in.",
    objectOf({ name: { type: "string" } }, ["name"]),
    nameArgs,
    castMember,
  ),
  def(
    "site",
    "A port or landing site by id (or name): description, character, locals, your cast there, its dock or site map's posts and default people, and what is there now if the ship is alongside.",
    objectOf({ id: { type: "string" } }, ["id"]),
    siteArgs,
    site,
  ),
  def(
    "cardsShown",
    "The last n cards the captain saw, newest first, with the side chosen.",
    objectOf({ n: { type: "integer", minimum: 1, maximum: 50 } }, ["n"]),
    cardsArgs,
    cardsShown,
  ),
  def(
    "crew",
    "One crew member's or passenger's full line by name (or first or last name): role, watch, what they are doing, needs, mood and thoughts, body, skills, likes, who they are close to or at odds with, berth, bio and voice.",
    objectOf({ name: { type: "string" } }, ["name"]),
    nameArgs,
    crew,
  ),
  def(
    "eventsSince",
    "The events since a tick, oldest first, optionally of one type (e.g. faultOccurred, decisionResolved); only events since the last story call are held.",
    objectOf(
      {
        tick: { type: "integer", minimum: 0 },
        type: { type: "string", description: "an event type; leave out for every type" },
      },
      ["tick"],
    ),
    eventsArgs,
    eventsSince,
  ),
] as const;

/** §notes-turn-tools: the tool definitions the notes turn offers. */
export const NOTES_TOOLS: readonly ModelTool[] = TOOLS.map((t) => t.tool);

function issueText(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length === 0 ? "arguments" : i.path.join(".")}: ${i.message}`)
    .join("; ");
}

/**
 * §notes-turn-tools: runs one tool call. Never throws: an unknown tool, arguments that are not a
 * JSON object or fail the tool's schema, and an unknown name each answer with what was wrong.
 */
export function runNotesTool(data: NotesToolData, name: string, rawArgs: string): string {
  const found = TOOLS.find((t) => t.tool.name === name);
  if (found === undefined) {
    return `No such tool "${name}". Tools: ${NOTES_TOOLS.map((t) => t.name).join(", ")}.`;
  }
  let json: unknown;
  try {
    json = JSON.parse(rawArgs.trim() === "" ? "{}" : rawArgs);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return `Bad arguments for ${name}: not JSON (${err.message}).`;
  }
  return answerWith(found as ToolDef<unknown>, data, json);
}

function answerWith<A>(tool: ToolDef<A>, data: NotesToolData, json: unknown): string {
  const parsed = tool.args.safeParse(json);
  if (!parsed.success) return `Bad arguments for ${tool.tool.name}: ${issueText(parsed.error)}.`;
  return tool.answer(data, parsed.data);
}
