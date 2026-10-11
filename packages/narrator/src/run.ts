/**
 * `runNarrator`: one narrator call end to end (PLAN §3, D5). Loads content, builds the digest,
 * asks the model (through the injected `ModelTransport`) for a `NarratorPlan` with structured
 * output, Zod-validates and translates it, and returns commands and card prose. §notes-turn: the
 * model writes its notes in a second turn after the plan (`NarratorRun.notesTurn`), which the
 * server runs once the plan has been answered; the response carries the notes as they stand until
 * then. Any failure (no transport, provider error, timeout, refusal, truncation, invalid output)
 * falls back to the deterministic null response with `fallback` set, so a hook never blocks the
 * game (review N3). §staging-call-on-the-server: a `stageDock` hook goes to the staging call
 * instead (`staging/run.ts`), over the same digest, with its own prompt, schema and translator.
 */
import { loadBundle } from "@crew/content";
import {
  type ContentBundle,
  type DeepReadonly,
  type Job,
  type NarratorCommand,
  type PortDefId,
  SCHEMA_VERSION,
  type SaveEnvelope,
  fillConfig,
  migrateState,
} from "@crew/sim";
import { buildCapabilities } from "./capabilities";
import {
  type DroppedIntent,
  type FallbackReason,
  type NarratorPlan,
  type NarratorPlanSchema,
  type NarratorRequest,
  type NarratorResponse,
  type NarratorUsage,
  type TranslationResult,
  type WrittenNotes,
  buildNarratorPlanSchema,
  buildNotesSchema,
} from "./contract";
import { buildDigest } from "./digest";
import { applyDecisionEvents, recordCardsFromCall } from "./history";
import { type State, portName } from "./lookups";
import {
  DEFAULT_MAX_REPAIRS,
  DEFAULT_MAX_TOOL_ROUNDS,
  NO_TOOL_LOOP,
  type RepairRecord,
  ReplyFailedError,
  type ToolCallRecord,
  type ToolLoop,
  callForValidReply,
  parseJsonReply,
  schemaIssue,
} from "./model-call";
import {
  type MergedThreads,
  type MetIssuer,
  type NarratorCastEntry,
  type NarratorNotes,
  appendPastArcs,
  boundNotes,
  mergeCast,
  mergeThreads,
  parseNotes,
} from "./notes";
import { NOTES_TOOLS, type NotesToolData, runNotesTool } from "./notes-tools";
import { nullNarratorResponse } from "./null";
import { planJsonSchema, schemaInstruction } from "./plan";
import { type NarratorPrompt, PROMPT_VERSION, buildPrompt } from "./prompts/index";
import type { StagingEnvelope } from "./staging/plan";
import { runStaging } from "./staging/run";
import { mergePlan, stampFiredBeats } from "./story-plan";
import { translateIntents } from "./translate";
import type { ContinuationMessage, ModelTransport, ReasoningEffort } from "./transport";

/**
 * D102: the one default model slug, for the server, the live suite and tests alike; override with
 * `CREW_NARRATOR_MODEL` via `ctx.model`.
 */
export const DEFAULT_NARRATOR_MODEL = "openai/gpt-6-luna";
/**
 * D102: the reasoning effort `DEFAULT_NARRATOR_MODEL` runs at (§models-and-reasoning-effort: luna
 * at `low`).
 */
export const DEFAULT_NARRATOR_REASONING_EFFORT: ReasoningEffort = "low";
/**
 * Vercel's function budget is ~30 s; 25 s leaves time to log the call and answer. No retry: a
 * retry could not finish inside the budget, and the null fallback keeps the game going. A
 * §repair-turn spends this same budget.
 */
export const NARRATOR_TIMEOUT_MS = 25_000;
/**
 * §narrator-timeouts: the staging call's own default timeout. Its output is small, and a staging
 * attempt that runs long costs the player a held ship at the end of transit on every retry (the
 * retry schedule is 2 s, 4 s, then the floor set; §staging-retries-and-the-floor-set), so it gives
 * up sooner than a story call. The server's `CREW_STAGING_TIMEOUT_MS` overrides it.
 */
