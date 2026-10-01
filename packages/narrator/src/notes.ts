/**
 * The narrator's running notes (`games.narrative_notes`, jsonb). Rewritten in full by every call;
 * the digest feeds them back so the next call keeps continuity (GDD §18, §21).
 *
 * W9 decision: a small JSON object rather than free text, so the server can store it as jsonb and
 * the digest can bound each part separately. Dropped intents from the previous call are carried
 * in `lastRejections` so the model learns why its commands did not happen.
 */
import { z } from "zod";

export interface NarratorCastEntry {
  readonly name: string;
  /** Who they are and what they want, one line. */
  readonly note: string;
  /** D25 (2026-09-30): the port where the captain can find them; null when they have none. */
  readonly portId: string | null;
  /** D25: hook tick of the call that last put them in front of the captain; -1 if unknown. */
  readonly lastSeenTick: number;
}

/** Someone who made the captain an offer this call (from the translated `offerJob` commands). */
export interface MetIssuer {
  readonly name: string;
  readonly note: string;
  readonly portId: string;
}

/** D32: how long a thread runs. An episode is one complete story, usually about a job's length; it need not involve a job. */
export const THREAD_SCALES = ["beat", "episode", "season", "series"] as const;
export type ThreadScale = (typeof THREAD_SCALES)[number];

/** D32: a story thread the narrator keeps alive, TV-writers'-room style. */
export interface Thread {
  readonly title: string;
  readonly scale: ThreadScale;
  /** Who is involved: crew names or cast names. */
  readonly people: readonly string[];
  /** One sentence: where the thread is now. */
  readonly stage: string;
  /** One sentence: what must be true before it returns, and roughly what happens then. */
  readonly nextBeat: string;
  /** Hook tick of the last call that put a card or an offer from this thread in front of the captain. */
  readonly lastBeatTick: number | null;
}

/**
 * D31: a card the captain has actually seen, kept by the server (never written by the model), so
 * the narrator knows what the captain knows and which way they went.
 */
export interface CardShown {
  readonly tick: number;
  /** Minted by the kernel on apply, so a surfaced card has none until its decision shows up. */
  readonly decisionId: string | null;
  readonly title: string;
  readonly speaker: string | null;
  /** The situation clipped to `NOTES_LIMITS.gistWords` words. */
  readonly gist: string;
  readonly leftLabel: string;
  readonly rightLabel: string;
  readonly chosen: "left" | "right" | null;
}

export interface NarratorNotes {
  /** The story so far, a few sentences. */
  readonly summary: string;
  /** D32: structured open threads (was `openThreads: string[]`). */
  readonly threads: readonly Thread[];
  /** D31: the most recent cards shown, oldest first; server-maintained. */
  readonly cardsShown: readonly CardShown[];
  /** Supporting characters the narrator has introduced (not the crew). */
  readonly cast: readonly NarratorCastEntry[];
  /** Tick of the hook that produced these notes; -1 before the first call. */
  readonly lastUpdatedTick: number;
  /** Why intents from the previous call were dropped, so the model can adjust. */
  readonly lastRejections: readonly string[];
}

export const NOTES_LIMITS = {
  summaryChars: 1200,
  threads: 6,
  threadChars: 200,
  threadPeople: 6,
  cardsShown: 12,
  gistWords: 25,
  cast: 12,
  castNoteChars: 160,
  rejections: 6,
} as const;

export const EMPTY_NOTES: NarratorNotes = {
  summary: "",
  threads: [],
  cardsShown: [],
  cast: [],
  lastUpdatedTick: -1,
  lastRejections: [],
};

const storedThreadSchema = z.object({
  title: z.string(),
  scale: z.enum(THREAD_SCALES),
  people: z.array(z.string()),
  stage: z.string(),
  nextBeat: z.string(),
  lastBeatTick: z.number().int().nullable(),
});

const storedCardSchema = z.object({
  tick: z.number().int(),
  decisionId: z.string().nullable(),
  title: z.string(),
  speaker: z.string().nullable(),
  gist: z.string(),
  leftLabel: z.string(),
  rightLabel: z.string(),
  chosen: z.enum(["left", "right"]).nullable(),
});

const storedNotesSchema = z.object({
  summary: z.string(),
  /** Notes stored before D32. */
  openThreads: z.array(z.string()).optional(),
  threads: z.array(storedThreadSchema).optional(),
  cardsShown: z.array(storedCardSchema).optional(),
  cast: z.array(
    z.object({
      name: z.string(),
      note: z.string(),
      portId: z.string().nullable().optional(),
      lastSeenTick: z.number().int().optional(),
    }),
  ),
  lastUpdatedTick: z.number().int(),
  lastRejections: z.array(z.string()).optional(),
});

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The first `max` words of a text, collapsed onto one line. */
export function clipWords(text: string, max: number): string {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "");
  return words.length <= max ? words.join(" ") : `${words.slice(0, max).join(" ")}…`;
}

/** D32: an `openThreads` string from before structured threads becomes an episode thread. */
export function threadFromLegacy(text: string): Thread {
  return {
    title: text,
    scale: "episode",
    people: [],
    stage: text,
    nextBeat: "",
    lastBeatTick: null,
  };
}

function boundThread(thread: Thread): Thread {
  return {
    title: clip(thread.title, 80),
    scale: thread.scale,
    people: thread.people.slice(0, NOTES_LIMITS.threadPeople).map((p) => clip(p, 60)),
    stage: clip(thread.stage, NOTES_LIMITS.threadChars),
    nextBeat: clip(thread.nextBeat, NOTES_LIMITS.threadChars),
    lastBeatTick: thread.lastBeatTick,
  };
}

