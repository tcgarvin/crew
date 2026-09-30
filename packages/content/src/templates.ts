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
import type {
  ContentBundle,
  Decision,
  DeepReadonly,
  ItemDefId,
  PortDefId,
  TextRef,
} from "@crew/sim";

/**
 * The text of a decision card. Structurally identical to `@crew/narrator`'s `DecisionCardProse`
 * (the narrator's `card` response), so either can be shown by the same modal.
 *
 * D26 (additive, 2026-09-30): `leftAftermath`/`rightAftermath` are the one-line captions shown
 * for a moment after that side is chosen, before the card closes. Absent when the decision's
 * option carries none.
 */
export interface DecisionCardText {
  readonly decisionId: string;
  readonly title: string;
  readonly situation: string;
  readonly leftLabel: string;
  readonly rightLabel: string;
  readonly leftAftermath?: string;
  readonly rightAftermath?: string;
}

/** Template keys used by narrator-authored cards; prose is always present on these. */
export const NARRATOR_TEXT_KEYS = {
  title: "narrator.decision.title",
  situation: "narrator.decision",
  side: "narrator.decision.side",
  aftermath: "narrator.decision.aftermath",
  jobDescription: "narrator.job.description",
  jobPitch: "narrator.job.pitch",
} as const;

/** The pitch key the kernel gives a job whose draft carried no pitch (`systems/commerce`). */
const DEFAULT_PITCH_KEY = "job.pitch.default";

/** GDD §22 card budget, as in `@crew/narrator`'s `CARD_SITUATION_MAX_WORDS`. */
const SITUATION_MAX_WORDS = 60;

type Params = Readonly<Record<string, string | number>>;

function portLabel(value: string | number | undefined, content: ContentBundle | undefined) {
  if (value === undefined) return "another port";
  const id = String(value);
  return content?.ports[id as PortDefId]?.name ?? id;
}

/** How people say the cargo: the name table's word for its class, else the item's name. */
function cargoWords(value: string | number | undefined, content: ContentBundle | undefined) {
  if (value === undefined) return "freight";
  const item = content?.items[String(value) as ItemDefId];
  if (item === undefined) return "freight";
  const word =
    item.cargoClass === undefined ? undefined : content?.people?.cargoWords[item.cargoClass];
  return word ?? item.name.toLowerCase();
}

/** Presentation-only urgency (`Job.urgency`) as it reads at the end of the context line. */
const URGENCY_WORDS: Readonly<Record<string, string>> = {
  relaxed: "no rush",
  soon: "wanted soon",
  urgent: "needed urgently",
};

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function clipWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/);
  return words.length <= max ? words.join(" ") : `${words.slice(0, max).join(" ")}…`;
}

/**
 * D25 offer card: the issuer's pitch in quotes, then one line of context (cargo kind, route,
 * urgency). Decisions from before schema 2 carry only `issuer`/`from`/`to` and get the old line.
 * D24: never prints pay.
 */
function offerSituation(p: Params, c: ContentBundle | undefined): string {
  if (p.name === undefined) {
    return `${p.issuer ?? "A dockside broker"} has freight bound from ${portLabel(p.from, c)} to ${portLabel(p.to, c)} and wants us to carry it.`;
  }
  const pitch =
    p.pitch !== undefined
      ? String(p.pitch)
      : renderTextRef({ key: String(p.pitchKey ?? DEFAULT_PITCH_KEY), params: p }, c);
  const urgency = URGENCY_WORDS[String(p.urgency)] ?? URGENCY_WORDS.relaxed;
  const context = `${capitalise(cargoWords(p.cargo, c))}, ${portLabel(p.from, c)} to ${portLabel(p.to, c)}, ${urgency}.`;
  return clipWords(`“${pitch}” ${context}`, SITUATION_MAX_WORDS);
}

const TEMPLATES: Readonly<Record<string, (p: Params, c: ContentBundle | undefined) => string>> = {
  "job.offer": offerSituation,
  "job.offer.accept": () => "Take the job",
  "job.offer.decline": () => "Pass on it",
  // D26 aftermaths for the offer card.
  "job.accept.aftermath": () => "Taken. The crew start loading — we leave once the hold is full.",
  "job.decline.aftermath": () =>
    "You pass. Word gets around the board; another offer usually turns up.",
  // D25: a pitch without prose (old saves, drafts that carried none).
  [DEFAULT_PITCH_KEY]: () => "Got freight that needs moving, if you've got the room.",
  "job.pitch": () => "Got freight that needs moving, if you've got the room.",
  "job.template": () => "A routine freight contract.",
  "decision.accept": () => "Accept",
  "decision.decline": () => "Decline",
  [NARRATOR_TEXT_KEYS.situation]: () => "Something needs the captain's call.",
  [NARRATOR_TEXT_KEYS.side]: () => "Decide",
  [NARRATOR_TEXT_KEYS.aftermath]: () => "The crew get on with it.",
};

/** Title per prompt key; anything else gets a generic heading. */
const TITLES: Readonly<Record<string, (p: Params) => string | undefined>> = {
  // D25: the offer card is titled with the person, "Ysolde Maren, Meridian Growers Collective".
  "job.offer": (p) =>
    p.name !== undefined
      ? `${p.name}, ${p.org ?? p.role ?? "shipper"}`
      : p.issuer === undefined
        ? "A job offer"
        : String(p.issuer),
  // Narrator cards carry their heading in the prompt params (`translate.ts`).
  [NARRATOR_TEXT_KEYS.situation]: (p) => (p.title === undefined ? undefined : String(p.title)),
};

const GENERIC_TITLE = "The captain's call";

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
  const leftAftermath = decision.left.aftermath;
  const rightAftermath = decision.right.aftermath;
  return {
    decisionId: decision.id,
    title: TITLES[decision.prompt.key]?.(decision.prompt.params) ?? GENERIC_TITLE,
    situation: renderTextRef(decision.prompt, content),
    leftLabel: renderTextRef(decision.left.label, content),
    rightLabel: renderTextRef(decision.right.label, content),
    ...(leftAftermath === undefined
      ? {}
      : { leftAftermath: renderTextRef(leftAftermath, content) }),
    ...(rightAftermath === undefined
      ? {}
      : { rightAftermath: renderTextRef(rightAftermath, content) }),
  };
}
