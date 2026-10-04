import type {
  AgentViewSnapshot,
  DeepReadonly,
  HelmRole,
  RosterEntry,
  SelfView,
  Thought,
  ThoughtDef,
  ThoughtKey,
  Tick,
  WatchView,
} from "@crew/sim";

/**
 * Plain words for who an actor is, for the inspector. Passengers (passengers-and-galaxy §3.2)
 * carry no role tags, so without this they would read as "crew".
 */
export function actorSubtitle(
  self: Pick<SelfView, "roleTags" | "passenger" | "disembarking">,
): string {
  if (self.passenger === true) {
    return self.disembarking === true ? "passenger, going ashore" : "passenger";
  }
  return self.roleTags.join(", ") || "crew";
}

/** The roster line's role words: "passenger" for a passenger, else the role tags or "crew". */
export function rosterRole(entry: Pick<RosterEntry, "roleTags" | "passenger">): string {
  if (entry.passenger === true) return "passenger";
  return entry.roleTags.join(", ") || "crew";
}

// ---------------------------------------------------------------------------------------------
// The watch, mood and thoughts (D77, D79)
// ---------------------------------------------------------------------------------------------

/** "red" → "Red". */
function capitalise(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** "Red section, on watch"; a dayworker (no section) "Dayworker, off duty". */
export function watchLine(self: Pick<SelfView, "watch" | "onDuty">): string {
  const { watch } = self;
  if (watch.section !== undefined) {
    return `${capitalise(watch.section)} section, ${watch.onWatch ? "on watch" : "off watch"}`;
  }
  return `Dayworker, ${self.onDuty ? "on duty" : "off duty"}`;
}

const HELM_ROLE_WORDS: Readonly<Record<HelmRole, string | undefined>> = {
  stander: "stands this watch's helm",
  oncoming: "has the helm next watch",
  relief: "can relieve the helm",
  none: undefined,
};

/** What the sim has them doing about the helm and the watch; `undefined` when nothing. */
export function helmLine(
  watch: Pick<WatchView, "helmRole" | "officerOfTheWatch">,
): string | undefined {
  const helm = HELM_ROLE_WORDS[watch.helmRole];
  if (!watch.officerOfTheWatch) return helm;
  return helm === undefined ? "officer of the watch" : `officer of the watch; ${helm}`;
}

/** `config.mood`'s bands, which also set work speed. */
export interface MoodBands {
  readonly lowBelow: number;
  readonly highAbove: number;
}

export type MoodWord = "low" | "steady" | "high";

/** Mood as a word: "low" below `lowBelow`, "high" above `highAbove`, "steady" between. */
export function moodWord(mood: number, bands: MoodBands): MoodWord {
  if (mood < bands.lowBelow) return "low";
  if (mood > bands.highAbove) return "high";
  return "steady";
}

/** One thing on someone's mind, for the inspector: the def's label and what it does to mood. */
export interface ThoughtLine {
  readonly key: ThoughtKey;
  readonly label: string;
  /** Summed over the live thoughts of this key (a stacking thought counts each time). */
  readonly value: number;
  readonly count: number;
}

/**
 * The thoughts weighing most on mood at `tick`, strongest first (by size, either sign), at most
 * `limit`. Expired thoughts (`expiresAtTick <= tick`) are left out; thoughts of one key are one
 * line with a count.
 */
export function topThoughts(
  thoughts: readonly DeepReadonly<Thought>[],
  tick: Tick,
  defs: Readonly<Record<ThoughtKey, ThoughtDef>>,
  limit = 3,
): ThoughtLine[] {
  const byKey = new Map<ThoughtKey, { value: number; count: number }>();
  for (const thought of thoughts) {
    if (thought.expiresAtTick <= tick) continue;
    const sum = byKey.get(thought.key) ?? { value: 0, count: 0 };
    byKey.set(thought.key, { value: sum.value + thought.value, count: sum.count + 1 });
  }
  return [...byKey]
    .map(([key, { value, count }]) => ({ key, label: defs[key].label, value, count }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value) || a.label.localeCompare(b.label))
    .slice(0, limit);
}

/** "stood a long watch", "brought the ship through clean ×2". */
export function thoughtText(line: ThoughtLine): string {
  return line.count > 1 ? `${line.label} ×${line.count}` : line.label;
}

/** Everything the inspector says about a crew member's watch and frame of mind. */
export interface PersonWords {
  readonly watch: string;
  readonly helm?: string;
  readonly mood: MoodWord;
  readonly thoughts: readonly ThoughtLine[];
}

export function personWords(
  view: Pick<AgentViewSnapshot, "self" | "tick">,
  defs: Readonly<Record<ThoughtKey, ThoughtDef>>,
  bands: MoodBands,
): PersonWords {
  const { self } = view;
  const helm = helmLine(self.watch);
  return {
    watch: watchLine(self),
    ...(helm === undefined ? {} : { helm }),
    mood: moodWord(self.mood, bands),
    thoughts: topThoughts(self.thoughts, view.tick, defs),
  };
}
