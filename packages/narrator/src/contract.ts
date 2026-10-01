/**
 * Narrator contracts (D5, D6, PLAN §3 and §6 W9).
 *
 * Flow: the kernel raises a `NarratorHook` and pauses → the host POSTs a `NarratorRequest` to
 * `POST /api/games/:id/narrator` → the server projects a digest from the snapshot, calls the LLM
 * with the `NarratorPlan` structured-output schema, translates intents to `NarratorCommand`s
 * (validating against the snapshot) → returns a `NarratorResponse` → the host enqueues the
 * commands at the hook tick, then sends `acknowledgeHook`.
 *
 * Two layers, deliberately separate (review §D.3, §E.1):
 * - `NarratorPlan`: what the LLM emits. Flat, closed, enum-heavy, name/choice based, no raw
 *   numbers where a tier will do, no recursion, every object `additionalProperties: false`,
 *   every property required (absence is `null`).
 * - `NarratorCommand`: the kernel's strict command subset. Only the translator produces these.
 */
import {
  type ContentBundle,
  type DeepReadonly,
  JOB_URGENCIES,
  type NarratorCommand,
  type NarratorHook,
  type SaveEnvelope,
  type SimEvent,
  type Tick,
} from "@crew/sim";
import { z } from "zod";
import { type NarratorNotes, THREAD_SCALES } from "./notes";

export type {
  CardShown,
  NarratorCastEntry,
  NarratorNotes,
  Thread,
  ThreadScale,
} from "./notes";
export { THREAD_SCALES } from "./notes";

// ---------------------------------------------------------------------------------------------
// HTTP exchange
// ---------------------------------------------------------------------------------------------

export interface NarratorRequest {
  readonly gameId: string;
  readonly hook: NarratorHook;
  /** State at the hook tick. The server trusts nothing in it beyond "this is the player's game". */
  readonly snapshot: SaveEnvelope;
  /** Notable/narrative events since the previous narrator call, oldest first. */
  readonly recentEvents: readonly SimEvent[];
}

/**
 * Prose for a decision card that already exists in sim state (e.g. a policy decision), written
 * from the captain's point of view. Presentation only: the main thread shows it over the
 * template text; it never enters sim state. W0 decision.
 *
 * W9 change: `{prompt, left, right}` became `{title, situation, leftLabel, rightLabel}` (GDD §22:
 * a full-screen card with a heading, the situation, and two sides). No numbers in any field.
 */
export interface DecisionCardProse {
  readonly decisionId: string;
  readonly title: string;
  /** Captain's point of view, at most `CARD_SITUATION_MAX_WORDS` words. */
  readonly situation: string;
  readonly leftLabel: string;
  readonly rightLabel: string;
  /**
   * D26 (additive, 2026-09-30): what happens next once that side is chosen, shown briefly before
   * the card closes. At most `AFTERMATH_MAX_WORDS` words, no numbers. Absent = none available.
   */
  readonly leftAftermath?: string;
  readonly rightAftermath?: string;
  /**
   * D29 (additive, 2026-10-01): who is speaking on the card, full name as the digest lists them;
   * absent for an observed scene.
   */
  readonly speaker?: string;
}

/** GDD §22 card budget; D29 raised it from 60 to 70 (target 35 to 55). */
export const CARD_SITUATION_MAX_WORDS = 70;
/** D25: an issuer's pitch is one line of dialogue. */
export const PITCH_MAX_WORDS = 30;
/** D26: an aftermath caption is one plain statement. */
export const AFTERMATH_MAX_WORDS = 20;

/** Why a response came from the deterministic null path instead of the model (W9). */
export const FALLBACK_REASONS = [
  "notConfigured",
  "apiError",
  "timeout",
  "refusal",
  "truncated",
  "schemaInvalid",
] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

/** Token accounting for `narrator_calls` (W9). Zero on the null path. */
export interface NarratorUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}

/** An intent the translator refused, with a reason fed back to the model via notes. */
export interface DroppedIntent {
  readonly intentIndex: number;
  /** The intent's `kind` as the model wrote it (may be anything for a malformed intent). */
  readonly kind: string;
  readonly reason: string;
}

