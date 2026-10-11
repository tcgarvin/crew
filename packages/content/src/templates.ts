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
 * §aftermath-caption (additive, 2026-09-30): `leftAftermath`/`rightAftermath` are the one-line
 * captions shown for a moment after that side is chosen, before the card closes. Absent when the
 * decision's option carries none.
 */
export interface DecisionCardText {
  readonly decisionId: string;
  readonly title: string;
  readonly situation: string;
  readonly leftLabel: string;
  readonly rightLabel: string;
  readonly leftAftermath?: string;
  readonly rightAftermath?: string;
  /**
   * §spoken-cards (additive, 2026-10-01): who is speaking on the card, full name as the digest
   * lists them; absent for an observed scene.
   */
  readonly speaker?: string;
  /**
   * §closing-cards (additive, 2026-10-03): present on a narrator card that closes a story thread;
   * the thread's title, or empty when the title is not fit to show the captain.
   */
  readonly closesThread?: string;
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
/** Expeditions A2: what an errand's issuer says when the draft carried no pitch. */
const ERRAND_PITCH_KEY = "job.pitch.errand";

/** GDD §22 card budget, as in `@crew/narrator`'s `CARD_SITUATION_MAX_WORDS` (§spoken-cards: 70). */
const SITUATION_MAX_WORDS = 70;

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
 * Offer card (§issuers-and-pitches): the issuer's pitch in quotes, then one line of context (cargo
 * kind, route, urgency). Decisions from before schema 2 carry only `issuer`/`from`/`to` and get the
 * old line. §cards-never-mention-pay: never prints pay.
 */
function offerSituation(p: Params, c: ContentBundle | undefined): string {
  if (p.name === undefined) {
    return `${p.issuer ?? "A dockside broker"} has freight bound from ${portLabel(p.from, c)} to ${portLabel(p.to, c)} and wants us to carry it.`;
  }
  const pitchKey = String(p.pitchKey ?? DEFAULT_PITCH_KEY);
  // The kernel's default pitch is a freight broker's; an errand's issuer says something else.
  const key = isErrand(p) && pitchKey === DEFAULT_PITCH_KEY ? ERRAND_PITCH_KEY : pitchKey;
  const pitch = p.pitch !== undefined ? String(p.pitch) : renderTextRef({ key, params: p }, c);
  const urgency = URGENCY_WORDS[String(p.urgency)] ?? "no rush";
  const context = isErrand(p)
    ? errandContext(p, c, urgency)
    : isPassage(p)
      ? `${p.name} wants passage to ${portLabel(p.to, c)}${p.roundTrip === "true" ? " and back" : ""}, ${p.cargo === undefined ? "travelling light" : `with luggage (${cargoWords(p.cargo, c)})`}, ${urgency}.`
      : `${capitalise(cargoWords(p.cargo, c))}, ${portLabel(p.from, c)} to ${portLabel(p.to, c)}, ${urgency}.`;
  return clipWords(`“${pitch}” ${context}`, SITUATION_MAX_WORDS);
}

/** "The Boathouse" → "the Boathouse": a place's name as it reads mid-sentence. */
function placeLabel(value: string | number | undefined, content: ContentBundle | undefined) {
  return value === undefined ? "the site" : portLabel(value, content).replace(/^The /, "the ");
}

/** Expeditions A2 (§6): how an errand's `wants` reads on its offer card. */
const WANTS_WORDS: Readonly<Record<string, string>> = {
  alive: "alive",
  either: "alive or dead",
  dead: "dead",
};

/**
 * Expeditions A2 (§6): an errand's context line, "Bring back Corran Vale from the Boathouse, alive,
 * no rush." or "Fetch the strongbox papers from the Boathouse, no rush.". The sim marks an errand
 * offer with `errand` (its kind), `target`, `site` and `wants` in the prompt params
 * (`offerPromptParams` in `systems/commerce`).
 */
function errandContext(p: Params, c: ContentBundle | undefined, urgency: string): string {
  const target = p.target === undefined ? "what they're after" : String(p.target);
  const site = placeLabel(p.site, c);
  if (p.errand === "fetchItem") return `Fetch ${target} from ${site}, ${urgency}.`;
  const wants = WANTS_WORDS[String(p.wants)] ?? WANTS_WORDS.alive;
  return `Bring back ${target} from ${site}, ${wants}, ${urgency}.`;
}

/** Expeditions A2: the sim marks an errand offer with its kind in `errand`. */
function isErrand(p: Params): boolean {
  return p.errand !== undefined;
}