export const STAGING_TIMEOUT_MS = 10_000;
/** A plan is a few hundred tokens; the rest is headroom for the model's reasoning. */
export const NARRATOR_MAX_TOKENS = 4_000;
/**
 * §notes-turn: the notes turn runs after the plan has been answered, so the player never waits on
 * it, but the game's next call waits for it; it may take longer than a story call, not forever.
 */
export const NOTES_TIMEOUT_MS = 45_000;
/** §notes-turn: notes are a few hundred tokens; the rest is headroom for reasoning. */
export const NOTES_MAX_TOKENS = 4_000;

export interface RunNarratorCtx {
  readonly gameId: string;
  /** Absent = not configured: the call answers with the null fallback. */
  readonly transport?: ModelTransport;
  /** Stored `games.narrative_notes` (raw jsonb); parsed tolerantly. */
  readonly notes?: unknown;
  /**
   * The model for this call. The server passes its staging model for a `stageDock` hook and its
   * story model otherwise (§staging-call-on-the-server); absent = `DEFAULT_NARRATOR_MODEL`.
   */
  readonly model?: string;
  /** Test/eval override; defaults to the validated bundle from `@crew/content`. */
  readonly content?: ContentBundle;
  readonly callId?: string;
  /** Per-call model timeout; absent = `STAGING_TIMEOUT_MS` for `stageDock`, else `NARRATOR_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /**
   * §models-and-reasoning-effort: the model's reasoning effort for this call; absent = `"default"`
   * (nothing sent).
   */
  readonly reasoningEffort?: ReasoningEffort;
  /** §repair-turn: repairs per model call (plan, notes or staging); absent = `DEFAULT_MAX_REPAIRS`. */
  readonly maxRepairs?: number;
  /**
   * §notes-turn-tools: tool rounds the notes turn may spend; 0 offers no tools; absent =
   * `DEFAULT_MAX_TOOL_ROUNDS`.
   */
  readonly maxToolRounds?: number;
}

/** Everything the eval harness prints, beyond the response. */
export interface NarratorTrace {
  readonly digest: string;
  readonly capabilities: string;
  readonly prompt: NarratorPrompt;
  readonly rawContent?: string;
  /**
   * The story plan, or for a `stageDock` call the staging plan as parsed
   * (§staging-call-on-the-server).
   */
  readonly plan?: NarratorPlan | StagingEnvelope;
}

/** §notes-turn: the notes turn's result: the notes to store, or why the model wrote none. */
export type NotesRun =
  | {
      readonly ok: true;
      readonly notes: NarratorNotes;
      readonly model: string;
      readonly usage: NarratorUsage;
      readonly rawContent: string;
      /** §repair-turn: the repairs the notes reply needed. */
      readonly repairs: readonly RepairRecord[];
      /** §notes-turn-tools: the tool calls the notes turn made. */
      readonly toolCalls: readonly ToolCallRecord[];
    }
  | {
      readonly ok: false;
      readonly reason: FallbackReason;
      readonly error: string;
      readonly rawContent?: string;
      readonly repairs: readonly RepairRecord[];
      readonly toolCalls: readonly ToolCallRecord[];
    };

export interface NarratorRun {
  readonly response: NarratorResponse;
  readonly trace: NarratorTrace;
  /** Why the fallback was taken, for logs. */
  readonly error?: string;
  /**
   * §notes-turn: present when the model answered a story call: asks it for its notes, continuing
   * from the plan and its reasoning. `response.notesUpdate` holds the notes until this has run.
   */
  readonly notesTurn?: () => Promise<NotesRun>;
  /** §repair-turn: the repairs this call's reply needed, for the call log. */
  readonly repairs: readonly RepairRecord[];
}

let cachedBundle: ContentBundle | undefined;

/** The validated `@crew/content` bundle, loaded once per process. */
export function defaultContent(): ContentBundle {
  if (cachedBundle === undefined) {
    const result = loadBundle();
    if (!result.ok) {
      throw new Error(
        `narrator: content bundle failed validation (${result.issues.length} issues)`,
      );
    }
    cachedBundle = result.bundle;
  }
  return cachedBundle;
}

