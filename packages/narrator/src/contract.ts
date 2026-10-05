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
 * - `NarratorPlan`: what the LLM emits. Flat, closed, name/choice based, no raw numbers where a
 *   tier will do, no recursion, every object `additionalProperties: false`, every property
 *   required. Ids (ports, items, machines, faults, stores) are plain strings the translator
 *   validates, optional strings are empty for "none", and only small fixed tiers are enums
 *   (D45: the grammar compiler charges for enums and unions). `card` alone is nullable.
 * - `NarratorCommand`: the kernel's strict command subset. Only the translator produces these.
 */
import {
  type ConfigDef,
  type ContentBundle,
  type DeepReadonly,
  HAZARD_KINDS,
  JOB_URGENCIES,
  MARKET_PRICE_TIERS,
  type NarratorCommand,
  type NarratorHook,
  type SaveEnvelope,
  type SimEvent,
  type Tick,
} from "@crew/sim";
import { z } from "zod";
import { type NarratorNotes, THREAD_SCALES, type Thread } from "./notes";

export type {
  CardShown,
  NarratorCastEntry,
  NarratorNotes,
  Thread,
  ThreadScale,
  WrittenThread,
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
 * D45: the schema no longer embeds the per-game vocabulary. Strict structured output compiles
 * the schema into a grammar, and per-game enums for ports, items, machines, faults and stores
 * pushed it past the provider's limit ("compiled grammar is too large"). Ids are plain strings
 * here; the capabilities block ("What you can do") is the model's list of valid ids and the
 * translator validates every one against the snapshot and content, with a drop reason the model
 * sees next call.
 */
const ID_HINT = 'from "What you can do"';
const idOf = (what: string) => z.string().describe(`${what} ${ID_HINT}.`);

/**
 * D45: optional strings are plain strings where empty means "none", not `nullable()`. Every
 * nullable field is a union type for the grammar compiler, and unions are what made the grammar
 * too large; the live probe showed the schema compiling once they were gone. Only `card` (a
 * whole object) and the intents union remain unions.
 */
const EMPTY_FOR_NONE = "empty for none";

/** Coarse pay position inside the config price band; the translator maps it to credits. */
export const PAY_TIERS = ["low", "standard", "generous"] as const;
/** Coarse fault window; the translator maps it to relative ticks within config limits. */
export const FAULT_WINDOWS = ["soon", "later", "muchLater"] as const;
/** Coarse quantity; the translator maps it to a count within config limits. */
export const QUANTITIES = ["one", "few", "several"] as const;
/**
 * D47: `stockMarket.count` as the model writes it. Structured outputs reject `minimum`/`maximum`
 * (see `contract.test.ts`), so the bound is a five-value enum of digit strings, 0 withdrawing
 * the item; the translator parses it and clamps again to `config.commerce.market.maxStockPerCommand`.
 */
export const STOCK_COUNTS = ["0", "1", "2", "3", "4"] as const;
/**
 * D78: a hazard's difficulty as the model writes it; the translator maps the tier to the
 * piloting difficulty in `config.hazards.difficulty`, so the model never writes the number.
 */
export const HAZARD_DIFFICULTIES = [
  "easy",
  "hard",
  "brutal",
] as const satisfies readonly (keyof ConfigDef["hazards"]["difficulty"])[];
export type HazardDifficulty = (typeof HAZARD_DIFFICULTIES)[number];

export function buildNarratorPlanSchema() {
  const port = idOf("Port id");
  const decisionSide = z.strictObject({
    label: z.string().describe("What the captain says or does, two to six words."),
    /**
     * Side effect when chosen; `setCourse` needs `coursePort`. Passengers-and-galaxy §4.2:
     * `endPassage` puts the current passenger off at the next docking (no fare).
     */
    effect: z.enum(["none", "setCourse", "endPassage"]),
    coursePort: z.string().describe("Port id if effect is setCourse; else empty."),
  });

  // D25: every offer comes from a named person who says something; D24: nobody talks pay.
  const offerJob = z.strictObject({
    kind: z.literal("offerJob"),
    issuerName: z.string().describe("Given and family name."),
    issuerRole: z.string().describe("What they do, lower case."),
    issuerOrg: z.string().describe(`Who they work for; ${EMPTY_FOR_NONE}.`),
    pitch: z.string().describe("One line the issuer says, in their voice. Max 30 words. No pay."),
    description: z.string().describe("One or two sentences about the job. No pay."),
    fromPort: port,
    toPort: port,
    cargoItem: idOf("Item id"),
    quantity: z.enum(QUANTITIES),
    payTier: z.enum(PAY_TIERS),
    urgency: z.enum(JOB_URGENCIES),
    /** Present it as an accept/decline card now. */
    surface: z.boolean(),
    /**
     * Passengers-and-galaxy §4.1: the issuer rides; `cargoItem` is then their luggage (empty for
     * none) and the fare is banded over path distance. Two plain booleans, not a new intent (D45).
     */
    passenger: z.boolean(),
    /** Passenger only: there and back to fromPort. Dropped with a reason without `passenger`. */
    roundTrip: z.boolean(),
  });

  // W0 decision: V1 narrator spawns only existing item defs into port stores; generated defs wait
  // until the vocabulary grows (D11). Passengers ride through `offerJob.passenger` instead.
  const spawnAtBoundary = z.strictObject({
    kind: z.literal("spawnAtBoundary"),
    port: port,
    store: idOf("Store key of that port"),
    cargoItem: idOf("Item id"),
    quantity: z.enum(QUANTITIES),
  });

  const scheduleFault = z.strictObject({
    kind: z.literal("scheduleFault"),
    machine: idOf("Machine id"),
    faultKey: idOf("faultKey of that machine"),
    window: z.enum(FAULT_WINDOWS),
  });

  // D78: the sixth lever, a piloting check for whoever has the helm when it fires. The hazard's
  // own kind is `hazard` because `kind` is the intent's discriminant.
  const scheduleHazard = z.strictObject({
    kind: z.literal("scheduleHazard"),
    hazard: z.enum(HAZARD_KINDS),
    difficulty: z.enum(HAZARD_DIFFICULTIES),
    window: z.enum(FAULT_WINDOWS),
  });

  // D47: what a port sells. The only way a part gets to a port; the crew buy it themselves.
  const stockMarket = z.strictObject({
    kind: z.literal("stockMarket"),
    port: port,
    cargoItem: idOf("Item id"),
    count: z.enum(STOCK_COUNTS),
    priceTier: z.enum(MARKET_PRICE_TIERS),
  });

  // D26: shown for a moment after the choice, before the card closes.
  const aftermath = z.string().describe("What happens next if chosen; max 20 words, no numbers.");

  // D29: a named person brings the card and speaks; empty only for an observed scene.
  const speaker = z
    .string()
    .describe("Who speaks, full name as the digest lists them; empty if observed.");
  const situation = z
    .string()
    .describe("A stage line, then their words in quotes. 35-55 words, max 70. No numbers.");

  // D39: a beat card foreshadows a thread without asking for a decision.
  const beatOfThread = z
    .string()
    .describe("Empty, or for a beat card the exact title of the thread it foreshadows.");

  // D56: a closing card names the thread it ends; the server retires that thread.
  const closesThread = z
    .string()
    .describe("Empty, or for a closing card the exact title of the thread it ends.");

  const surfaceDecision = z.strictObject({
    kind: z.literal("surfaceDecision"),
    title: z.string().describe("Card heading, two to six words."),
    speaker,
    situation,
    left: decisionSide,
    right: decisionSide,
    leftAftermath: aftermath,
    rightAftermath: aftermath,
    beatOfThread,
    closesThread,
  });

  return z.strictObject({
    /** Private reasoning summary for the audit log; never shown to the player. */
    rationale: z.string(),
    intents: z.array(
      z.union([
        offerJob,
        spawnAtBoundary,
        scheduleFault,
        surfaceDecision,
        stockMarket,
        scheduleHazard,
      ]),
    ),
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
      summary: z.string(),
      threads: z
        .array(
          z.strictObject({
            title: z.string(),
            scale: z.enum(THREAD_SCALES),
            people: z.array(z.string()).describe("Full names."),
            stage: z.string().describe("Where it is now."),
            nextBeat: z
              .string()
              .describe("What must be true before it returns, and roughly what then."),
          }),
        )
        .describe("Every open thread, rewritten in full; retire the moot ones."),
      cast: z
        .array(
          z.strictObject({
            name: z.string(),
            note: z.string(),
            portId: z.string().describe(`Port id where to find them; ${EMPTY_FOR_NONE}.`),
          }),
        )
        .describe("Supporting characters, not crew; keep those the captain has met."),
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
  /**
   * D39: the threads the digest showed, so a beat card can be checked against them (title match,
   * one beat card per thread). Absent = no stored threads; a beat card may still name a thread
   * the plan's notes introduce this call.
   */
  readonly threads?: readonly Thread[];
}

export interface TranslationResult {
  readonly commands: readonly NarratorCommand[];
  /** W9 addition: prose for the pending policy decision, when the plan's card passed checks. */
  readonly card?: DecisionCardProse;
  /** Intents dropped with a reason (bad pairing, out of budget, stale target); logged, not fatal. */
  readonly dropped: readonly DroppedIntent[];
  /**
   * D41: corrections that did not drop anything (a captain speaker nulled to an observed scene).
   * Fed back to the model with the drop reasons under "rejected last time".
   */
  readonly notes: readonly string[];
  /**
   * D39: the title (as written in notes) of the thread this call's beat card foreshadows, when a
   * surfaced card was a beat card; the notes merge sets `beatCardShown` on it.
   */
  readonly beatCardThread?: string;
  /**
   * D56: the title (as stored in notes) of the thread this call's closing card ends; the notes
   * merge retires it and the card history records it.
   */
  readonly closedThread?: string;
}

/**
 * Pure translation (W9 implements): tiers → numbers from config, names → IDs, existence checks
 * on every id (D45), pairing checks (fault in machine's catalog, store in port), dry-run
 * validation against the snapshot. Never emits a kind outside `NARRATOR_COMMAND_KINDS`.
 */
export type TranslateIntents = (plan: NarratorPlan, ctx: TranslationCtx) => TranslationResult;
