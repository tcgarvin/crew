/**
 * Digest projection, prompts, output schemas, intent-to-command translation and the narrator
 * call itself (W9). W0 contracts are in `./contract`.
 */
export * from "./contract";
export { buildCapabilities } from "./capabilities";
export { buildDigest, DIGEST_MAX_CHARS, type NarratorDigest } from "./digest";
export { applyDecisionEvents, recordCardsFromCall } from "./history";
export { EMPTY_NOTES, boundNotes, mergeThreads, parseNotes } from "./notes";
export { NULL_NARRATOR_MODEL, nullNarratorResponse } from "./null";
export { planJsonSchema, planSchemaFor } from "./plan";
export {
  HOOK_INSTRUCTIONS,
  type StoryHookKind,
  PROMPT_VERSION,
  STATIC_RULES,
  SYSTEM_PROMPT,
  buildPrompt,
} from "./prompts/index";
export {
  DEFAULT_NARRATOR_MODEL,
  NARRATOR_TIMEOUT_MS,
  type NarratorRun,
  type NarratorTrace,
  type RunNarratorCtx,
  runNarrator,
  runNarratorWithTrace,
} from "./run";
export { NARRATOR_TEXT_KEYS, renderTextRef, templateCard } from "./templates";
export {
  type ModelFinish,
  type ModelRequest,
  type ModelResult,
  type ModelTransport,
  TransportError,
} from "./transport";
export { commandIdFor, secretPhrases, translateIntents } from "./translate";
export {
  approachRequest,
  FAR_FIXTURE_PORT,
  FIXTURE_PASSENGER,
  FIXTURE_SCENARIO,
  farJobBoardRequest,
  jobBoardRequest,
  passengerAboardRequest,
  passengerOverdueRequest,
  quietTooLongRequest,
  stageDockRequest,
} from "./fixtures";
export { OPENROUTER_URL, openRouterTransport, systemContentParts } from "./openrouter";