/**
 * §translation-and-drop-reasons: live runs saw the model copy `surfaceDecision`'s `beatOfThread`
 * and `closesThread` onto `card` (the overdue-passenger policy card), which then failed the strict
 * schema and fell back. They mean nothing on a policy card, so they are taken off before validation
 * and the correction is fed back to the model with the drop reasons.
 */
const CARD_STRAY_KEYS = ["beatOfThread", "closesThread"] as const;

interface ParsedPlan {
  readonly plan: NarratorPlan;
  readonly corrections: readonly string[];
}

function withoutStrayCardKeys(json: unknown): { json: unknown; corrections: string[] } {
  if (json === null || typeof json !== "object" || !("card" in json)) {
    return { json, corrections: [] };
  }
  const card = json.card;
  if (card === null || typeof card !== "object") return { json, corrections: [] };
  const stray: string[] = CARD_STRAY_KEYS.filter((key) => key in card);
  if (stray.length === 0) return { json, corrections: [] };
  const kept = Object.fromEntries(Object.entries(card).filter(([key]) => !stray.includes(key)));
  return {
    json: { ...json, card: kept },
    corrections: [`card: ${stray.join(" and ")} ignored; they belong on surfaceDecision only`],
  };
}

function parsePlan(content: string, schema: NarratorPlanSchema): ParsedPlan {
  const { json, corrections } = withoutStrayCardKeys(parseJsonReply(content));
  const result = schema.safeParse(json);
  if (!result.success) throw schemaIssue("plan", result.error.issues);
  return { plan: result.data, corrections };
}

/**
 * §issuers-and-pitches: the people who made the captain an offer this call, for the cast.
 * Passengers-and-galaxy §4.1: a passenger joins the cast placed aboard (no port) with where they
 * are bound, so the model keeps their name and purpose for the voyage and the port they end up at.
 */
function issuersMet(commands: readonly NarratorCommand[], content: ContentBundle): MetIssuer[] {
  return commands.flatMap((command): MetIssuer[] => {
    if (command.kind !== "offerJob") return [];
    const { issuer, fromPortId, toPortId, passenger, roundTrip } = command.payload.job;
    if (typeof issuer === "string") return [];
    const who = issuer.org === undefined ? issuer.role : `${issuer.role}, ${issuer.org}`;
    if (passenger === true) {
      const to = portName(content, toPortId);
      const back = roundTrip === true ? " and back" : "";
      return [
        { name: issuer.name, note: `${who}; passenger, bound for ${to}${back}`, portId: null },
      ];
    }
    return [{ name: issuer.name, note: `${who}; offered us work`, portId: fromPortId }];
  });
}

/** Where a passenger's cast entry belongs once the kernel has settled their fate, and why. */
interface PassengerPlacement {
  readonly portId: PortDefId;
  readonly phrase: string;
}

/**
 * A passenger's whereabouts from the job and the actor the kernel keeps: left behind or put off
 * at a port (off ship in its lounge), home or at the destination when the passage completed
 * (the actor is gone), or still at the offer port when the offer was declined or expired.
 * Undefined while the passage is live or not yet answered.
 */
function passengerPlacement(
  job: DeepReadonly<Job>,
  state: State,
  content: ContentBundle,
): PassengerPlacement | undefined {
  const passage = job.passage;
  if (passage === undefined) return undefined;
  const name = (id: PortDefId) => portName(content, id);
  if (job.status === "declined" || job.status === "expired") {
    return {
      portId: job.fromPortId,
      phrase: `offer ${job.status}, still at ${name(job.fromPortId)}`,
    };
  }
  const actor = state.actors[passage.actorId];
  const ashoreAt = actor?.location.kind === "inExternalStore" ? actor.location.portId : undefined;
  const reason = passage.endReason;
  if (reason === "completed") {
    const portId = passage.roundTrip ? job.fromPortId : job.toPortId;
    return { portId, phrase: `passage completed, at ${name(portId)}` };
  }
  if (reason === "leftBehind") {
    const portId = ashoreAt ?? job.toPortId;
    return { portId, phrase: `left behind at ${name(portId)}` };
  }
  // Put off while aboard, they leave at the next docking: nowhere yet until they have.
  if (reason === "putOff" && ashoreAt !== undefined) {
    return { portId: ashoreAt, phrase: `put off at ${name(ashoreAt)}` };
  }
  return undefined;
}