function boundCard(card: CardShown): CardShown {
  return {
    tick: card.tick,
    decisionId: card.decisionId,
    title: clip(card.title, 60),
    speaker: card.speaker === null ? null : clip(card.speaker, 80),
    gist: clipWords(card.gist, NOTES_LIMITS.gistWords),
    leftLabel: clip(card.leftLabel, 48),
    rightLabel: clip(card.rightLabel, 48),
    chosen: card.chosen,
  };
}

/** Over the cast limit, the people seen longest ago go first; order is otherwise kept. */
function keepRecentCast(cast: readonly NarratorCastEntry[]): readonly NarratorCastEntry[] {
  if (cast.length <= NOTES_LIMITS.cast) return cast;
  const keep = new Set(
    cast
      .map((c, i) => ({ c, i }))
      .sort((a, b) => b.c.lastSeenTick - a.c.lastSeenTick || a.i - b.i)
      .slice(0, NOTES_LIMITS.cast)
      .map(({ i }) => i),
  );
  return cast.filter((_, i) => keep.has(i));
}

/**
 * The cast after a call (D25): the model's rewritten list, with `lastSeenTick` carried over from
 * the previous notes by name, and everyone who made an offer this call added or refreshed at the
 * hook tick, so the people the captain meets can recur even if the model forgot to list them.
 */
export function mergeCast(
  written: readonly {
    readonly name: string;
    readonly note: string;
    readonly portId: string | null;
  }[],
  previous: readonly NarratorCastEntry[],
  met: readonly MetIssuer[],
  tick: number,
): NarratorCastEntry[] {
  const key = (name: string) => name.trim().toLowerCase();
  const seenBefore = new Map(previous.map((c) => [key(c.name), c.lastSeenTick]));
  const metByName = new Map(met.map((m) => [key(m.name), m]));
  const cast: NarratorCastEntry[] = written.map((c) => {
    const offered = metByName.get(key(c.name));
    return {
      name: c.name,
      note: c.note,
      portId: c.portId ?? offered?.portId ?? null,
      lastSeenTick: offered === undefined ? (seenBefore.get(key(c.name)) ?? tick) : tick,
    };
  });
  const listed = new Set(cast.map((c) => key(c.name)));
  for (const m of met) {
    if (listed.has(key(m.name))) continue;
    listed.add(key(m.name));
    cast.push({ name: m.name, note: m.note, portId: m.portId, lastSeenTick: tick });
  }
  return cast;
}

/** Enforce the size limits so notes cannot grow without bound across calls. */
export function boundNotes(notes: NarratorNotes): NarratorNotes {
  return {
    summary: clip(notes.summary, NOTES_LIMITS.summaryChars),
    threads: notes.threads.slice(0, NOTES_LIMITS.threads).map(boundThread),
    cardsShown: notes.cardsShown.slice(-NOTES_LIMITS.cardsShown).map(boundCard),
    cast: keepRecentCast(notes.cast).map((c) => ({
      name: clip(c.name, 60),
      note: clip(c.note, NOTES_LIMITS.castNoteChars),
      portId: c.portId,
      lastSeenTick: c.lastSeenTick,
    })),
    lastUpdatedTick: notes.lastUpdatedTick,
    lastRejections: notes.lastRejections.slice(0, NOTES_LIMITS.rejections).map((r) => clip(r, 200)),
  };
}

/**
 * Read whatever the server stored. The column defaults to `{}` and early builds stored a string,
 * so anything that is not a valid notes object becomes empty notes (a plain string is kept as the
 * summary). This is the one boundary where untrusted notes enter the narrator.
 */
export function parseNotes(raw: unknown): NarratorNotes {
  if (typeof raw === "string") {
    return raw.trim() === "" ? EMPTY_NOTES : boundNotes({ ...EMPTY_NOTES, summary: raw });
  }
  const parsed = storedNotesSchema.safeParse(raw);
  if (!parsed.success) return EMPTY_NOTES;
  const { openThreads, threads, cardsShown, ...rest } = parsed.data;
  return boundNotes({
    ...rest,
    // Notes stored before D32 have free-text threads; before D31 no card history.
    threads: threads ?? (openThreads ?? []).map(threadFromLegacy),
    cardsShown: cardsShown ?? [],
    // Notes stored before D25 have no port or sighting for their cast.
    cast: parsed.data.cast.map((c) => ({
      name: c.name,
      note: c.note,
      portId: c.portId ?? null,
      lastSeenTick: c.lastSeenTick ?? -1,
    })),
    lastRejections: parsed.data.lastRejections ?? [],
  });
}

/**
 * D32: the threads after a call. The model rewrites them in full; the server carries
 * `lastBeatTick` by title: it becomes the hook tick when this call put one of the thread's people
 * in front of the captain (as a card's speaker, named on a card, or as a job's issuer), else the
 * previous value, or null for a thread the model just started and did not use.
 */
export function mergeThreads(
  written: readonly Omit<Thread, "lastBeatTick">[],
  previous: readonly Thread[],
  tick: number,
  /** Player-facing texts from this call: card titles, speakers, situations, issuer names. */
  textsThisCall: readonly string[],
): Thread[] {
  const key = (s: string) => s.trim().toLowerCase();
  const before = new Map(previous.map((t) => [key(t.title), t.lastBeatTick]));
  const lowered = textsThisCall.map(key);
  const named = (person: string) => {
    const k = key(person);
    return k !== "" && lowered.some((text) => text.includes(k));
  };
  return written.map((t) => ({
    ...t,
    lastBeatTick: t.people.some(named) ? tick : (before.get(key(t.title)) ?? null),
  }));
}
