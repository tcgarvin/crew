/**
 * `runNarrator`: one narrator call end to end (PLAN §3, D5). Loads content, builds the digest,
 * asks the model (through the injected `ModelTransport`) for a `NarratorPlan` with structured
 * output, Zod-validates and translates it, and returns commands, card prose and the rewritten
 * notes. Any failure (no transport, provider error, timeout, refusal, truncation, invalid
 * output) falls back to the deterministic null response with `fallback` set, so a hook never
 * blocks the game (review N3). D67: a `stageDock` hook goes to the staging call instead
 * (`staging/run.ts`), over the same digest, with its own prompt, schema and translator.
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
  type TranslationResult,
  buildNarratorPlanSchema,
} from "./contract";
import { buildDigest } from "./digest";
import { applyDecisionEvents, recordCardsFromCall } from "./history";
import { type State, portName } from "./lookups";
import { FallbackError, callModel, contentOf, parseJsonReply, schemaIssue } from "./model-call";
import {
  type MetIssuer,
  type NarratorCastEntry,
  type NarratorNotes,
  boundNotes,
  mergeCast,
  mergeThreads,
  parseNotes,
} from "./notes";
import { nullNarratorResponse } from "./null";
import { planJsonSchema } from "./plan";
import { type NarratorPrompt, PROMPT_VERSION, buildPrompt } from "./prompts/index";
import type { StagingEnvelope } from "./staging/plan";
import { runStaging } from "./staging/run";
import { translateIntents } from "./translate";
import type { ModelTransport, ReasoningEffort } from "./transport";

/** Default model slug (owner); override with `CREW_NARRATOR_MODEL` via `ctx.model`. */
export const DEFAULT_NARRATOR_MODEL = "anthropic/claude-opus-4.6";
/**
 * Vercel's function budget is ~30 s; 25 s leaves time to log the call and answer. No retry: a
 * retry could not finish inside the budget, and the null fallback keeps the game going.
 */
export const NARRATOR_TIMEOUT_MS = 25_000;
/**
 * D70: the staging call's own default timeout. Its output is small, and a staging attempt that
 * runs long costs the player a held ship at the end of transit on every retry (D69's schedule is
 * 2 s, 4 s, then the floor set), so it gives up sooner than a story call. The server's
 * `CREW_STAGING_TIMEOUT_MS` overrides it.
 */
export const STAGING_TIMEOUT_MS = 10_000;
/** A plan is a few hundred tokens; the rest is headroom for the model's reasoning. */
export const NARRATOR_MAX_TOKENS = 4_000;

export interface RunNarratorCtx {
  readonly gameId: string;
  /** Absent = not configured: the call answers with the null fallback. */
  readonly transport?: ModelTransport;
  /** Stored `games.narrative_notes` (raw jsonb); parsed tolerantly. */
  readonly notes?: unknown;
  /**
   * The model for this call. The server passes its staging model for a `stageDock` hook and its
   * story model otherwise (D67); absent = `DEFAULT_NARRATOR_MODEL`.
   */
  readonly model?: string;
  /** Test/eval override; defaults to the validated bundle from `@crew/content`. */
  readonly content?: ContentBundle;
  readonly callId?: string;
  /** Per-call model timeout; absent = `STAGING_TIMEOUT_MS` for `stageDock`, else `NARRATOR_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** D96: the model's reasoning effort for this call; absent = `"default"` (nothing sent). */
  readonly reasoningEffort?: ReasoningEffort;
}

/** Everything the eval harness prints, beyond the response. */
export interface NarratorTrace {
  readonly digest: string;
  readonly capabilities: string;
  readonly prompt: NarratorPrompt;
  readonly rawContent?: string;
  /** The story plan, or for a `stageDock` call the staging plan as parsed (D67). */
  readonly plan?: NarratorPlan | StagingEnvelope;
}