/**
 * Passengers-and-galaxy §4.1: a passenger joins the cast with no port while they ride. Once the
 * kernel has ended the passage (or the offer was never taken) it knows where they are and the
 * model often does not, so the server places any such entry still without a port and appends
 * the reason to its note once. An entry the model has already placed somewhere is left alone.
 */
function placeEndedPassengers(
  cast: readonly NarratorCastEntry[],
  state: State,
  content: ContentBundle,
): NarratorCastEntry[] {
  const key = (name: string) => name.trim().toLowerCase();
  const placements = new Map<string, PassengerPlacement>();
  const jobs = Object.values(state.jobs).sort(
    (a, b) => a.offeredTick - b.offeredTick || a.id.localeCompare(b.id),
  );
  for (const job of jobs) {
    const placed = passengerPlacement(job, state, content);
    if (placed !== undefined) placements.set(key(job.issuerPerson.name), placed);
  }
  return cast.map((entry) => {
    const placed = placements.get(key(entry.name));
    if (placed === undefined || entry.portId !== null) return entry;
    const note = entry.note.includes(placed.phrase)
      ? entry.note
      : `${entry.note}; ${placed.phrase}`;
    return { ...entry, portId: placed.portId, note };
  });
}

/**
 * §threads-and-scales: every player-facing text this call produced, to tell which threads had a
 * beat.
 */
function textsShown(translated: TranslationResult): string[] {
  const texts: string[] = [];
  const card = translated.card;
  if (card !== undefined) texts.push(card.title, card.situation, card.speaker ?? "");
  for (const command of translated.commands) {
    if (command.kind === "surfaceDecision") {
      const { card } = command.payload;
      // §follow-up-cards: a follow-up is part of the scene the captain may see.
      const followUps = [card.left, card.right].flatMap((side) => [
        ...(side.next === undefined ? [] : [side.next]),
        ...(side.attempt?.failNext === undefined ? [] : [side.attempt.failNext]),
      ]);
      for (const { prompt } of [card, ...followUps]) {
        const params = prompt.params as Record<string, unknown>;
        texts.push(prompt.prose ?? "", String(params.title ?? ""), String(params.speaker ?? ""));
      }
    } else if (command.kind === "offerJob") {
      const { issuer } = command.payload.job;
      texts.push(typeof issuer === "string" ? issuer : issuer.name);
    }
  }
  return texts;
}

/**
 * §narrator-authority: a cast entry's `portId` is a plain string in the plan; empty, or a port that
 * does not exist, means nowhere in particular.
 */
function castWritten(written: WrittenNotes, content: ContentBundle) {
  return written.cast.map((entry) => ({
    ...entry,
    portId: content.ports[entry.portId as PortDefId] === undefined ? null : entry.portId,
  }));
}

/**
 * The notes after a call: the model's rewrite, plus everything the server carries for it
 * (§issuers-and-pitches cast sightings, §card-history card history, §threads-and-scales thread
 * beats, §beat-cards beat cards, §past-arcs past arcs, and why intents were dropped).
 */
function notesFrom(
  written: WrittenNotes,
  previous: NarratorNotes,
  tick: number,
  translated: TranslationResult,
  content: ContentBundle,
  state: State,
): NarratorNotes {
  const { commands, dropped } = translated;
  const cardsShown = recordCardsFromCall(
    previous.cardsShown,
    tick,
    translated.card,
    commands,
    translated.closedThread,
  );
  const merged = mergeThreads(
    written.threads,
    previous.threads,
    tick,
    textsShown(translated),
    translated.beatCardThread,
    cardsShown.flatMap((c) => (c.closedThread === null ? [] : [c.closedThread])),
    written.retired,
  );
  const arcs = appendPastArcs(previous.pastArcs, merged.ended, written.endedArcs, tick);
  const plan = mergePlan({
    written: written.plan,
    previous: previous.plan,
    tick,
    attributions: translated.beats,
    closedThread: translated.closedThread,
    offerMade: commands.some((c) => c.kind === "offerJob"),
  });
  return boundNotes({
    summary: written.summary,
    threads: merged.threads,
    cardsShown,
    // §seasons-and-stalls: a season or an arc the plan ended is a past arc too.
    pastArcs: [...arcs.pastArcs, ...plan.ended],
    plan: plan.plan,
    cast: placeEndedPassengers(
      mergeCast(castWritten(written, content), previous.cast, issuersMet(commands, content), tick),
      state,
      content,
    ),
    lastUpdatedTick: tick,
    // §captain-never-speaks: non-fatal corrections ride along with the drop reasons.
    lastRejections: [
      ...dropped.map((d) => d.reason),
      ...translated.notes,
      ...threadCorrections(merged),
      ...plan.corrections,
      ...arcs.missing.map(
        (title) =>
          `no arc summary written for ended thread "${title}": its arc notes were kept as its summary under "Past arcs"`,
      ),
    ],
  });
}

