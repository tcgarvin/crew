/**
 * `runNarrator`: one narrator call end to end (PLAN §3, D5). Loads content, builds the digest,
 * asks the model (through the injected `ModelTransport`) for a `NarratorPlan` with structured
 * output, Zod-validates and translates it, and returns commands, card prose and the rewritten
 * notes. Any failure (no transport, provider error, timeout, refusal, truncation, invalid
 * output) falls back to the deterministic null response with `fallback` set, so a hook never
 * blocks the game (review N3).
 */
import { loadBundle } from "@crew/content";
import {
  type ContentBundle,
  type NarratorCommand,
  type PortDefId,
  SCHEMA_VERSION,
  type SaveEnvelope,
  migrateState,
} from "@crew/sim";
import { buildCapabilities } from "./capabilities";
import type {
  DroppedIntent,
  FallbackReason,
  NarratorPlan,
  NarratorPlanSchema,
  NarratorRequest,
  NarratorResponse,
  TranslationResult,
} from "./contract";
import { buildDigest } from "./digest";
import { applyDecisionEvents, recordCardsFromCall } from "./history";
import {
  type MetIssuer,
  type NarratorNotes,
  boundNotes,
  mergeCast,
  mergeThreads,
  parseNotes,
} from "./notes";
import { nullNarratorResponse } from "./null";
import { planJsonSchema, planSchemaFor } from "./plan";
import { type NarratorPrompt, PROMPT_VERSION, buildPrompt } from "./prompts/index";
import { translateIntents } from "./translate";
import { type ModelResult, type ModelTransport, TransportError } from "./transport";

/** Default model slug (owner); override with `CREW_NARRATOR_MODEL` via `ctx.model`. */
export const DEFAULT_NARRATOR_MODEL = "anthropic/claude-opus-4.6";
/**
 * Vercel's function budget is ~30 s; 25 s leaves time to log the call and answer. No retry: a
 * retry could not finish inside the budget, and the null fallback keeps the game going.
 */
export const NARRATOR_TIMEOUT_MS = 25_000;
/** A plan is a few hundred tokens; the rest is headroom for the model's reasoning. */
export const NARRATOR_MAX_TOKENS = 4_000;

export interface RunNarratorCtx {
  readonly gameId: string;
  /** Absent = not configured: the call answers with the null fallback. */
  readonly transport?: ModelTransport;
  /** Stored `games.narrative_notes` (raw jsonb); parsed tolerantly. */
  readonly notes?: unknown;
  readonly model?: string;
  /** Test/eval override; defaults to the validated bundle from `@crew/content`. */
  readonly content?: ContentBundle;
  readonly callId?: string;
  readonly timeoutMs?: number;
}

/** Everything the eval harness prints, beyond the response. */
export interface NarratorTrace {
  readonly digest: string;
  readonly capabilities: string;
  readonly prompt: NarratorPrompt;
  readonly rawContent?: string;
  readonly plan?: NarratorPlan;
}

export interface NarratorRun {
  readonly response: NarratorResponse;
  readonly trace: NarratorTrace;
  /** Why the fallback was taken, for logs. */
  readonly error?: string;
}

let cachedBundle: ContentBundle | undefined;