export interface NarratorResponse {
  /** Already translated and validated against the snapshot; the kernel revalidates on apply. */
  readonly commands: readonly NarratorCommand[];
  readonly card?: DecisionCardProse;
  /**
   * Replacement running notes, stored in `games.narrative_notes` (jsonb). W9 change: was a
   * string; now the structured `NarratorNotes` object.
   */
  readonly notesUpdate?: NarratorNotes;
  /** `narrator_calls.id`, for audit and for minting command IDs (`cmd:narrator:<callId>:<n>`). */
  readonly callId: string;
  /** W9 addition: model ID, or `"null-narrator"` on the fallback path (`narrator_calls.model`). */
  readonly model: string;
  /** W9 addition: `PROMPT_VERSION` (`narrator_calls.prompt_version`). */
  readonly promptVersion: string;
  /** W9 addition. */
  readonly usage?: NarratorUsage;
  /** W9 addition: set when the null path answered instead of the model, and why. */
  readonly fallback?: FallbackReason;
  /** W9 addition: intents the translator dropped (audit; also folded into the notes). */
  readonly dropped?: readonly DroppedIntent[];
}

// ---------------------------------------------------------------------------------------------
// LLM output schema (structured output)
// ---------------------------------------------------------------------------------------------

/**
 * Per-game choices the LLM may pick from. Built by the server from the snapshot and content so
 * the schema's enums list only things that exist. W0 decision: the plan schema is a factory over
 * this vocabulary rather than free strings validated after the fact.
 */
export interface NarratorVocabulary {
  /** Port def IDs. */
  readonly ports: readonly [string, ...string[]];
  /**
   * Machine instance IDs aboard. W9: only machines whose def has a fault catalog; when none do,
   * the builder uses `NO_CHOICE` so the enum stays non-empty and the translator drops it.
   */
  readonly machines: readonly [string, ...string[]];
  /** Fault keys across those machines' catalogs; the translator checks the pairing. */
  readonly faultKeys: readonly [string, ...string[]];
  /** Item def IDs that may be freight or luggage. */
  readonly cargoItems: readonly [string, ...string[]];
  /** External store keys across ports; the translator checks the pairing. */
  readonly storeKeys: readonly [string, ...string[]];
}

/** Placeholder enum value for a vocabulary list that would otherwise be empty (W9). */
export const NO_CHOICE = "(none)";

/** Coarse pay position inside the config price band; the translator maps it to credits. */
export const PAY_TIERS = ["low", "standard", "generous"] as const;
/** Coarse fault window; the translator maps it to relative ticks within config limits. */
export const FAULT_WINDOWS = ["soon", "later", "muchLater"] as const;
/** Coarse quantity; the translator maps it to a count within config limits. */
export const QUANTITIES = ["one", "few", "several"] as const;