/**
 * §thread-keeping-and-retirement: what the server did to the model's thread list, said back to it
 * on the next call.
 */
function threadCorrections(merged: MergedThreads): string[] {
  return [
    ...merged.kept.map(
      (title) =>
        `kept thread "${title}": the captain has seen a beat of it and no card closed it; give it a closing card (closesThread), or name it in retired if it truly must go without one`,
    ),
    ...merged.retiredWithoutCard.map((title) => `retired "${title}" without a closing card`),
    ...merged.droppedForRoom.map(
      (title) => `dropped new thread "${title}": no room beside the threads the captain has seen`,
    ),
  ];
}

/** §the-plan: a tier written so that it is kept as it stands. */
function keepTier(): WrittenNotes["plan"]["season"] {
  return { premise: "", beats: [], until: "", tempo: "steady", revised: "" };
}

/**
 * §notes-turn: the stored notes as the model would write them, so the notes stored with the plan
 * (before the notes turn) carry this call's server-kept changes over the model's previous notes.
 */
function writtenFrom(notes: NarratorNotes): WrittenNotes {
  return {
    summary: notes.summary,
    threads: notes.threads.map(({ title, scale, people, arcNotes, nextBeat }) => ({
      title,
      scale,
      people: [...people],
      arcNotes,
      nextBeat,
    })),
    cast: notes.cast.map(({ name, note, portId }) => ({ name, note, portId: portId ?? "" })),
    // The plan-time merge keeps nothing: it only carries this call's changes over.
    retired: [],
    endedArcs: [],
    // §the-plan: every tier kept (an empty premise keeps it); attributions still land.
    plan: { season: keepTier(), arc: keepTier(), episode: keepTier(), ended: [], landed: [] },
  };
}

/**
 * §notable-event-hook: the events that end a job's episode (its closing card is due), as
 * `notesRequest` reads the hook.
 */
const EPISODE_CLOSING_EVENTS: ReadonlySet<string> = new Set([
  "contractCompleted",
  "passageEnded",
  "jobFailed",
]);

/**
 * §notes-turn, §seasons-and-stalls: what the notes turn is asked of the plan this call. The server
 * names the moment (no season or arc stands, an episode opens, an episode is ending) and never what
 * to plan (D46).
 */
function planRequest(
  translated: TranslationResult,
  stored: NarratorNotes,
  req: NarratorRequest,
): string[] {
  const { plan } = stored;
  const lines: string[] = [];
  if (plan.season.premise === "") {
    lines.push(
      'No season stands: sketch one in plan.season (its premise is the question it asks of these people, three to five movements, until, tempo), and an arc in plan.arc to start it. "Past arcs" is what you have told so far.',
    );
  } else if (plan.arc.premise === "") {
    lines.push("No arc stands: sketch the season's next arc in plan.arc.");
  }
  const hook = req.hook;
  const offered = translated.commands.some((c) => c.kind === "offerJob");
  if (hook.kind === "captainAshore" && plan.episode.premise === "") {
    lines.push(
      offered
        ? "No episode is live and the captain is looking for work: sketch the episode in plan.episode. The offer you just made is its setup beat; know its turn before the captain takes it."
        : "No episode is live and the captain is looking for work: sketch in plan.episode the story your card opens, or the one your next offer will.",
      'Read "Past arcs" and your cast first: make it a different kind of story from the last ones, about someone in it.',
    );
  }
  // §prompt-rules: the craft lives in the static rules; the request only points at it.
  if (lines.length > 0) {
    lines.push(
      'Write what you sketch as "Pitch the plan" and "Decide some beats" under "Your notes" say.',
    );
  }
  const closingEvent =
    hook.kind === "notableEvent" &&
    req.recentEvents.some(
      (e) => hook.context.eventIds.includes(e.id) && EPISODE_CLOSING_EVENTS.has(e.type),
    );
  const closed = translated.closedThread;
  if (closingEvent || closed !== undefined) {
    const why = closed === undefined ? "the job is over" : `your closing card ended "${closed}"`;
    lines.push(
      `This episode is ending (${why}). Did the arc move? Name in plan.landed the arc beat this episode landed, if any; revise the arc if its next episode changed (and the season only if the arc's premise broke); once the episode's closing card is up, put "episode" in plan.ended.`,
    );
  }
  return lines;
}

