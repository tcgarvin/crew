/**
 * The narrator's running notes (`games.narrative_notes`, jsonb). Rewritten in full by every call;
 * the digest feeds them back so the next call keeps continuity (GDD §18, §21). §past-arcs: each
 * thread carries its arc notes, and a thread that ends becomes a past arc, summarized by the model
 * and kept by the server for the rest of the game.
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
  /** §issuers-and-pitches: the port where the captain can find them; null when they have none. */
  readonly portId: string | null;
  /**
   * §issuers-and-pitches: hook tick of the call that last put them in front of the captain; -1 if
   * unknown.
   */
  readonly lastSeenTick: number;
}

/** Someone who made the captain an offer this call (from the translated `offerJob` commands). */
export interface MetIssuer {
  readonly name: string;
  readonly note: string;
  /** Where to find them; null for a passenger, who is aboard (passengers-and-galaxy §4.1). */
  readonly portId: string | null;
}

/**
 * §threads-and-scales: how long a thread runs. An episode is one complete story, usually about a
 * job's length; it need not involve a job.
 */
export const THREAD_SCALES = ["beat", "episode", "season", "series"] as const;
export type ThreadScale = (typeof THREAD_SCALES)[number];

/** §threads-and-scales: a story thread the narrator keeps alive, TV-writers'-room style. */
export interface Thread {
  readonly title: string;
  readonly scale: ThreadScale;
  /** Who is involved: crew names or cast names. */
  readonly people: readonly string[];
  /**
   * §past-arcs: the arc so far, rewritten each call: what has happened in it (beats, complications,
   * the captain's choices) and where it stands now. Replaces the old one-sentence `stage`.
   */
  readonly arcNotes: string;
  /** One sentence: what must be true before it returns, and roughly what happens then. */
  readonly nextBeat: string;
  /** §past-arcs: server-kept, the hook tick of the call that first wrote this thread. */
  readonly openedTick: number;
  /** Hook tick of the last call that put a card or an offer from this thread in front of the captain. */
  readonly lastBeatTick: number | null;
  /**
   * §beat-cards: server-kept like `lastBeatTick`. True once a beat (foreshadowing) card has been
   * attributed to this thread; the model cannot clear it, and it stays true until the thread is
   * retired. One beat card per thread before its payoff.
   */
  readonly beatCardShown: boolean;
}

/**
 * §card-history: a card the captain has actually seen, kept by the server (never written by the
 * model), so the narrator knows what the captain knows and which way they went.
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
  /**
   * §closing-cards: the title of the thread this card closed (server-kept); null for any other
   * card.
   */
  readonly closedThread: string | null;
}

/** §past-arcs: how a thread ended: on its closing card, or named in `retired` without one. */
export const ARC_ENDINGS = ["closingCard", "retired"] as const;
export type ArcEnding = (typeof ARC_ENDINGS)[number];

/**
 * §past-arcs: a thread that has ended, kept for the rest of the game so the narrator can see the
 * shape of every story it has told. The model writes `shape` and `summary` in the notes turn of the
 * call that ended it; the rest is the server's.
 */
export interface PastArc {
  readonly title: string;
  readonly scale: ThreadScale;
  readonly people: readonly string[];
  readonly openedTick: number;
  readonly closedTick: number;
  readonly ending: ArcEnding;
  /** A few words on what kind of story it was ("cargo run, no trouble", "passenger with a past"). */
  readonly shape: string;
  /** What happened, what went wrong or changed, what the captain chose, how it came out. */
  readonly summary: string;
}

export interface NarratorNotes {
  /** The story so far, a few sentences. */
  readonly summary: string;
  /** §threads-and-scales: structured open threads (was `openThreads: string[]`). */
  readonly threads: readonly Thread[];
  /** §card-history: the most recent cards shown, oldest first; server-maintained. */
  readonly cardsShown: readonly CardShown[];
  /**
   * §past-arcs: every thread that has ended this game, oldest first, up to `NOTES_LIMITS.pastArcs`.
   */
  readonly pastArcs: readonly PastArc[];
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
  arcNotesChars: 600,
  pastArcs: 40,
  arcShapeChars: 60,
  arcSummaryChars: 500,
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
  pastArcs: [],
  cast: [],
  lastUpdatedTick: -1,
  lastRejections: [],
};

const storedThreadSchema = z.object({
  title: z.string(),
  scale: z.enum(THREAD_SCALES),
  people: z.array(z.string()),
  /** Notes stored before arc notes (§past-arcs) have `stage` instead. */
  arcNotes: z.string().optional(),
  stage: z.string().optional(),
  nextBeat: z.string(),
  /** Notes stored before opening ticks (§past-arcs) have none. */
  openedTick: z.number().int().optional(),
  lastBeatTick: z.number().int().nullable(),
  /** Notes stored before beat cards (§beat-cards) have no beat-card flag. */
  beatCardShown: z.boolean().optional(),
});