/**
 * Passengers §6: the sim marks a passage offer with `passenger: "true"` (and `roundTrip`) in the
 * prompt params (`offerPromptParams` in `systems/commerce`); the side labels keep the freight
 * keys with no params, so the card branches on the prompt's params for its sides too.
 */
function isPassage(p: Params): boolean {
  return p.passenger === "true";
}

/** The offer card's sides and aftermaths when the job is a person, not freight. */
const PASSAGE_SIDE_TEXT: Readonly<Record<string, string>> = {
  "job.offer.accept": "Welcome aboard.",
  "job.offer.decline": "Not this trip.",
  "job.accept.aftermath":
    "They come up the ramp with what they carry. We leave once they're settled.",
  "job.decline.aftermath": "You pass. They go looking for another ship.",
};

/** Expeditions A2: the offer card's aftermaths when the job is an errand to a site. */
const ERRAND_SIDE_TEXT: Readonly<Record<string, string>> = {
  "job.accept.aftermath": "Taken. We set a course for the site and see what's waiting there.",
  "job.decline.aftermath": "You pass. They'll find someone else to send.",
};

/** Expeditions A2 call 4: the arrival card's key (`systems/expedition/cards.ts`). */
const ARRIVAL_KEY = "expedition.arrival";
/** Expeditions A2 call 15: the turn card's key (`systems/expedition/cards.ts`). */
const TURN_KEY = "expedition.turn";

/** "Hold the ramp from cover" → "hold the ramp from cover", for the middle of a question. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * The arrival card: "Sunniva Brandt at the ramp head: Corran Vale is at the Boathouse, and not
 * alone. Hold the ramp from cover, or go in and take them?" Params: `speaker`, `target`, `site`,
 * and the two plans' `leftLabel` and `rightLabel`. No numbers.
 */
function arrivalSituation(p: Params, c: ContentBundle | undefined): string {
  const speaker = p.speaker === undefined ? "" : `${p.speaker} at the ramp head: `;
  const target = p.target === undefined ? "Whoever we came for" : String(p.target);
  const question =
    p.leftLabel !== undefined && p.rightLabel !== undefined
      ? `${p.leftLabel}, or ${lowerFirst(String(p.rightLabel))}?`
      : "Hold the ramp, or go in?";
  return `${speaker}${target} is at ${placeLabel(p.site, c)}, and not alone. ${question}`;
}

/** How the turn card says what happened to `name` (`params.how`; anything else is "breaking"). */
const TURN_HOW = new Set(["breaking", "down", "dead"]);

/**
 * The turn card: "Sunniva Brandt: Hesk Marrow is breaking. Press on, or pull back?" Params:
 * `speaker`, `name` (who broke or went down) and `how` (`breaking`, `down` or `dead`).
 */
function turnSituation(p: Params): string {
  const speaker = p.speaker === undefined ? "" : `${p.speaker}: `;
  const name = p.name === undefined ? "One of them" : String(p.name);
  const how = TURN_HOW.has(String(p.how)) ? String(p.how) : "breaking";
  return `${speaker}${name} is ${how}. Press on, or pull back?`;
}

/**
 * §departure-gate: the gate card's reason, in plain words (no numbers, §cards-never-mention-pay).
 * Keyed by `ImpairmentReason`.
 */
const GATE_REASONS: Readonly<Record<string, string>> = {
  blocked: "won't run at all until it's repaired",
  faultDerated: "is running below full power with an unrepaired fault",
  fault: "is running with an unrepaired fault",
  lowOutput: "is putting out well below full power",
};

/** §departure-gate: "The main engine is running below full power with an unrepaired fault. ..." */
function departureGateSituation(p: Params): string {
  const machine =
    p.machine === undefined ? "A machine we need" : `The ${String(p.machine).toLowerCase()}`;
  const reason = GATE_REASONS[String(p.reason)] ?? "isn't right";
  return `${machine} ${reason}. We can sit here while it's fixed, or go as we are.`;
}

const DEPARTURE_GATE_KEY = "travel.departureGate";

/** Passengers §3.3: the overdue card's key (`systems/commerce` `PASSENGER_OVERDUE_PROMPT_KEY`). */
const PASSENGER_OVERDUE_KEY = "commerce.passengerOverdue";

/**
 * Passengers §3.3: "Halla Thorne went ashore at Ossory Station and hasn't come back. ..." The
 * name table has no pronouns, so the card says "them". No numbers (§cards-never-mention-pay).
 */
