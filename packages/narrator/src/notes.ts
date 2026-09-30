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

export interface NarratorNotes {
  /** The story so far, a few sentences. */
  readonly summary: string;
  /** Hooks set up and not yet paid off. */
  readonly openThreads: readonly string[];
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
  cast: 12,
  castNoteChars: 160,
  rejections: 6,
} as const;

export const EMPTY_NOTES: NarratorNotes = {
  summary: "",
  openThreads: [],
  cast: [],
  lastUpdatedTick: -1,
  lastRejections: [],
};

const storedNotesSchema = z.object({
  summary: z.string(),
  openThreads: z.array(z.string()),
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
    openThreads: notes.openThreads
      .slice(0, NOTES_LIMITS.threads)
      .map((t) => clip(t, NOTES_LIMITS.threadChars)),
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
  return boundNotes({
    ...parsed.data,
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
