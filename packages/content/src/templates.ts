/**
 * Deterministic card text for decisions that carry template keys (`TextRef.key`) and no prose:
 * used by the null narrator and by the web host, which renders it immediately and swaps in the
 * narrator's prose if it arrives (GDD §22: captain's point of view, two sides, no numeric
 * consequences, so `pay` is never printed).
 *
 * Integration 2: moved here from `@crew/narrator` because `apps/web` may not import the narrator
 * (dependency-cruiser `web-no-secrets`); `@crew/narrator` re-exports it. Pure; `@crew/sim` is
 * imported for types only.
 */
import type { ContentBundle, Decision, DeepReadonly, PortDefId, TextRef } from "@crew/sim";

/**
 * The text of a decision card. Structurally identical to `@crew/narrator`'s `DecisionCardProse`
 * (the narrator's `card` response), so either can be shown by the same modal.
 */
export interface DecisionCardText {
  readonly decisionId: string;
  readonly title: string;
  readonly situation: string;
  readonly leftLabel: string;
  readonly rightLabel: string;
}

/** Template keys used by narrator-authored cards; prose is always present on these. */
export const NARRATOR_TEXT_KEYS = {
  title: "narrator.decision.title",
  situation: "narrator.decision",
  side: "narrator.decision.side",
  jobDescription: "narrator.job.description",
} as const;

type Params = Readonly<Record<string, string | number>>;

function portLabel(value: string | number | undefined, content: ContentBundle | undefined) {
  if (value === undefined) return "another port";
  const id = String(value);
  return content?.ports[id as PortDefId]?.name ?? id;
}

const TEMPLATES: Readonly<Record<string, (p: Params, c: ContentBundle | undefined) => string>> = {
  "job.offer": (p, c) =>
    `${p.issuer ?? "A dockside broker"} has freight bound from ${portLabel(p.from, c)} to ${portLabel(p.to, c)} and wants us to carry it.`,
  "job.offer.accept": () => "Take the job",
  "job.offer.decline": () => "Pass on it",
  "job.template": () => "A routine freight contract.",
  "decision.accept": () => "Accept",
  "decision.decline": () => "Decline",
  [NARRATOR_TEXT_KEYS.situation]: () => "Something needs the captain's call.",
  [NARRATOR_TEXT_KEYS.side]: () => "Decide",
};

/** Title per prompt key; anything else gets a generic heading. */
const TITLES: Readonly<Record<string, string>> = {
  "job.offer": "A job offer",
};

function humanize(key: string): string {
  const last = key.split(".").pop() ?? key;
  const words = last
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Prose if present, else the template, else a humanized key. Never throws. */
export function renderTextRef(ref: DeepReadonly<TextRef>, content?: ContentBundle): string {
  if (ref.prose !== undefined && ref.prose.trim() !== "") return ref.prose;
  const template = TEMPLATES[ref.key];
  return template === undefined ? humanize(ref.key) : template(ref.params, content);
}

/** A full card for a decision from its template keys (the null path's `card`). */
export function templateCard(
  decision: DeepReadonly<Decision>,
  content?: ContentBundle,
): DecisionCardText {
  return {
    decisionId: decision.id,
    title: TITLES[decision.prompt.key] ?? "The captain's call",
    situation: renderTextRef(decision.prompt, content),
    leftLabel: renderTextRef(decision.left.label, content),
    rightLabel: renderTextRef(decision.right.label, content),
  };
}