/**
 * §notes-turn-tools: the notes request's reminder that the tools are there, when they are. The
 * how and when is in the static rules ("Your notes").
 */
export const NOTES_TOOLS_LINE =
  "You may call the tools first (at most a few rounds) if your notes need what the digest does not show; then answer with the notes JSON.";

/** §notes-turn: the notes turn's user message: what became of the plan, then the notes schema. */
function notesRequest(
  translated: TranslationResult,
  stored: NarratorNotes,
  req: NarratorRequest,
  toolsOffered: boolean,
): string {
  const outcome =
    translated.dropped.length === 0
      ? ["Every intent in your plan was carried out."]
      : translated.dropped.map((d) => `Dropped intent ${d.intentIndex} (${d.kind}): ${d.reason}`);
  const beat = translated.beatCardThread;
  const known = (title: string) =>
    stored.threads.some((t) => t.title.trim().toLowerCase() === title.trim().toLowerCase());
  const newThread =
    beat !== undefined && !known(beat)
      ? [
          `Your beat card foreshadows a new thread, "${beat}": write it into threads with that title.`,
        ]
      : [];
  // §past-arcs: the thread this call's closing card ended needs its summary.
  const closed = translated.closedThread;
  const closedArc =
    closed === undefined
      ? []
      : [`Your closing card ended "${closed}": write its summary in endedArcs.`];
  return [
    "# Now your notes",
    "",
    ...outcome,
    ...translated.notes,
    ...newThread,
    ...closedArc,
    ...planRequest(translated, stored, req),
    "",
    'Write your notes now (see "Your notes").',
    ...(toolsOffered ? [NOTES_TOOLS_LINE] : []),
    schemaInstruction(planJsonSchema(buildNotesSchema())),
  ].join("\n");
}

interface NotesTurnInputs {
  readonly transport: ModelTransport;
  readonly model: string;
  readonly prompt: NarratorPrompt;
  readonly planJsonSchema: Readonly<Record<string, unknown>>;
  /** The plan's turns after its user turn, ending with the accepted plan (§repair-turn). */
  readonly planTurns: readonly ContinuationMessage[];
  readonly reasoningEffort: ReasoningEffort;
  readonly maxRepairs: number;
  readonly logContext: Readonly<Record<string, string>>;
  readonly request: string;
  readonly merge: (written: WrittenNotes) => NarratorNotes;
  /** §notes-turn-tools */
  readonly tools: ToolLoop;
}

/** §notes-turn-tools: the notes turn's tool loop over this call's data; none at 0 rounds. */
function notesToolLoop(data: NotesToolData, maxRounds: number): ToolLoop {
  if (maxRounds <= 0) return NO_TOOL_LOOP;
  return {
    kind: "loop",
    tools: NOTES_TOOLS,
    run: (name, args) => runNotesTool(data, name, args),
    maxRounds,
  };
}

function parseWrittenNotes(content: string): WrittenNotes {
  const parsed = buildNotesSchema().safeParse(parseJsonReply(content));
  if (!parsed.success) throw schemaIssue("notes", parsed.error.issues);
  return parsed.data;
}