function passengerOverdueSituation(p: Params, c: ContentBundle | undefined): string {
  const name = p.name === undefined ? "Our passenger" : String(p.name);
  return `${name} went ashore at ${portLabel(p.port, c)} and hasn't come back when they said they would. We can hold the ship for them, or go without them.`;
}

const TEMPLATES: Readonly<Record<string, (p: Params, c: ContentBundle | undefined) => string>> = {
  "job.offer": offerSituation,
  // Departure gate (§departure-gate).
  [DEPARTURE_GATE_KEY]: departureGateSituation,
  "travel.departureGate.hold": () => "Hold for repairs",
  "travel.departureGate.leave": () => "Leave anyway",
  "travel.departureGate.hold.aftermath": () =>
    "We stay put. The crew get to work on it, and we leave the moment it's fixed.",
  "travel.departureGate.leave.aftermath": () =>
    "We go as we are. Whatever's wrong with it comes with us.",
  // Passengers §3.3 overdue card.
  [PASSENGER_OVERDUE_KEY]: passengerOverdueSituation,
  [`${PASSENGER_OVERDUE_KEY}.wait`]: () => "Wait for them",
  [`${PASSENGER_OVERDUE_KEY}.leave`]: () => "Leave without them",
  [`${PASSENGER_OVERDUE_KEY}.wait.aftermath`]: () =>
    "We hold the ship. The ramp stays down until they come up it.",
  [`${PASSENGER_OVERDUE_KEY}.leave.aftermath`]: () =>
    "We close up and go. Whatever kept them, it's their problem now, and there's no fare.",
  // Expeditions A2: the arrival card; each side is a plan, its label and its why in the side's
  // own params (`leftLabel`/`leftWhy`, `rightLabel`/`rightWhy`).
  [ARRIVAL_KEY]: arrivalSituation,
  [`${ARRIVAL_KEY}.left`]: (p) => (p.leftLabel === undefined ? "Hold back" : String(p.leftLabel)),
  [`${ARRIVAL_KEY}.right`]: (p) => (p.rightLabel === undefined ? "Go in" : String(p.rightLabel)),
  [`${ARRIVAL_KEY}.left.aftermath`]: (p) =>
    p.leftWhy === undefined ? "We do it that way." : String(p.leftWhy),
  [`${ARRIVAL_KEY}.right.aftermath`]: (p) =>
    p.rightWhy === undefined ? "We do it that way." : String(p.rightWhy),
  // Expeditions A2: the turn card.
  [TURN_KEY]: turnSituation,
  [`${TURN_KEY}.press`]: () => "Press on",
  [`${TURN_KEY}.withdraw`]: () => "Pull back to the ship",
  [`${TURN_KEY}.press.aftermath`]: () => "They keep going. It's in their hands now.",
  [`${TURN_KEY}.withdraw.aftermath`]: () =>
    "The word goes out. They fall back to the ramp and bring the hurt with them.",
  "job.offer.accept": () => "Take the job",
  "job.offer.decline": () => "Pass on it",
  // Aftermaths for the offer card (§aftermath-caption).
  "job.accept.aftermath": () => "Taken. The crew start loading — we leave once the hold is full.",
  "job.decline.aftermath": () =>
    "You pass. Word gets around the board; another offer usually turns up.",
  // §issuers-and-pitches: a pitch without prose (old saves, drafts that carried none).
  [DEFAULT_PITCH_KEY]: () => "Got freight that needs moving, if you've got the room.",
  "job.pitch": () => "Got freight that needs moving, if you've got the room.",
  [ERRAND_PITCH_KEY]: (p) =>
    p.errand === "fetchItem"
      ? "Something of mine needs bringing back, and I'd rather not ask the usual people."
      : "Someone needs bringing back, and I'd rather not ask the usual people.",
  "job.template": () => "A routine freight contract.",
  "decision.accept": () => "Accept",
  "decision.decline": () => "Decline",
  [NARRATOR_TEXT_KEYS.situation]: () => "Something needs the captain's call.",
  [NARRATOR_TEXT_KEYS.side]: () => "Decide",
  [NARRATOR_TEXT_KEYS.aftermath]: () => "The crew get on with it.",
};

/** Title per prompt key; anything else gets a generic heading. */
const TITLES: Readonly<
  Record<string, (p: Params, c: ContentBundle | undefined) => string | undefined>
