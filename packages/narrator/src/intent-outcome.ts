/**
 * What the story translator (`translate.ts`) and the staging translator (`staging/translate.ts`)
 * share about untrusted intents: the per-step outcome, reading an intent's kind before it is
 * parsed, and the reason a schema failure is dropped with.
 */

export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };
export const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
export const no = (reason: string): Outcome<never> => ({ ok: false, reason });

/** The `kind` an unparsed intent claims (clipped), or `"unknown"`. */
export function kindOf(raw: unknown): string {
  if (raw !== null && typeof raw === "object" && "kind" in raw) {
    const kind = (raw as { kind: unknown }).kind;
    if (typeof kind === "string") return kind.slice(0, 40);
  }
  return "unknown";
}

/** The drop reason for an intent that failed its schema: the first issue's path and text. */
export function invalidIntentReason(
  kind: string,
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): string {
  const issue = issues[0];
  return `${kind}: invalid ${issue?.path.join(".") ?? ""} (${issue?.message ?? "bad shape"})`;
}

/** Whitespace runs collapsed to one space, ends trimmed. */
export function collapseWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}
