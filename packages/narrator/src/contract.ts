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
 *   (§plan-schema-in-the-prompt: the grammar compiler charges for enums and unions). `card` alone
 * is nullable.
 * - `NarratorCommand`: the kernel's strict command subset. Only the translator produces these.
 */
import {
  BODY_PARTS,
  CALL_BACK_WHEN,
  type ConfigDef,
  type ContentBundle,
  DAMAGE_TYPES,
  type DeepReadonly,
  ERRAND_KINDS,
  ERRAND_WANTS,
  FIELD_DETECTIONS,
  FIELD_SEVERITIES,
  FORCED_HAZARD_OUTCOMES,
  HAZARD_KINDS,
  JOB_URGENCIES,
  MACHINE_EFFECTS,
  MARKET_PRICE_TIERS,
  NARRATOR_MEMORY_KEYS,
  type NarratorCommand,
  type NarratorHook,
  ROCK_SIZES,
  type SaveEnvelope,
  type SimEvent,
  type Tick,
  WOUND_SEVERITIES,
} from "@crew/sim";
import { z } from "zod";
import {
  BEAT_TENSIONS,
  type NarratorNotes,
  PLAN_TIERS,
  TEMPOS,
  THREAD_SCALES,
  type Thread,
} from "./notes";
import type { BeatAttribution } from "./story-plan";

export type {
  ArcSketch,
  CardShown,
  NarratorCastEntry,
  NarratorNotes,
  PlannedBeat,
  StoryPlan,
  Thread,
  ThreadScale,
  WrittenThread,
} from "./notes";
export { THREAD_SCALES } from "./notes";
export { CALL_BACK_WHEN } from "@crew/sim";

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
   * §aftermath-caption (additive, 2026-09-30): what happens next once that side is chosen, shown
   * briefly before the card closes. At most `AFTERMATH_MAX_WORDS` words, no numbers. Absent = none
   * available.
   */
  readonly leftAftermath?: string;
  readonly rightAftermath?: string;
  /**
   * §spoken-cards (additive, 2026-10-01): who is speaking on the card, full name as the digest
   * lists them; absent for an observed scene.
   */
  readonly speaker?: string;
}

/** GDD §22 card budget, 70 words (§spoken-cards; target 35 to 55). */
export const CARD_SITUATION_MAX_WORDS = 70;
/** §issuers-and-pitches: an issuer's pitch is one line of dialogue. */
export const PITCH_MAX_WORDS = 30;
/** §aftermath-caption: an aftermath caption is one plain statement. */
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
 * §narrator-authority: the schema no longer embeds the per-game vocabulary. Strict structured
 * output compiles the schema into a grammar, and per-game enums for ports, items, machines, faults
 * and stores pushed it past the provider's limit ("compiled grammar is too large"). Ids are plain
 * strings here; the capabilities block ("What you can do") is the model's list of valid ids and the
 * translator validates every one against the snapshot and content, with a drop reason the model
 * sees next call.
 */
/**
 * §plan-schema-in-the-prompt: the rules say once that every id is copied from "What you can do",
 * so a field's description names only what it is (the schema rides in every call's prompt, D53).
 */
const idOf = (what: string) => z.string().describe(`${what}.`);
/** A plain id field whose name says what it is (`fromPort`, `cargoItem`, `machine`, `site`). */
const plainId = () => z.string();

/**
 * §narrator-authority: optional strings are plain strings where empty means "none", not
 * `nullable()`. Every nullable field is a union type for the grammar compiler, and unions are what
 * made the grammar too large; the live probe showed the schema compiling once they were gone. Only
 * `card` (a whole object) and the intents union remain unions.
 */
const EMPTY_FOR_NONE = "empty for none";

/** Coarse pay position inside the config price band; the translator maps it to credits. */
export const PAY_TIERS = ["low", "standard", "generous"] as const;
/** Coarse fault window; the translator maps it to relative ticks within config limits. */
export const FAULT_WINDOWS = ["soon", "later", "muchLater"] as const;
export type FaultWindow = (typeof FAULT_WINDOWS)[number];
/** Coarse quantity; the translator maps it to a count within config limits. */
export const QUANTITIES = ["one", "few", "several"] as const;
/**
 * §market-lever: `stockMarket.count` as the model writes it. Structured outputs reject
 * `minimum`/`maximum` (see `contract.test.ts`), so the bound is a five-value enum of digit strings,
 * 0 withdrawing the item; the translator parses it and clamps again to
 * `config.commerce.market.maxStockPerCommand`.
 */
