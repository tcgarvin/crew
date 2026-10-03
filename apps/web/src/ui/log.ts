/**
 * The ship's log (D55): one feed of what happened, in playback order. Event lines and the cards
 * the captain was shown (with the answer) live here, each stamped with the sim tick it belongs to. The
 * worker runs ahead of the viewer (D14), so an entry is only shown once playback reaches its tick:
 * the log never tells the viewer about something the deck has not shown yet.
 *
 * Pure data and functions, no React; `Log.tsx` renders it.
 */
import type { Decision, DeepReadonly, Significance, Tick, TickerEntry } from "@crew/sim";

/** Entries kept; the oldest go first. Plenty for a session, small enough to filter every frame. */
export const LOG_LIMIT = 200;

interface EntryBase {
  /** Unique within the log; also the React key. */
  readonly key: string;
  readonly tick: Tick;
}

export interface EventEntry extends EntryBase {
  readonly kind: "event";
  readonly text: string;
  readonly significance: Significance;
}

/** A decision card, logged when it is raised and updated with the captain's answer. */
export interface CardEntry extends EntryBase {
  readonly kind: "card";
  readonly decision: DeepReadonly<Decision>;
  /** Absent while the card waits for the captain. */
  readonly answer?: { readonly side: "left" | "right"; readonly caption: string };
}

export type LogEntry = EventEntry | CardEntry;

let entryCounter = 0;
function nextKey(prefix: string): string {
  entryCounter += 1;
  return `${prefix}:${entryCounter}`;
}

/** Keep the log in tick order (stable for equal ticks) and within `LOG_LIMIT`. */
function insert(log: readonly LogEntry[], entries: readonly LogEntry[]): LogEntry[] {
  if (entries.length === 0) return log as LogEntry[];
  const merged = [...log];
  for (const entry of entries) {
    let index = merged.length;
    while (index > 0 && (merged[index - 1]?.tick ?? 0) > entry.tick) index -= 1;
    merged.splice(index, 0, entry);
  }
  return merged.length > LOG_LIMIT ? merged.slice(merged.length - LOG_LIMIT) : merged;
}

/** A frame's ticker entries, as event lines. */
export function appendTicker(log: readonly LogEntry[], ticker: readonly TickerEntry[]): LogEntry[] {
  return insert(
    log,
    ticker.map((entry) => ({
      kind: "event",
      key: nextKey("event"),
      tick: entry.tick,
      text: entry.text,
      significance: entry.significance,
    })),
  );
}

/** A card raised by the sim, at the tick it was raised. A decision already logged is kept. */
export function appendDecision(
  log: readonly LogEntry[],
  decision: DeepReadonly<Decision>,
): LogEntry[] {
  if (log.some((e) => e.kind === "card" && e.decision.id === decision.id)) return log as LogEntry[];
  return insert(log, [
    { kind: "card", key: `card:${decision.id}`, tick: decision.createdTick, decision },
  ]);
}

/** The captain answered a logged card. */
export function answerDecision(
  log: readonly LogEntry[],
  decisionId: string,
  answer: NonNullable<CardEntry["answer"]>,
): LogEntry[] {
  return log.map((entry) =>
    entry.kind === "card" && entry.decision.id === decisionId ? { ...entry, answer } : entry,
  );
}

/** What playback has reached, newest first. */
export function visibleLog(log: readonly LogEntry[], viewTick: Tick): LogEntry[] {
  const shown: LogEntry[] = [];
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const entry = log[i];
    if (entry !== undefined && entry.tick <= viewTick) shown.push(entry);
  }
  return shown;
}