/**
 * §notes-turn: the notes turn. The same system prefix as the plan (so it reads from the prompt
 * cache), the plan's user turn, the model's plan with its reasoning (and any §repair-turn before
 * it), then the request for notes. §notes-turn-tools: it may call the notes tools first.
 */
async function runNotesTurn(turn: NotesTurnInputs): Promise<NotesRun> {
  try {
    const reply = await callForValidReply(
      turn.transport,
      {
        model: turn.model,
        system: turn.prompt.system,
        user: turn.prompt.user,
        continuation: [...turn.planTurns, { role: "user", content: turn.request }],
        schemaName: "narrator_plan",
        jsonSchema: turn.planJsonSchema,
        maxTokens: NOTES_MAX_TOKENS,
        reasoningEffort: turn.reasoningEffort,
        timeoutMs: NOTES_TIMEOUT_MS,
      },
      parseWrittenNotes,
      {
        maxRepairs: turn.maxRepairs,
        logContext: { ...turn.logContext, turn: "notes" },
        tools: turn.tools,
      },
    );
    return {
      ok: true,
      notes: turn.merge(reply.value),
      model: reply.model,
      usage: reply.usage,
      rawContent: reply.content,
      repairs: reply.repairs,
      toolCalls: reply.toolCalls,
    };
  } catch (err) {
    if (!(err instanceof ReplyFailedError)) throw err;
    return {
      ok: false,
      reason: err.reason,
      error: err.message,
      ...(err.rawContent === undefined ? {} : { rawContent: err.rawContent }),
      repairs: err.repairs,
      toolCalls: err.toolCalls,
    };
  }
}

/**
 * A snapshot from an older build (a client mid-deploy, a stored fixture) is upgraded with the
 * kernel's save migrations before anything reads it, so the digest and translator only ever see
 * the current state shape; its config gets any key it lacks from the loaded content, as `restore`
 * does (the day knobs were renamed within schema 7, §the-ships-day, so an older snapshot has the
 * old names).
 */
function currentSnapshot(snapshot: SaveEnvelope, content: ContentBundle): SaveEnvelope {
  const config = fillConfig(snapshot.config, content.config).values;
  if (snapshot.schemaVersion === SCHEMA_VERSION) return { ...snapshot, config };
  const state = migrateState(JSON.parse(JSON.stringify(snapshot.state)), snapshot.schemaVersion, {
    content,
    config,
  }) as SaveEnvelope["state"];
  return { ...snapshot, schemaVersion: SCHEMA_VERSION, state, config };
}