export function buildNarratorPlanSchema(vocab: NarratorVocabulary) {
  const port = z.enum(vocab.ports);
  const decisionSide = z.strictObject({
    label: z.string().describe("What the captain says or does in reply, two to six words."),
    /** Side effect when chosen; `setCourse` needs `coursePort`. */
    effect: z.enum(["none", "setCourse"]),
    coursePort: port.nullable(),
  });

  // D25: every offer comes from a named person who says something; D24: nobody talks pay.
  const offerJob = z.strictObject({
    kind: z.literal("offerJob"),
    issuerName: z.string().describe("The person offering the job: given and family name."),
    issuerRole: z.string().describe("What they do, lower case, e.g. 'shift foreman'."),
    issuerOrg: z.string().nullable().describe("Who they work for, or null if nobody."),
    pitch: z
      .string()
      .describe(
        "One line the issuer says to the captain, in their own voice. At most 30 words. No pay, prices or numbers.",
      ),
    description: z.string().describe("One or two sentences about the job itself. No pay."),
    fromPort: port,
    toPort: port,
    cargoItem: z.enum(vocab.cargoItems),
    quantity: z.enum(QUANTITIES),
    payTier: z.enum(PAY_TIERS),
    urgency: z.enum(JOB_URGENCIES).describe("How pressing it sounds on the card."),
    /** Present it as an accept/decline card now. */
    surface: z.boolean(),
  });

  // W0 decision: V1 narrator spawns only existing item defs into port stores; generated defs and
  // NPC passengers (supported by the kernel command) wait until the vocabulary grows (D11).
  const spawnAtBoundary = z.strictObject({
    kind: z.literal("spawnAtBoundary"),
    port: port,
    store: z.enum(vocab.storeKeys),
    cargoItem: z.enum(vocab.cargoItems),
    quantity: z.enum(QUANTITIES),
  });

  const scheduleFault = z.strictObject({
    kind: z.literal("scheduleFault"),
    machine: z.enum(vocab.machines),
    faultKey: z.enum(vocab.faultKeys),
    window: z.enum(FAULT_WINDOWS),
  });

  // D26: shown for a moment after the choice, before the card closes.
  const aftermath = z
    .string()
    .describe(
      "What happens next if the captain picks this side, as one plain statement. At most 20 words. No numbers.",
    );

  // D29: a named person brings the card and speaks; null only for an observed scene.
  const speaker = z
    .string()
    .nullable()
    .describe(
      "Full name of the person speaking on the card, as the digest lists them, or null for an observed scene.",
    );
  const situation = z
    .string()
    .describe(
      "A stage line, then what the speaker says in quotes, in their own voice. Aim for 35 to 55 words, never more than 70. No numbers.",
    );

  const surfaceDecision = z.strictObject({
    kind: z.literal("surfaceDecision"),
    title: z.string().describe("Card heading, two to six words."),
    speaker,
    situation,
    left: decisionSide,
    right: decisionSide,
    leftAftermath: aftermath,
    rightAftermath: aftermath,
  });

  return z.strictObject({
    /** Private reasoning summary for the audit log; never shown to the player. */
    rationale: z.string(),
    intents: z.array(z.union([offerJob, spawnAtBoundary, scheduleFault, surfaceDecision])),
    /** Prose for the pending decision, when the hook is `policyDecision`; otherwise null. */
    card: z
      .strictObject({
        title: z.string(),
        speaker,
        situation,
        leftLabel: z.string(),
        rightLabel: z.string(),
        leftAftermath: aftermath,
        rightAftermath: aftermath,
      })
      .nullable(),
    /**
     * The full replacement running notes (W9: structured, see `NarratorNotes`). D31: the card
     * history is server-kept and not part of the plan; D32: threads are structured.
     */
    notes: z.strictObject({
      summary: z.string().describe("The story so far in a few sentences."),
      threads: z
        .array(
          z.strictObject({
            title: z.string().describe("Short name for the thread."),
            scale: z
              .enum(THREAD_SCALES)
              .describe(
                "beat: one card with a follow-up; episode: one complete story, usually a job's length, though it need not involve a job; season: returns every few jobs; series: a slow pressure that surfaces rarely.",
              ),
            people: z.array(z.string()).describe("Crew or cast involved, by full name."),
            stage: z.string().describe("One sentence: where the thread is now."),
            nextBeat: z
              .string()
              .describe(
                "One sentence: what must be true before it returns, and roughly what happens then.",
              ),
          }),
        )
        .describe(
          "Every open thread, rewritten in full: two to four alive at different scales. Retire the ones events have made moot.",
        ),
      cast: z
        .array(
          z.strictObject({
            name: z.string(),
            note: z.string(),
            portId: port.nullable().describe("The port where the captain can find them, if any."),
          }),
        )
        .describe(
          "Supporting characters you introduced (issuers, contacts); not the crew. Keep people the captain has met.",
        ),
    }),
  });
}

export type NarratorPlanSchema = ReturnType<typeof buildNarratorPlanSchema>;
export type NarratorPlan = z.infer<NarratorPlanSchema>;
export type NarratorIntent = NarratorPlan["intents"][number];

// ---------------------------------------------------------------------------------------------
// Intent → command translation
// ---------------------------------------------------------------------------------------------

export interface TranslationCtx {
  readonly snapshot: DeepReadonly<SaveEnvelope>;
  readonly content: ContentBundle;
  /** Commands are targeted at this tick (the hook tick, D5). */
  readonly hookTick: Tick;
  readonly callId: string;
  /** W9 addition: the hook being answered; defaults to the snapshot's pending hook. */
  readonly hook?: DeepReadonly<NarratorHook>;
}

export interface TranslationResult {
  readonly commands: readonly NarratorCommand[];
  /** W9 addition: prose for the pending policy decision, when the plan's card passed checks. */
  readonly card?: DecisionCardProse;
  /** Intents dropped with a reason (bad pairing, out of budget, stale target); logged, not fatal. */
  readonly dropped: readonly DroppedIntent[];
}

/**
 * Pure translation (W9 implements): tiers → numbers from config, names → IDs, pairing checks
 * (fault in machine's catalog, store in port), dry-run validation against the snapshot. Never
 * emits a kind outside `NARRATOR_COMMAND_KINDS`.
 */
export type TranslateIntents = (plan: NarratorPlan, ctx: TranslationCtx) => TranslationResult;