export const STOCK_COUNTS = ["0", "1", "2", "3", "4"] as const;
/**
 * §hazard-and-field-levers: a hazard's difficulty as the model writes it; the translator maps the
 * tier to the piloting difficulty in `config.hazards.difficulty`, so the model never writes the
 * number.
 */
export const HAZARD_DIFFICULTIES = [
  "easy",
  "hard",
  "brutal",
] as const satisfies readonly (keyof ConfigDef["hazards"]["difficulty"])[];
export type HazardDifficulty = (typeof HAZARD_DIFFICULTIES)[number];

/**
 * §private-talk: a `privateTalk` side's tone as the model writes it; empty for any other effect
 * (§narrator-authority: an empty string, not a nullable).
 */
export const PRIVATE_TALK_TONES = ["warm", "stern", ""] as const;

/**
 * §scheduling-a-field: when in the field a scripted impact lands, as the model writes it; the
 * translator maps the tier to seconds into the severity's length (`FIELD_MOMENT_SHARE`), so the
 * model never writes the number.
 */
export const FIELD_MOMENTS = ["early", "middle", "late"] as const;
export type FieldMoment = (typeof FIELD_MOMENTS)[number];
/**
 * §scheduling-a-field: a scripted impact's rock, empty for the severity's own draw
 * (§narrator-authority: empty, not nullable).
 */
export const SCRIPTED_ROCKS = [...ROCK_SIZES, ""] as const;
/**
 * §scheduling-a-field: a scripted impact's effect on the machines it hits, empty for the rolled
 * table.
 */
export const SCRIPTED_EFFECTS = [...MACHINE_EFFECTS, ""] as const;

/**
 * D105: the side of the expedition's arrival card the narrator lets the crew get in unseen by,
 * empty for neither (§narrator-authority: empty, not nullable); the translator turns a side into
 * `markUnseen` with that side's plan.
 */
export const UNSEEN_SIDES = ["", "left", "right"] as const;
export type UnseenSide = (typeof UNSEEN_SIDES)[number];

/**
 * §unseen-odds: the chance the marked side works, a whole percent from 0 to 100 written as a
 * string (`card.unseenOdds`); empty is `UNSEEN_ODDS_CERTAIN`, D105's certain way in.
 */
export const UNSEEN_ODDS_PATTERN = /^(?:100|[1-9]?\d)$/;

/**
 * §strike-lever: where a strike lands, empty for the body's own draw (§narrator-authority: empty,
 * not nullable).
 */
export const STRIKE_PARTS = [...BODY_PARTS, ""] as const;

/**
 * §forced-faults-and-hazards: a hazard's decided outcome, empty to let the helm's roll decide
 * (§narrator-authority: empty, not nullable).
 */
export const HAZARD_OUTCOMES = ["", ...FORCED_HAZARD_OUTCOMES] as const;

/** §side-effects: what a card side does when chosen, as the model writes it. */
export const SIDE_EFFECTS = ["none", "setCourse", "endPassage", "privateTalk"] as const;
export type SideEffect = (typeof SIDE_EFFECTS)[number];

/**
 * §follow-up-cards: which side a follow-up card comes after: `left`, `right`, or `either` (the
 * same card after whichever side the captain picks).
 */
export const FOLLOW_UP_SIDES = ["left", "right", "either"] as const;
export type FollowUpSide = (typeof FOLLOW_UP_SIDES)[number];
/**
 * §follow-up-cards, §tried-sides: a follow-up's `on` as the model writes it: after a side (for a
 * try, after it worked), or `failed`, after a tried side's roll fails.
 */
export const FOLLOW_UP_ON = [...FOLLOW_UP_SIDES, "failed"] as const;
export type FollowUpOn = (typeof FOLLOW_UP_ON)[number];