/** `runNarrator` plus the intermediate artefacts, for the eval harness. */
export async function runNarratorWithTrace(
  req: NarratorRequest,
  ctx: RunNarratorCtx,
): Promise<NarratorRun> {
  const content = ctx.content ?? defaultContent();
  const callId = ctx.callId ?? globalThis.crypto.randomUUID();
  const snapshot = currentSnapshot(req.snapshot, content);
  const stored = parseNotes(ctx.notes);
  // §beat-attribution: stamp the beats whose levers fired since the last call; one that never
  // fired is said back to the model with last call's drop reasons.
  const stamped = stampFiredBeats(stored.plan, req.recentEvents, snapshot.state);
  // §card-history: fold the kernel's decision events in before the digest, so the model sees what
  // was chosen.
  const notes: NarratorNotes = {
    ...stored,
    cardsShown: applyDecisionEvents(stored.cardsShown, req.recentEvents, snapshot.state, content),
    plan: stamped.plan,
    lastRejections: [...stored.lastRejections, ...stamped.corrections],
  };
  const digest = buildDigest(snapshot, req.recentEvents, notes, content, req.hook);
  const timeoutMs =
    ctx.timeoutMs ?? (req.hook.kind === "stageDock" ? STAGING_TIMEOUT_MS : NARRATOR_TIMEOUT_MS);
  const model = ctx.model ?? DEFAULT_NARRATOR_MODEL;
  const reasoningEffort = ctx.reasoningEffort ?? DEFAULT_NARRATOR_REASONING_EFFORT;
  const maxRepairs = ctx.maxRepairs ?? DEFAULT_MAX_REPAIRS;
  const logContext = { gameId: ctx.gameId, callId };
  if (req.hook.kind === "stageDock") {
    // §staging-call-on-the-server: the staging call has its own prompt, schema and translator, over
    // the same digest.
    const staged = await runStaging({
      req,
      hook: req.hook,
      snapshot,
      notes,
      digest,
      content,
      callId,
      transport: ctx.transport,
      model,
      timeoutMs,
      reasoningEffort,
      maxRepairs,
      logContext,
    });
    return {
      response: staged.response,
      trace: {
        digest: digest.text,
        capabilities: staged.catalogue,
        prompt: staged.prompt,
        ...(staged.rawContent === undefined ? {} : { rawContent: staged.rawContent }),
        ...(staged.plan === undefined ? {} : { plan: staged.plan }),
      },
      ...(staged.error === undefined ? {} : { error: staged.error }),
      repairs: staged.repairs,
    };
  }
  const capabilities = buildCapabilities(snapshot.state, content, snapshot.config);
  const prompt = buildPrompt(capabilities, digest, req.hook.kind);
  const baseTrace: NarratorTrace = { digest: digest.text, capabilities, prompt };
  const fallback = (
    reason: FallbackReason,
    error: string,
    trace = baseTrace,
    repairs: readonly RepairRecord[] = [],
  ): NarratorRun => ({
    response: nullNarratorResponse({ ...req, snapshot }, { callId, fallback: reason, content }),
    trace,
    error,
    repairs,
  });

  if (ctx.transport === undefined) {
    return fallback("notConfigured", "no model transport configured");
  }
  const transport = ctx.transport;
  const schema = buildNarratorPlanSchema();
  const jsonSchema = planJsonSchema(schema);
  try {
    const reply = await callForValidReply(
      transport,
      {
        model,
        system: prompt.system,
        user: prompt.user,
        continuation: [],
        schemaName: "narrator_plan",
        jsonSchema,
        maxTokens: NARRATOR_MAX_TOKENS,
        reasoningEffort,
        timeoutMs,
      },
      (raw) => parsePlan(raw, schema),
      { maxRepairs, logContext, tools: NO_TOOL_LOOP },
    );
    const rawContent = reply.content;
    const { plan, corrections } = reply.value;
    const translatedIntents = translateIntents(plan, {
      snapshot,
      content,
      hookTick: req.hook.tick,
      callId,
      hook: req.hook,
      threads: notes.threads,
      closedThreads: notes.cardsShown.flatMap((c) =>
        c.closedThread === null ? [] : [c.closedThread],
      ),
    });
    const translated: TranslationResult = {
      ...translatedIntents,
      notes: [...corrections, ...translatedIntents.notes],
    };
    const merge = (written: WrittenNotes) =>
      notesFrom(written, notes, req.hook.tick, translated, content, snapshot.state);
    const tools = notesToolLoop(
      { snapshot, notes, recentEvents: req.recentEvents, content },
      ctx.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS,
    );
    const notesTurn = () =>
      runNotesTurn({
        transport,
        model,
        prompt,
        planJsonSchema: jsonSchema,
        planTurns: reply.conversation,
        reasoningEffort,
        maxRepairs,
        logContext,
        request: notesRequest(translated, notes, req, tools.kind === "loop"),
        merge,
        tools,
      });
    const response: NarratorResponse = {
      commands: translated.commands,
      ...(translated.card === undefined ? {} : { card: translated.card }),
      notesUpdate: merge(writtenFrom(notes)),
      callId,
      model: reply.model,
      promptVersion: PROMPT_VERSION,
      usage: reply.usage,
      dropped: translated.dropped,
    };
    return {
      response,
      trace: { ...baseTrace, rawContent, plan },
      notesTurn,
      repairs: reply.repairs,
    };
  } catch (err) {
    if (!(err instanceof ReplyFailedError)) throw err;
    const raw = err.rawContent;
    const trace = raw === undefined ? baseTrace : { ...baseTrace, rawContent: raw };
    return fallback(err.reason, err.message, trace, err.repairs);
  }
}

export async function runNarrator(
  req: NarratorRequest,
  ctx: RunNarratorCtx,
): Promise<NarratorResponse> {
  return (await runNarratorWithTrace(req, ctx)).response;
}
