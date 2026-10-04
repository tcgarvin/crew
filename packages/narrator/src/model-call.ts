/**
 * One model call, shared by the story call (`run.ts`) and the staging call (`staging/run.ts`):
 * send the prompt through the injected transport, turn every way it can fail into a
 * `FallbackError` with a `FallbackReason`, and parse the reply as JSON. Each caller validates the
 * JSON against its own schema.
 */
import type { FallbackReason } from "./contract";
import {
  type ModelRequest,
  type ModelResult,
  type ModelTransport,
  TransportError,
} from "./transport";

export class FallbackError extends Error {
  constructor(
    readonly reason: FallbackReason,
    message: string,
  ) {
    super(message);
    this.name = "FallbackError";
  }
}

/** A `ModelRequest` with a timeout in place of the abort signal. */
type ModelCall = Omit<ModelRequest, "signal"> & { readonly timeoutMs: number };

export async function callModel(transport: ModelTransport, call: ModelCall): Promise<ModelResult> {
  const { timeoutMs, ...request } = call;
  try {
    return await transport({ ...request, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof TransportError) throw new FallbackError(err.kind, err.message);
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new FallbackError("timeout", "narrator call timed out");
    }
    // A transport that throws anything else is still a provider failure, not a game failure.
    throw new FallbackError("apiError", err instanceof Error ? err.message : String(err));
  }
}

/** The reply text, or the fallback reason a refusal, truncation or empty reply means. */
export function contentOf(result: ModelResult): string {
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

export function parseJsonReply(content: string): unknown {
  try {
    return JSON.parse(stripFence(content));
  } catch {
    throw new FallbackError("schemaInvalid", "model output is not JSON");
  }
}

/** A zod failure as the fallback message: the first issue's path and text. */
export function schemaIssue(
  what: string,
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): FallbackError {
  const issue = issues[0];
  return new FallbackError(
    "schemaInvalid",
    `${what} failed validation at ${issue?.path.map(String).join(".") ?? "?"}: ${issue?.message ?? ""}`,
  );
}