> = {
  // §issuers-and-pitches: the offer card is titled with the person, "Ysolde Maren, Meridian Growers
  // Collective".
  // Expeditions A2: an errand is titled with who (or what) it is after, "A job: Corran Vale".
  "job.offer": (p) =>
    isErrand(p) && p.target !== undefined
      ? `A job: ${p.target}`
      : p.name !== undefined
        ? `${p.name}, ${p.org ?? p.role ?? "shipper"}`
        : p.issuer === undefined
          ? "A job offer"
          : String(p.issuer),
  // Narrator cards carry their heading in the prompt params (`translate.ts`).
  [NARRATOR_TEXT_KEYS.situation]: (p) => (p.title === undefined ? undefined : String(p.title)),
  // §departure-gate: "Before we leave: Main Engine".
  [DEPARTURE_GATE_KEY]: (p) =>
    p.machine === undefined ? "Before we leave" : `Before we leave: ${String(p.machine)}`,
  // Passengers §3.3: "Overdue: Halla Thorne".
  [PASSENGER_OVERDUE_KEY]: (p) => (p.name === undefined ? "Overdue" : `Overdue: ${String(p.name)}`),
  // Expeditions A2: "At the Boathouse"; the turn card's heading is the moment itself.
  [ARRIVAL_KEY]: (p, c) => capitalise(`at ${placeLabel(p.site, c)}`),
  [TURN_KEY]: () => "The fight turns",
};

const speakerParam = (p: Params) => (p.speaker === undefined ? undefined : String(p.speaker));

/**
 * §spoken-cards: who is speaking, per prompt key; the offer card's issuer, or the narrator's param.
 */
const SPEAKERS: Readonly<Record<string, (p: Params) => string | undefined>> = {
  "job.offer": (p) => (p.name === undefined ? undefined : String(p.name)),
  [NARRATOR_TEXT_KEYS.situation]: speakerParam,
  // §departure-gate: the engineer brings the gate card (§spoken-cards), when the ship has one.
  [DEPARTURE_GATE_KEY]: speakerParam,
  // Passengers §3.3: the first officer brings the overdue card (§spoken-cards).
  [PASSENGER_OVERDUE_KEY]: speakerParam,
  // Expeditions A2: the first officer (or whoever leads) brings the expedition's cards.
  [ARRIVAL_KEY]: speakerParam,
  [TURN_KEY]: speakerParam,
};

const GENERIC_TITLE = "The captain's call";

function humanize(key: string): string {
  const last = key.split(".").pop() ?? key;
  return capitalise(
    last
      .replace(/([A-Z])/g, " $1")
      .replace(/_/g, " ")
      .trim()
      .toLowerCase(),
  );
}

function hasProse(ref: DeepReadonly<TextRef>): ref is DeepReadonly<TextRef> & { prose: string } {
  return ref.prose !== undefined && ref.prose.trim() !== "";
}

/** Prose if present, else the template, else a humanized key. Never throws. */
export function renderTextRef(ref: DeepReadonly<TextRef>, content?: ContentBundle): string {
  if (hasProse(ref)) return ref.prose;
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
  const speaker = SPEAKERS[decision.prompt.key]?.(decision.prompt.params);
  const offer = decision.prompt.key === "job.offer";
  const sideText = !offer
    ? undefined
    : isErrand(decision.prompt.params)
      ? ERRAND_SIDE_TEXT
      : isPassage(decision.prompt.params)
        ? PASSAGE_SIDE_TEXT
        : undefined;
  const closes =
    decision.prompt.key === NARRATOR_TEXT_KEYS.situation
      ? decision.prompt.params.closesThread
      : undefined;
  const side = (ref: DeepReadonly<TextRef>): string => {
    const text = sideText?.[ref.key];
    return text === undefined || hasProse(ref) ? renderTextRef(ref, content) : text;
  };
  return {
    decisionId: decision.id,
    title: TITLES[decision.prompt.key]?.(decision.prompt.params, content) ?? GENERIC_TITLE,
    ...(speaker === undefined || speaker.trim() === "" ? {} : { speaker }),
    ...(closes === undefined ? {} : { closesThread: String(closes) }),
    situation: renderTextRef(decision.prompt, content),
    leftLabel: side(decision.left.label),
    rightLabel: side(decision.right.label),
    ...(leftAftermath === undefined ? {} : { leftAftermath: side(leftAftermath) }),
    ...(rightAftermath === undefined ? {} : { rightAftermath: side(rightAftermath) }),
  };
}
