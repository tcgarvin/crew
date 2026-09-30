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
import type {
  ContentBundle,
  DeepReadonly,
  NarratorCommand,
  NarratorHook,
  SaveEnvelope,
  SimEvent,
  Tick,
} from "@crew/sim";
import { z } from "zod";

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
 */
export interface DecisionCardProse {
  readonly decisionId: string;
  readonly prompt: string;
  readonly left: string;
  readonly right: string;
}

export interface NarratorResponse {
  /** Already translated and validated against the snapshot; the kernel revalidates on apply. */
  readonly commands: readonly NarratorCommand[];
  readonly card?: DecisionCardProse;
  /** Replacement running summary, stored in `games.narrative_notes`. */
  readonly notesUpdate?: string;
  /** `narrator_calls.id`, for audit and for minting command IDs (`cmd:narrator:<callId>:<n>`). */
  readonly callId: string;
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
  /** Machine instance IDs aboard. */
  readonly machines: readonly [string, ...string[]];
  /** Fault keys across those machines' catalogs; the translator checks the pairing. */
  readonly faultKeys: readonly [string, ...string[]];
  /** Item def IDs that may be freight or luggage. */
  readonly cargoItems: readonly [string, ...string[]];
  /** External store keys across ports; the translator checks the pairing. */
  readonly storeKeys: readonly [string, ...string[]];
}

/** Coarse pay position inside the config price band; the translator maps it to credits. */
export const PAY_TIERS = ["low", "standard", "generous"] as const;
/** Coarse fault window; the translator maps it to relative ticks within config limits. */
export const FAULT_WINDOWS = ["soon", "later", "muchLater"] as const;
/** Coarse quantity; the translator maps it to a count within config limits. */
export const QUANTITIES = ["one", "few", "several"] as const;

export function buildNarratorPlanSchema(vocab: NarratorVocabulary) {
  const port = z.enum(vocab.ports);
  const decisionSide = z.strictObject({
    label: z.string().describe("Two to five words, captain's voice."),
    /** Side effect when chosen; `setCourse` needs `coursePort`. */
    effect: z.enum(["none", "setCourse"]),
    coursePort: port.nullable(),
  });

  const offerJob = z.strictObject({
    kind: z.literal("offerJob"),
    issuer: z.string(),
    description: z.string().describe("One or two sentences a dockside contact would say."),
    fromPort: port,
    toPort: port,
    cargoItem: z.enum(vocab.cargoItems),
    quantity: z.enum(QUANTITIES),
    payTier: z.enum(PAY_TIERS),
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

  const surfaceDecision = z.strictObject({
    kind: z.literal("surfaceDecision"),
    prompt: z.string().describe("The situation, from the captain's point of view. No numbers."),
    left: decisionSide,
    right: decisionSide,
  });

  return z.strictObject({
    /** Private reasoning summary for the audit log; never shown to the player. */
    rationale: z.string(),
    intents: z.array(z.union([offerJob, spawnAtBoundary, scheduleFault, surfaceDecision])),
    /** Prose for the pending decision, when the hook is `policyDecision`; otherwise null. */
    card: z.strictObject({ prompt: z.string(), left: z.string(), right: z.string() }).nullable(),
    /** The full replacement running summary of the story so far. */
    notes: z.string(),
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
}

export interface TranslationResult {
  readonly commands: readonly NarratorCommand[];
  /** Intents dropped with a reason (bad pairing, out of budget, stale target); logged, not fatal. */
  readonly dropped: readonly { readonly intentIndex: number; readonly reason: string }[];
}

/**
 * Pure translation (W9 implements): tiers → numbers from config, names → IDs, pairing checks
 * (fault in machine's catalog, store in port), dry-run validation against the snapshot. Never
 * emits a kind outside `NARRATOR_COMMAND_KINDS`.
 */
export type TranslateIntents = (plan: NarratorPlan, ctx: TranslationCtx) => TranslationResult;