export function buildNarratorPlanSchema() {
  const port = plainId();
  /**
   * §beat-attribution: the episode beat an intent serves, copied from "Your plan", empty for none.
   * Described once (on surfaceDecision, and in the prompt): it is on every intent, and the schema
   * rides in every call's prompt under D53's budget.
   */
  const beat = z.string();
  const decisionSide = z.strictObject({
    label: z.string().describe("What the captain says or does, 2-6 words."),
    /**
     * Side effect when chosen; `setCourse` needs `coursePort`. Passengers-and-galaxy §4.2:
     * `endPassage` puts the current passenger off at the next docking (no fare). §private-talk:
     * `privateTalk` calls a crew member (`talkWith`) to the captain's cabin for a word in `tone`.
     */
    effect: z.enum(SIDE_EFFECTS),
    coursePort: z.string().describe("If setCourse; else empty."),
    talkWith: z.string().describe("Full name if privateTalk."),
    tone: z.enum(PRIVATE_TALK_TONES),
    /**
     * §tried-sides: a whole percent as a string, so empty can mean "not a try"; the failure branch
     * is `failEffect`, the levers named by index in `failLevers`, and the card's `*FailAftermath`.
     */
    odds: z.string().describe("0-100 for a try; else empty."),
    failEffect: z.enum(SIDE_EFFECTS),
    failLevers: z.array(z.number()).describe("Intent indexes, only on failure."),
  });

  // §issuers-and-pitches: every offer comes from a named person who says something;
  // §cards-never-mention-pay: nobody talks pay.
  const offerJob = z.strictObject({
    kind: z.literal("offerJob"),
    beat,
    issuerName: z.string().describe("Given and family name."),
    issuerRole: z.string().describe("What they do, lower case."),
    issuerOrg: z.string().describe(`Who they work for; ${EMPTY_FOR_NONE}.`),
    pitch: z.string().describe("One line the issuer says, in their voice. Max 30 words. No pay."),
    description: z.string().describe("One or two sentences about the job. No pay."),
    fromPort: port,
    toPort: port,
    cargoItem: plainId(),
    quantity: z.enum(QUANTITIES),
    payTier: z.enum(PAY_TIERS),
    /**
     * §money-levers: the exact pay in credits when the story is the sum, 0 for the tier's. A plain
     * number: structured outputs reject `minimum`/`maximum`, so the translator bounds it.
     */
    payCredits: z.number().describe("Exact pay in credits; 0 to use payTier."),
    urgency: z.enum(JOB_URGENCIES),
    /** Present it as an accept/decline card now. */
    surface: z.boolean(),
    /**
     * Passengers-and-galaxy §4.1: the issuer rides; `cargoItem` is then their luggage (empty for
     * none) and the fare is banded over path distance. Two plain booleans, not a new intent
     * (§narrator-authority).
     */
    passenger: z.boolean(),
    /** Passenger only: there and back to fromPort. Dropped with a reason without `passenger`. */
    roundTrip: z.boolean(),
    /**
     * Expeditions A2 (§6): an errand to a landing site and back. All five are empty for freight and
     * passages (§narrator-authority); the capability block explains them, so the descriptions stay
     * under eight words (plan call 7: the schema's size).
     */
    errandKind: z.enum(["", ...ERRAND_KINDS]).describe(`Errand to a site; ${EMPTY_FOR_NONE}.`),
    site: plainId(),
    targetName: z.string().describe(`Who to fetch; ${EMPTY_FOR_NONE}.`),
    targetItem: plainId(),
    wants: z.enum(["", ...ERRAND_WANTS]).describe(`Target alive or dead; ${EMPTY_FOR_NONE}.`),
  });

  // W0 decision: V1 narrator spawns only existing item defs into port stores; generated defs wait
  // until the vocabulary grows (§narrator-authority). Passengers ride through `offerJob.passenger`
  // instead.
  const spawnAtBoundary = z.strictObject({
    kind: z.literal("spawnAtBoundary"),
    beat,
    port: port,
    store: idOf("Store key of that port"),
    cargoItem: plainId(),
    quantity: z.enum(QUANTITIES),
  });

  const scheduleFault = z.strictObject({
    kind: z.literal("scheduleFault"),
    beat,
    machine: plainId(),
    faultKey: idOf("faultKey of that machine"),
    window: z.enum(FAULT_WINDOWS),
  });

  // §hazard-and-field-levers: the sixth lever, a piloting check for whoever has the helm when it
  // fires. The hazard's own kind is `hazard` because `kind` is the intent's discriminant.
  const scheduleHazard = z.strictObject({
    kind: z.literal("scheduleHazard"),
    beat,
    hazard: z.enum(HAZARD_KINDS),
    difficulty: z.enum(HAZARD_DIFFICULTIES),
    window: z.enum(FAULT_WINDOWS),
    outcome: z.enum(HAZARD_OUTCOMES).describe("Decided outcome; empty to roll."),
  });

  // §scheduling-a-field: the seventh lever, an asteroid field on the leg. `scripted` hits are the
  // narrator's chosen outcomes; the translator resolves each target by name and caps the count.
  const scheduleField = z.strictObject({
    kind: z.literal("scheduleField"),
    beat,
    severity: z.enum(FIELD_SEVERITIES),
    detection: z.enum(FIELD_DETECTIONS),
    window: z.enum(FAULT_WINDOWS),
    scripted: z
      .array(
        z.strictObject({
          target: z.string().describe("Machine id or room name."),
          at: z.enum(FIELD_MOMENTS),
          rock: z.enum(SCRIPTED_ROCKS),
          effect: z.enum(SCRIPTED_EFFECTS),
        }),
      )
      .describe("Chosen hits, at most 3; empty for none."),
  });

  // §market-lever: what a port sells. The only way a part gets to a port; the crew buy it
  // themselves.
  const stockMarket = z.strictObject({
    kind: z.literal("stockMarket"),
    beat,
    port: port,
    cargoItem: plainId(),
    count: z.enum(STOCK_COUNTS),
    priceTier: z.enum(MARKET_PRICE_TIERS),
  });

  // §strike-lever: a wound, a down or a death through the body rules; the capability block explains
  // the fields, so the descriptions stay short.
  const strike = z.strictObject({
    kind: z.literal("strike"),
    beat,
    who: z.string().describe("Full name as the digest lists them."),
    severity: z.enum(WOUND_SEVERITIES),
    type: z.enum(DAMAGE_TYPES),
    part: z.enum(STRIKE_PARTS).describe("Empty for the body's draw."),
    byWho: z.string().describe(`Who did it, full name; ${EMPTY_FOR_NONE}.`),
    how: z.string().describe("For the log. Max 120 characters."),
  });

  // §money-levers: a sum into (positive) or out of (negative) the ship's money.
  const transact = z.strictObject({
    kind: z.literal("transact"),
    beat,
    amount: z.number().describe("+ into the ship's money, - out. Never 0."),
    memo: z.string().describe("What it is for, a few words."),
    counterparty: z.string().describe(`Who pays or is paid; ${EMPTY_FOR_NONE}.`),
  });

  // D106's other outcome levers: what is felt, what is noticed, what breaks now. The capability
  // block explains the fields; descriptions stay short for the schema budget.
  const fullName = z.string();
  const plantMemory = z.strictObject({
    kind: z.literal("plantMemory"),
    beat,
    from: z.string().describe("Who remembers, full name."),
    to: fullName,
    key: z.enum(NARRATOR_MEMORY_KEYS),
    lasting: z.boolean(),
  });
  const fallOut = z.strictObject({
    kind: z.literal("fallOut"),
    beat,
    a: fullName,
    b: fullName,
    over: z.string().describe("Who or what, a few words."),
  });
  const giveThought = z.strictObject({
    kind: z.literal("giveThought"),
    beat,
    who: fullName,
    key: idOf("Thought key"),
    ref: z.string().describe(`About whom, full name; ${EMPTY_FOR_NONE}.`),
  });
  const faultNow = <K extends "reveal" | "injectFault">(kind: K) =>
    z.strictObject({
      kind: z.literal(kind),
      beat,
      machine: plainId(),
      faultKey: z.string(),
    });

  // §aftermath-caption: shown for a moment after the choice, before the card closes.
  const aftermath = z.string().describe("Max 20 words, no numbers.");

  // §spoken-cards: a named person brings the card and speaks; empty only for an observed scene.
  const speaker = z.string().describe("Full name; empty if observed.");
  const situation = z
    .string()
    .describe("A stage line, then their words in quotes. 35-55 words, max 70. No numbers.");

  // §beat-cards: a beat card foreshadows a thread without asking for a decision.
  const beatOfThread = z
    .string()
    .describe("Empty, or for a beat card the exact title of the thread it foreshadows.");

  // §closing-cards: a closing card names the thread it ends; the server retires that thread.
  const closesThread = z
    .string()
    .describe("Empty, or for a closing card the exact title of the thread it ends.");

  // §follow-up-cards: the second panel of a scene, the same card shape without its own follow-up
  // or thread fields. No descriptions: they are the card's own, and the schema rides in every
  // call's prompt (D53).
  const plainSide = z.strictObject({
    label: z.string(),
    effect: z.enum(SIDE_EFFECTS),
    coursePort: z.string(),
    talkWith: z.string(),
    tone: z.enum(PRIVATE_TALK_TONES),
  });
  const followUpCard = z.strictObject({
    title: z.string(),
    speaker: z.string(),
    situation: z.string(),
    left: plainSide,
    right: plainSide,
    leftAftermath: z.string(),
    rightAftermath: z.string(),
  });
  const followUps = z
    .array(z.strictObject({ on: z.enum(FOLLOW_UP_ON), card: followUpCard }))
    .describe("Usually empty.");

  const surfaceDecision = z.strictObject({
    kind: z.literal("surfaceDecision"),
    beat: z
      .string()
      .describe('On every intent: the episode beat it serves, from "Your plan"; else empty.'),
    title: z.string().describe("Card heading, two to six words."),
    speaker,
    situation,
    left: decisionSide,
    right: decisionSide,
    leftAftermath: aftermath,
    rightAftermath: aftermath,
    leftFailAftermath: z.string(),
    rightFailAftermath: z.string(),
    beatOfThread,
    closesThread,
    followUps,
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
        scheduleField,
        strike,
        transact,
        plantMemory,
        fallOut,
        giveThought,
        faultNow("reveal"),
        faultNow("injectFault"),
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
        // D105: the description stays under eight words; the capability block explains it.
        unseen: z.enum(UNSEEN_SIDES).describe("Arrival card side that sneaks in; else empty."),
        // §unseen-odds: a string, so "" can mean no number named (the certain mark).
        unseenOdds: z.string().describe('Percent 0-100 it works; "" is 100.'),
      })
      .nullable(),
    /**
     * §requested-call-back: when the model wants its next call and why. Required of the model:
     * every story call replaces the standing request, so it states it each time (`nextPort` asks
     * for nothing).
     */
    callBack: z.strictObject({
      // §requested-call-back: the moments are explained in the rules (callBack), not here.
      when: z.enum(CALL_BACK_WHEN).describe("When you want your next call."),
      why: z.string().describe("Private: what you mean to do then. Max 200 characters."),
      holdQuiet: z.boolean().describe("Doubles the quiet wait once."),
    }),
  });
}