const storedPastArcSchema = z.object({
  title: z.string(),
  scale: z.enum(THREAD_SCALES),
  people: z.array(z.string()),
  openedTick: z.number().int(),
  closedTick: z.number().int(),
  ending: z.enum(ARC_ENDINGS),
  shape: z.string(),
  summary: z.string(),
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
  /** Cards stored before closing cards (§closing-cards) closed nothing. */
  closedThread: z.string().nullable().optional(),
});

const storedNotesSchema = z.object({
  summary: z.string(),
  /** Notes stored before structured threads (§threads-and-scales). */
  openThreads: z.array(z.string()).optional(),
  threads: z.array(storedThreadSchema).optional(),
  cardsShown: z.array(storedCardSchema).optional(),
  /** Notes stored before past arcs (§past-arcs) have none. */
  pastArcs: z.array(storedPastArcSchema).optional(),
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

/**
 * §threads-and-scales: an `openThreads` string from before structured threads becomes an episode
 * thread.
 */
export function threadFromLegacy(text: string, tick: number): Thread {
  return {
    title: text,
    scale: "episode",
    people: [],
    arcNotes: text,
    nextBeat: "",
    openedTick: tick,
    lastBeatTick: null,
    beatCardShown: false,
  };
}

function boundThread(thread: Thread): Thread {
  return {
    title: clip(thread.title, 80),
    scale: thread.scale,
    people: thread.people.slice(0, NOTES_LIMITS.threadPeople).map((p) => clip(p, 60)),
    arcNotes: clip(thread.arcNotes, NOTES_LIMITS.arcNotesChars),
    nextBeat: clip(thread.nextBeat, NOTES_LIMITS.threadChars),
    openedTick: thread.openedTick,
    lastBeatTick: thread.lastBeatTick,
    beatCardShown: thread.beatCardShown,
  };
}

function boundPastArc(arc: PastArc): PastArc {
  return {
    title: clip(arc.title, 80),
    scale: arc.scale,
    people: arc.people.slice(0, NOTES_LIMITS.threadPeople).map((p) => clip(p, 60)),
    openedTick: arc.openedTick,
    closedTick: arc.closedTick,
    ending: arc.ending,
    shape: clip(arc.shape, NOTES_LIMITS.arcShapeChars),
    summary: clip(arc.summary, NOTES_LIMITS.arcSummaryChars),
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
    closedThread: card.closedThread === null ? null : clip(card.closedThread, 80),
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
 * The cast after a call (§issuers-and-pitches): the model's rewritten list, with `lastSeenTick`
 * carried over from the previous notes by name, and everyone who made an offer this call added or
 * refreshed at the hook tick, so the people the captain meets can recur even if the model forgot to
 * list them.
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
    pastArcs: notes.pastArcs.slice(-NOTES_LIMITS.pastArcs).map(boundPastArc),
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
  const { openThreads, threads, cardsShown, pastArcs, ...rest } = parsed.data;
  const lastTick = parsed.data.lastUpdatedTick;
  return boundNotes({
    ...rest,
    // Notes stored before structured threads (§threads-and-scales) have free-text threads; before
    // card history (§card-history) none; before past arcs (§past-arcs) a thread's `stage` stood for
    // its arc notes, and nothing says when it opened.
    threads:
      threads?.map(({ stage, arcNotes, openedTick, ...t }) => ({
        ...t,
        arcNotes: arcNotes ?? stage ?? "",
        openedTick: openedTick ?? t.lastBeatTick ?? lastTick,
        beatCardShown: t.beatCardShown ?? false,
      })) ?? (openThreads ?? []).map((text) => threadFromLegacy(text, lastTick)),
    cardsShown: (cardsShown ?? []).map((c) => ({ ...c, closedThread: c.closedThread ?? null })),
    pastArcs: pastArcs ?? [],
    // Notes stored before cast ports (§issuers-and-pitches) have no port or sighting for their
    // cast.
    cast: parsed.data.cast.map((c) => ({
      name: c.name,
      note: c.note,
      portId: c.portId ?? null,
      lastSeenTick: c.lastSeenTick ?? -1,
    })),
    lastRejections: parsed.data.lastRejections ?? [],
  });
}

/** What the model writes for a thread: everything the server does not keep for it. */
export type WrittenThread = Omit<Thread, "openedTick" | "lastBeatTick" | "beatCardShown">;

/**
 * §threads-and-scales: the threads after a call. The model rewrites them in full; the server
 * carries `lastBeatTick` by title: it becomes the hook tick when this call put one of the thread's
 * people in front of the captain (as a card's speaker, named on a card, or as a job's issuer), else
 * the previous value, or null for a thread the model just started and did not use.
 *
 * §beat-cards: `beatCardShown` is carried by title too, and set when this call's beat card named
 * the thread (`beatCardThread`, the title as the translator matched it). A beat card is a card, so
 * it also stamps `lastBeatTick`.
 *
 * §closing-cards: a closed thread is retired by the server, whatever the model wrote: the one this
 * call's closing card ended, and any whose closing card is still in the card history (so a model
 * that keeps writing a finished thread cannot reopen it and close it again).
 *
 * §thread-keeping-and-retirement: a thread the captain has seen a beat of (`lastBeatTick` set)
 * never vanishes before its closing card. One the model left out is kept as it was and reported in
 * `kept`, unless the model named it in `retired` (reported in `retiredWithoutCard`). An omitted
 * thread the captain never saw is dropped silently. Over the thread limit, threads that are new
 * this call and unseen go first (`droppedForRoom`), so the limit never cuts a seen thread.
 *
 * §past-arcs: `openedTick` is carried by title, the hook tick for a new thread. A previous thread
 * that ends this call, by a closing card or named in `retired`, is returned in `ended` to become a
 * past arc.
 */
export interface MergedThreads {
  readonly threads: Thread[];
  /** Titles of seen threads the model omitted and the server kept. */
  readonly kept: string[];
  /** Titles of seen threads the model retired without a closing card. */
  readonly retiredWithoutCard: string[];
  /** Titles of new, unseen threads dropped to make room for seen ones. */
  readonly droppedForRoom: string[];
  /** §past-arcs: previous threads that ended this call, and how. */
  readonly ended: { readonly thread: Thread; readonly ending: ArcEnding }[];
}

export function mergeThreads(
  written: readonly WrittenThread[],
  previous: readonly Thread[],
  tick: number,
  /** Player-facing texts from this call: card titles, speakers, situations, issuer names. */
  textsThisCall: readonly string[],
  /** Title of the thread this call's beat card was attributed to, if any. */
  beatCardThread: string | undefined = undefined,
  /** Titles of threads closed by a card: this call's and those in the card history. */
  closedThreads: readonly string[] = [],
  /** §thread-keeping-and-retirement: titles the model ends without a closing card. */
  retired: readonly string[] = [],
): MergedThreads {
  const key = (s: string) => s.trim().toLowerCase();
  const before = new Map(previous.map((t) => [key(t.title), t]));
  const lowered = textsThisCall.map(key);
  const named = (person: string) => {
    const k = key(person);
    return k !== "" && lowered.some((text) => text.includes(k));
  };
  const beatKey = beatCardThread === undefined ? undefined : key(beatCardThread);
  const closed = new Set(closedThreads.map(key));
  const retiredKeys = new Set(retired.map(key));
  const threads: Thread[] = written
    .filter((t) => !closed.has(key(t.title)))
    .map((t) => {
      const earlier = before.get(key(t.title));
      const foreshadowedNow = beatKey !== undefined && key(t.title) === beatKey;
      return {
        ...t,
        openedTick: earlier?.openedTick ?? tick,
        lastBeatTick:
          t.people.some(named) || foreshadowedNow ? tick : (earlier?.lastBeatTick ?? null),
        beatCardShown: foreshadowedNow || (earlier?.beatCardShown ?? false),
      };
    });
  const writtenKeys = new Set(written.map((t) => key(t.title)));
  const kept: string[] = [];
  const retiredWithoutCard: string[] = [];
  const ended: MergedThreads["ended"] = [];
  for (const old of previous) {
    const k = key(old.title);
    if (closed.has(k)) {
      ended.push({ thread: old, ending: "closingCard" });
      continue;
    }
    if (writtenKeys.has(k) || old.lastBeatTick === null) continue;
    if (retiredKeys.has(k)) {
      retiredWithoutCard.push(old.title);
      ended.push({ thread: old, ending: "retired" });
    } else {
      threads.push(old);
      kept.push(old.title);
    }
  }
  const droppedForRoom: string[] = [];
  for (let i = threads.length - 1; i >= 0 && threads.length > NOTES_LIMITS.threads; i--) {
    const t = threads[i];
    if (t === undefined) continue;
    const k = key(t.title);
    if (before.has(k) || t.lastBeatTick !== null || k === beatKey) continue;
    threads.splice(i, 1);
    droppedForRoom.push(t.title);
  }
  return { threads, kept, retiredWithoutCard, droppedForRoom, ended };
}

/** §past-arcs: what the model writes for a thread that ended this call. */
export interface WrittenArcSummary {
  readonly title: string;
  readonly shape: string;
  readonly summary: string;
}

/**
 * §past-arcs: the past arcs after a call: the previous ones, then each thread that ended this call
 * with the summary the model wrote for it (matched by title). A thread the model wrote no summary
 * for keeps its arc notes as the summary, and `missing` names it so the next call is told.
 */
export function appendPastArcs(
  previous: readonly PastArc[],
  ended: MergedThreads["ended"],
  written: readonly WrittenArcSummary[],
  tick: number,
): { readonly pastArcs: PastArc[]; readonly missing: string[] } {
  const key = (s: string) => s.trim().toLowerCase();
  const byTitle = new Map(written.map((w) => [key(w.title), w]));
  const missing: string[] = [];
  const added = ended.map(({ thread, ending }): PastArc => {
    const summary = byTitle.get(key(thread.title));
    if (summary === undefined) missing.push(thread.title);
    return {
      title: thread.title,
      scale: thread.scale,
      people: thread.people,
      openedTick: thread.openedTick,
      closedTick: tick,
      ending,
      shape: summary?.shape ?? "",
      summary: summary?.summary ?? thread.arcNotes,
    };
  });
  return { pastArcs: [...previous, ...added], missing };
}
