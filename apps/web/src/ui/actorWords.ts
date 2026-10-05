import type {
  AgentViewSnapshot,
  DeepReadonly,
  HelmRole,
  ProblemKind,
  ProblemView,
  RoleTag,
  RosterEntry,
  SelfView,
  Thought,
  ThoughtDef,
  ThoughtKey,
  Tick,
  WatchView,
} from "@crew/sim";

/** Role tags as the inspector says them ("firstOfficer" reads "first officer"). */
const ROLE_WORDS: Readonly<Record<RoleTag, string>> = {
  captain: "captain",
  firstOfficer: "first officer",
  engineer: "engineer",
  pilot: "pilot",
  deckhand: "deckhand",
  cook: "cook",
  medic: "medic",
};

/** "engineer, deckhand"; "crew" with no role tags. */
export function roleWords(tags: readonly RoleTag[]): string {
  return tags.map((tag) => ROLE_WORDS[tag]).join(", ") || "crew";
}

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
  return roleWords(self.roleTags);
}

/** The roster line's role words: "passenger" for a passenger, else the role tags or "crew". */
export function rosterRole(entry: Pick<RosterEntry, "roleTags" | "passenger">): string {
  if (entry.passenger === true) return "passenger";
  return roleWords(entry.roleTags);
}

/** A known problem's kind in words, for the inspector's "Known problems" list. */
const PROBLEM_WORDS: Readonly<Record<ProblemKind, string>> = {
  machineSymptom: "something wrong with a machine",
  machineFault: "a fault to repair",
  maintenanceDue: "maintenance due",
  cargoToLoad: "cargo to load",
  cargoToUnload: "cargo to unload",
  stationToStaff: "the helm to stand",
  courseToPlot: "a course to plot",
  partsNeeded: "parts to buy for a repair",
  reserveLow: "stores to restock",
};

/** One line of the known-problems list: a kind in words and how many of it are known. */
export interface ProblemLine {
  readonly kind: ProblemKind;
  readonly text: string;
}

/**
 * Known problems as words, one line per kind in first-seen order, with a count when there are
 * several ("cargo to load ×6"), rather than the raw kind once per problem.
 */
export function problemLines(problems: readonly Pick<ProblemView, "kind">[]): ProblemLine[] {
  const counts = new Map<ProblemKind, number>();
  for (const problem of problems) counts.set(problem.kind, (counts.get(problem.kind) ?? 0) + 1);
  return [...counts].map(([kind, count]) => ({
    kind,
    text: count > 1 ? `${PROBLEM_WORDS[kind]} ×${count}` : PROBLEM_WORDS[kind],
  }));
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