export interface NarratorRun {
  readonly response: NarratorResponse;
  readonly trace: NarratorTrace;
  /** Why the fallback was taken, for logs. */
  readonly error?: string;
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
 * D67: live runs saw the model copy `surfaceDecision`'s `beatOfThread` and `closesThread` onto
 * `card` (the overdue-passenger policy card), which then failed the strict schema and fell back.
 * They mean nothing on a policy card, so they are taken off before validation and the correction
 * is fed back to the model with the drop reasons.
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
 * D25: the people who made the captain an offer this call, for the cast. Passengers-and-galaxy
 * §4.1: a passenger joins the cast placed aboard (no port) with where they are bound, so the
 * model keeps their name and purpose for the voyage and the port they end up at.
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

/** D32: every player-facing text this call produced, to tell which threads had a beat. */
function textsShown(translated: TranslationResult): string[] {
  const texts: string[] = [];
  const card = translated.card;
  if (card !== undefined) texts.push(card.title, card.situation, card.speaker ?? "");
  for (const command of translated.commands) {
    if (command.kind === "surfaceDecision") {
      const { prompt } = command.payload.card;
      const params = prompt.params as Record<string, unknown>;
      texts.push(prompt.prose ?? "", String(params.title ?? ""), String(params.speaker ?? ""));
    } else if (command.kind === "offerJob") {
      const { issuer } = command.payload.job;
      texts.push(typeof issuer === "string" ? issuer : issuer.name);
    }
  }
  return texts;
}

/**
 * D45: a cast entry's `portId` is a plain string in the plan; empty, or a port that does not
 * exist, means nowhere in particular.
 */
function castWritten(plan: NarratorPlan, content: ContentBundle) {
  return plan.notes.cast.map((entry) => ({
    ...entry,
    portId: content.ports[entry.portId as PortDefId] === undefined ? null : entry.portId,
  }));
}

/**
 * The notes after a call: the model's rewrite, plus everything the server carries for it (D25
 * cast sightings, D31 card history, D32 thread beats, D39 beat cards, and why intents were
 * dropped).
 */
function notesFrom(
  plan: NarratorPlan,
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
  return boundNotes({
    summary: plan.notes.summary,
    threads: mergeThreads(
      plan.notes.threads,
      previous.threads,
      tick,
      textsShown(translated),
      translated.beatCardThread,
      cardsShown.flatMap((c) => (c.closedThread === null ? [] : [c.closedThread])),
    ),
    cardsShown,
    cast: placeEndedPassengers(
      mergeCast(castWritten(plan, content), previous.cast, issuersMet(commands, content), tick),
      state,
      content,
    ),
    lastUpdatedTick: tick,
    // D41: non-fatal corrections ride along with the drop reasons.
    lastRejections: [...dropped.map((d) => d.reason), ...translated.notes],
  });
}

/**
 * A snapshot from an older build (a client mid-deploy, a stored fixture) is upgraded with the
 * kernel's save migrations before anything reads it, so the digest and translator only ever see
 * the current state shape; its config gets any key it lacks from the loaded content, as `restore`
 * does (D76 renamed the day knobs within schema 7, so an older snapshot has the old names).
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
  // D31: fold the kernel's decision events in before the digest, so the model sees what was chosen.
  const notes: NarratorNotes = {
    ...stored,
    cardsShown: applyDecisionEvents(stored.cardsShown, req.recentEvents, snapshot.state, content),
  };
  const digest = buildDigest(snapshot, req.recentEvents, notes, content, req.hook);
  const timeoutMs =
    ctx.timeoutMs ?? (req.hook.kind === "stageDock" ? STAGING_TIMEOUT_MS : NARRATOR_TIMEOUT_MS);
  const model = ctx.model ?? DEFAULT_NARRATOR_MODEL;
  const reasoningEffort = ctx.reasoningEffort ?? "default";
  if (req.hook.kind === "stageDock") {
    // D67: the staging call has its own prompt, schema and translator, over the same digest.
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
    };
  }
  const capabilities = buildCapabilities(snapshot.state, content, snapshot.config);
  const prompt = buildPrompt(capabilities, digest, req.hook.kind);
  const baseTrace: NarratorTrace = { digest: digest.text, capabilities, prompt };
  const fallback = (reason: FallbackReason, error: string, trace = baseTrace): NarratorRun => ({
    response: nullNarratorResponse({ ...req, snapshot }, { callId, fallback: reason, content }),
    trace,
    error,
  });

  if (ctx.transport === undefined) {
    return fallback("notConfigured", "no model transport configured");
  }
  const schema = buildNarratorPlanSchema();
  let rawContent: string | undefined;
  try {
    const result = await callModel(ctx.transport, {
      model,
      system: prompt.system,
      user: prompt.user,
      schemaName: "narrator_plan",
      jsonSchema: planJsonSchema(schema),
      maxTokens: NARRATOR_MAX_TOKENS,
      reasoningEffort,
      timeoutMs,
    });
    rawContent = contentOf(result);
    const { plan, corrections } = parsePlan(rawContent, schema);
    const translatedIntents = translateIntents(plan, {
      snapshot,
      content,
      hookTick: req.hook.tick,
      callId,
      hook: req.hook,
      threads: notes.threads,
    });
    const translated: TranslationResult = {
      ...translatedIntents,
      notes: [...corrections, ...translatedIntents.notes],
    };
    const response: NarratorResponse = {
      commands: translated.commands,
      ...(translated.card === undefined ? {} : { card: translated.card }),
      notesUpdate: notesFrom(plan, notes, req.hook.tick, translated, content, snapshot.state),
      callId,
      model: result.model,
      promptVersion: PROMPT_VERSION,
      usage: result.usage,
      dropped: translated.dropped,
    };
    return { response, trace: { ...baseTrace, rawContent, plan } };
  } catch (err) {
    if (!(err instanceof FallbackError)) throw err;
    const trace = rawContent === undefined ? baseTrace : { ...baseTrace, rawContent };
    return fallback(err.reason, err.message, trace);
  }
}

export async function runNarrator(
  req: NarratorRequest,
  ctx: RunNarratorCtx,
): Promise<NarratorResponse> {
  return (await runNarratorWithTrace(req, ctx)).response;
}