function defaultContent(): ContentBundle {
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

class FallbackError extends Error {
  constructor(
    readonly reason: FallbackReason,
    message: string,
  ) {
    super(message);
    this.name = "FallbackError";
  }
}

function contentOf(result: ModelResult): string {
  if (result.finish === "refusal") {
    throw new FallbackError("refusal", result.refusal ?? "model refused");
  }
  if (result.finish === "length") throw new FallbackError("truncated", "output hit max tokens");
  if (result.content === null || result.content.trim() === "") {
    throw new FallbackError("schemaInvalid", "empty model output");
  }
  return result.content;
}

/** Some providers wrap JSON in a code fence even in JSON mode; accept that one variation. */
function stripFence(content: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(content);
  return fenced?.[1] ?? content;
}

function parsePlan(content: string, schema: NarratorPlanSchema): NarratorPlan {
  let json: unknown;
  try {
    json = JSON.parse(stripFence(content));
  } catch {
    throw new FallbackError("schemaInvalid", "model output is not JSON");
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new FallbackError(
      "schemaInvalid",
      `plan failed validation at ${issue?.path.join(".") ?? "?"}: ${issue?.message ?? ""}`,
    );
  }
  return result.data;
}

/** D25: the people who made the captain an offer this call, for the cast. */
function issuersMet(commands: readonly NarratorCommand[]): MetIssuer[] {
  return commands.flatMap((command) => {
    if (command.kind !== "offerJob") return [];
    const { issuer, fromPortId } = command.payload.job;
    if (typeof issuer === "string") return [];
    const note = issuer.org === undefined ? issuer.role : `${issuer.role}, ${issuer.org}`;
    return [{ name: issuer.name, note: `${note}; offered us work`, portId: fromPortId }];
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
 * The notes after a call: the model's rewrite, plus everything the server carries for it (D25
 * cast sightings, D31 card history, D32 thread beats, D39 beat cards, and why intents were
 * dropped).
 */
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

function notesFrom(
  plan: NarratorPlan,
  previous: NarratorNotes,
  tick: number,
  translated: TranslationResult,
  content: ContentBundle,
): NarratorNotes {
  const { commands, dropped } = translated;
  return boundNotes({
    summary: plan.notes.summary,
    threads: mergeThreads(
      plan.notes.threads,
      previous.threads,
      tick,
      textsShown(translated),
      translated.beatCardThread,
    ),
    cardsShown: recordCardsFromCall(previous.cardsShown, tick, translated.card, commands),
    cast: mergeCast(castWritten(plan, content), previous.cast, issuersMet(commands), tick),
    lastUpdatedTick: tick,
    // D41: non-fatal corrections ride along with the drop reasons.
    lastRejections: [...dropped.map((d) => d.reason), ...translated.notes],
  });
}

/**
 * A snapshot from an older build (a client mid-deploy, a stored fixture) is upgraded with the
 * kernel's save migrations before anything reads it, so the digest and translator only ever see
 * the current state shape.
 */
function currentSnapshot(snapshot: SaveEnvelope): SaveEnvelope {
  if (snapshot.schemaVersion === SCHEMA_VERSION) return snapshot;
  const state = migrateState(
    JSON.parse(JSON.stringify(snapshot.state)),
    snapshot.schemaVersion,
  ) as SaveEnvelope["state"];
  return { ...snapshot, schemaVersion: SCHEMA_VERSION, state };
}

async function callTransport(
  transport: ModelTransport,
  ctx: RunNarratorCtx,
  prompt: NarratorPrompt,
  schema: NarratorPlanSchema,
): Promise<ModelResult> {
  try {
    return await transport({
      model: ctx.model ?? DEFAULT_NARRATOR_MODEL,
      system: prompt.system,
      user: prompt.user,
      schemaName: "narrator_plan",
      jsonSchema: planJsonSchema(schema),
      maxTokens: NARRATOR_MAX_TOKENS,
      signal: AbortSignal.timeout(ctx.timeoutMs ?? NARRATOR_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof TransportError) throw new FallbackError(err.kind, err.message);
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new FallbackError("timeout", "narrator call timed out");
    }
    // A transport that throws anything else is still a provider failure, not a game failure.
    throw new FallbackError("apiError", err instanceof Error ? err.message : String(err));
  }
}

/** `runNarrator` plus the intermediate artefacts, for the eval harness. */
export async function runNarratorWithTrace(
  req: NarratorRequest,
  ctx: RunNarratorCtx,
): Promise<NarratorRun> {
  const content = ctx.content ?? defaultContent();
  const callId = ctx.callId ?? globalThis.crypto.randomUUID();
  const snapshot = currentSnapshot(req.snapshot);
  const stored = parseNotes(ctx.notes);
  // D31: fold the kernel's decision events in before the digest, so the model sees what was chosen.
  const notes: NarratorNotes = {
    ...stored,
    cardsShown: applyDecisionEvents(stored.cardsShown, req.recentEvents, snapshot.state, content),
  };
  const digest = buildDigest(snapshot, req.recentEvents, notes, content, req.hook);
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
  const schema = planSchemaFor();
  let rawContent: string | undefined;
  try {
    const result = await callTransport(ctx.transport, ctx, prompt, schema);
    rawContent = contentOf(result);
    const plan = parsePlan(rawContent, schema);
    const translated = translateIntents(plan, {
      snapshot,
      content,
      hookTick: req.hook.tick,
      callId,
      hook: req.hook,
      threads: notes.threads,
    });
    const response: NarratorResponse = {
      commands: translated.commands,
      ...(translated.card === undefined ? {} : { card: translated.card }),
      notesUpdate: notesFrom(plan, notes, req.hook.tick, translated, content),
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
