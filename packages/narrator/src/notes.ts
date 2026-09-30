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
  cast: 8,
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
  cast: z.array(z.object({ name: z.string(), note: z.string() })),
  lastUpdatedTick: z.number().int(),
  lastRejections: z.array(z.string()).optional(),
});

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Enforce the size limits so notes cannot grow without bound across calls. */
export function boundNotes(notes: NarratorNotes): NarratorNotes {
  return {
    summary: clip(notes.summary, NOTES_LIMITS.summaryChars),
    openThreads: notes.openThreads
      .slice(0, NOTES_LIMITS.threads)
      .map((t) => clip(t, NOTES_LIMITS.threadChars)),
    cast: notes.cast
      .slice(0, NOTES_LIMITS.cast)
      .map((c) => ({ name: clip(c.name, 60), note: clip(c.note, NOTES_LIMITS.castNoteChars) })),
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
  return boundNotes({ ...parsed.data, lastRejections: parsed.data.lastRejections ?? [] });
}