/**
 * §notes-turn: the running notes the model writes in its follow-up turn, after the plan (W9: the
 * full replacement, structured, see `NarratorNotes`). §card-history: the card history is
 * server-kept and not written by the model; §threads-and-scales: threads are structured;
 * §past-arcs: a thread carries its arc notes, and one that ends gets its summary in `endedArcs`.
 */
export function buildNotesSchema() {
  const beat = z.strictObject({
    name: z.string().describe("Two to six words; its identity."),
    what: z.string().describe("One line of intent. Max 160 characters."),
    tension: z.enum(BEAT_TENSIONS),
    thread: z.string().describe('Exact title from "Open threads" it advances; empty for none.'),
    decided: z.boolean().describe("You will make it so with a lever, not hope for it."),
  });
  const sketch = (what: string) =>
    z
      .strictObject({
        premise: z
          .string()
          .describe(
            "One or two sentences. Empty keeps this tier as it stands. Max 300 characters.",
          ),
        beats: z.array(beat).describe("In order, at most 6; keep landed beats."),
        until: z.string().describe("When it is done; empty for the episode."),
        tempo: z.enum(TEMPOS),
        revised: z.string().describe("Why it last changed; empty on a first sketch."),
      })
      .describe(what);
  return z.strictObject({
    summary: z.string(),
    threads: z
      .array(
        z.strictObject({
          title: z.string(),
          scale: z.enum(THREAD_SCALES),
          people: z.array(z.string()).describe("Full names."),
          arcNotes: z
            .string()
            .describe(
              "The arc so far: what has happened in it, what went wrong or changed, what the captain chose, and where it stands now. Max 600 characters.",
            ),
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
    retired: z
      .array(z.string())
      .describe(
        'Titles copied from "Open threads" that end without a closing card of their own because events already made the ending plain (an offer the captain turned down, a story another card already wrapped up); usually empty.',
      ),
    endedArcs: z
      .array(
        z.strictObject({
          title: z.string().describe('The ended thread\'s title, copied from "Open threads".'),
          shape: z
            .string()
            .describe(
              'A few words on what kind of story it was, e.g. "cargo run, no trouble", "passenger with a past", "stuck in the rocks". Max 60 characters.',
            ),
          summary: z
            .string()
            .describe(
              "What happened, what went wrong or changed, what the captain chose, how it came out. Max 500 characters.",
            ),
        }),
      )
      .describe(
        "One for every thread that ends this call: the one your closing card closed and each one in retired; usually empty.",
      ),
    plan: z
      .strictObject({
        season: sketch("A movement a beat; the premise is the question the season asks."),
        arc: sketch("Each beat a whole episode to come."),
        episode: sketch("A card, an offer, a pressure or a lever a beat."),
        ended: z
          .array(z.enum(PLAN_TIERS))
          .describe(
            "Tiers that finished this call; write the next in the same tier, or leave it empty.",
          ),
        landed: z
          .array(z.string())
          .describe("Exact names of arc or season beats that happened this call; usually empty."),
      })
      .describe('Your plan (see "Your plan"); the server keeps each beat\'s status.'),
  });
}

export type NotesSchema = ReturnType<typeof buildNotesSchema>;
export type WrittenNotes = z.infer<NotesSchema>;

export type NarratorPlanSchema = ReturnType<typeof buildNarratorPlanSchema>;
type ModelPlan = z.infer<NarratorPlanSchema>;
export type CallBackPlan = ModelPlan["callBack"];
/**
 * A plan as the translator takes it. §requested-call-back: the model always writes `callBack` (the
 * schema requires it); a plan built in code (the null narrator, tests) may leave it out, and then
 * no call-back request is made and the standing one stays.
 */
export type NarratorPlan = Omit<ModelPlan, "callBack"> & {
  readonly callBack?: Omit<CallBackPlan, "holdQuiet"> & { readonly holdQuiet?: boolean };
};
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
   * §beat-cards: the threads the digest showed, so a beat card can be checked against them (title
   * match, one beat card per thread). Absent = no stored threads; a beat card may still name a
   * thread the plan's notes introduce this call.
   */
  readonly threads?: readonly Thread[];
  /**
   * §closing-cards: titles of threads a card already closed (from "What the captain has seen"), so
   * a second closing card for one is dropped while a closing card naming no thread at all still
   * goes up.
   */
  readonly closedThreads?: readonly string[];
}

export interface TranslationResult {
  readonly commands: readonly NarratorCommand[];
  /** W9 addition: prose for the pending policy decision, when the plan's card passed checks. */
  readonly card?: DecisionCardProse;
  /** Intents dropped with a reason (bad pairing, out of budget, stale target); logged, not fatal. */
  readonly dropped: readonly DroppedIntent[];
  /**
   * §captain-never-speaks: corrections that did not drop anything (a captain speaker nulled to an
   * observed scene). Fed back to the model with the drop reasons under "rejected last time".
   */
  readonly notes: readonly string[];
  /**
   * §beat-cards: the title (as written in notes) of the thread this call's beat card foreshadows,
   * when a surfaced card was a beat card; the notes merge sets `beatCardShown` on it.
   */
  readonly beatCardThread?: string;
  /**
   * §closing-cards: the title (as stored in notes) of the thread this call's closing card ends; the
   * notes merge retires it and the card history records it.
   */
  readonly closedThread?: string;
  /** §beat-attribution: the intents that named a beat, with the command each became. */
  readonly beats: readonly BeatAttribution[];
}

/**
 * Pure translation (W9 implements): tiers → numbers from config, names → IDs, existence checks
 * on every id (§narrator-authority), pairing checks (fault in machine's catalog, store in port),
 * dry-run validation against the snapshot. Never emits a kind outside `NARRATOR_COMMAND_KINDS`.
 */
export type TranslateIntents = (plan: NarratorPlan, ctx: TranslationCtx) => TranslationResult;
