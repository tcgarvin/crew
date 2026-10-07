/**
 * The staging call end to end (Dockside §6.1, D67): the staging prompt over the same digest the
 * story narrator reads (plus the dock being dressed), the staging schema, the staging translator.
 * The answer carries at most one `stageDock` command and never a `notesUpdate`, so the notes
 * pass through untouched. Any failure falls back to the null answer for this hook, an empty plan
 * (the sim's floor set), with `fallback` set; the server decides what a fallback means (D43,
 * with staging's exception).
 */
import type { ContentBundle, DeepReadonly } from "@crew/sim";
import type { FallbackReason, NarratorRequest, NarratorResponse } from "../contract";
import type { NarratorDigest } from "../digest";
import { FallbackError, callModel, contentOf, parseJsonReply, schemaIssue } from "../model-call";
import type { NarratorNotes } from "../notes";
import { nullNarratorResponse } from "../null";
import { planJsonSchema } from "../plan";
import { PROMPT_VERSION } from "../prompts/system";
import type { ModelTransport, ReasoningEffort } from "../transport";
import { type StagingEnvelope, buildStagingPlanSchema, stagingEnvelopeSchema } from "./plan";
import { buildStagingCatalogue, buildStagingPrompt } from "./prompt";
import { type StageDockHook, translateStaging } from "./translate";

/** A staging plan is a few hundred tokens at most; the rest is headroom. */
export const STAGING_MAX_TOKENS = 1_500;

export interface StagingInputs {
  readonly req: NarratorRequest;
  readonly hook: DeepReadonly<StageDockHook>;
  /** The request's snapshot, already migrated to the current schema. */
  readonly snapshot: NarratorRequest["snapshot"];
  readonly notes: NarratorNotes;
  readonly digest: NarratorDigest;
  readonly content: ContentBundle;
  readonly callId: string;
  readonly transport: ModelTransport | undefined;
  readonly model: string;
  readonly timeoutMs: number;
  readonly reasoningEffort: ReasoningEffort;
}

export interface StagingRun {
  readonly response: NarratorResponse;
  readonly catalogue: string;
  readonly prompt: ReturnType<typeof buildStagingPrompt>;
  readonly rawContent?: string;
  readonly plan?: StagingEnvelope;
  readonly error?: string;
}

function parseStaging(content: string): StagingEnvelope {
  const result = stagingEnvelopeSchema.safeParse(parseJsonReply(content));
  if (!result.success) throw schemaIssue("staging plan", result.error.issues);
  return result.data;
}

export async function runStaging(inputs: StagingInputs): Promise<StagingRun> {
  const { req, snapshot, content, callId } = inputs;
  const catalogue = buildStagingCatalogue(content);
  const prompt = buildStagingPrompt(catalogue, inputs.digest);
  const fallback = (reason: FallbackReason, error: string, rawContent?: string): StagingRun => ({
    response: nullNarratorResponse({ ...req, snapshot }, { callId, fallback: reason, content }),
    catalogue,
    prompt,
    ...(rawContent === undefined ? {} : { rawContent }),
    error,
  });
  if (inputs.transport === undefined) {
    return fallback("notConfigured", "no model transport configured");
  }
  let rawContent: string | undefined;
  try {
    const result = await callModel(inputs.transport, {
      model: inputs.model,
      system: prompt.system,
      user: prompt.user,
      continuation: [],
      schemaName: "staging_plan",
      jsonSchema: planJsonSchema(buildStagingPlanSchema()),
      maxTokens: STAGING_MAX_TOKENS,
      reasoningEffort: inputs.reasoningEffort,
      timeoutMs: inputs.timeoutMs,
    });
    rawContent = contentOf(result);
    const plan = parseStaging(rawContent);
    const translated = translateStaging(plan, {
      snapshot,
      content,
      hook: inputs.hook,
      callId,
      notes: inputs.notes,
    });
    const response: NarratorResponse = {
      commands: translated.commands,
      callId,
      model: result.model,
      promptVersion: PROMPT_VERSION,
      usage: result.usage,
      dropped: translated.dropped,
    };
    return { response, catalogue, prompt, rawContent, plan };
  } catch (err) {
    if (!(err instanceof FallbackError)) throw err;
    return fallback(err.reason, err.message, rawContent);
  }
}
