import type {
  ActorId,
  AgentViewSnapshot,
  DeepReadonly,
  EntityId,
  HelmRole,
  InterestTag,
  Interests,
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
  mealToCook: "a meal to cook",
  mealToCarry: "a plate to take to the helm",
  compartmentDirty: "a room to mop",
  machineDamaged: "impact damage to repair",
  hullScar: "a hull scar to patch",
  hullDamaged: "hull plating to buy",
  compartmentToCheck: "a room to check for damage",
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
// The watch, mood and thoughts (§sections-and-dayworkers, §mood-and-work-speed)
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
  /** The def's label, `{ref}` filled with the name of the person it is about (slice 4). */
  readonly label: string;
  /** Summed over the live thoughts of this key (a stacking thought counts each time). */
  readonly value: number;
  readonly count: number;
}

/**
 * Slice 4: a thought label's `{ref}` placeholder ("{ref} keeps beating me") filled with the name
 * of the person the thought is about. The sim gives a `refId` to every thought whose label has
 * the placeholder (the validator holds it to that), but the person may since have walked off and
 * left the roster; the line then says "someone" rather than an id or a bare placeholder.
 */
export function fillRef(label: string, refName: string | undefined): string {
  return label.replaceAll("{ref}", refName ?? "someone");
}

/** A thought's grouping key: thoughts of one key about different people are separate lines. */
function thoughtGroup(key: ThoughtKey, refId: EntityId | undefined): string {
  return refId === undefined ? key : `${key}|${refId}`;
}

/**
 * The thoughts weighing most on mood at `tick`, strongest first (by size, either sign), at most
 * `limit`. Expired thoughts (`expiresAtTick <= tick`) are left out; thoughts of one key (and, for
 * one about someone, one person) are one line with a count. `names` fills `{ref}` (slice 4).
 */
export function topThoughts(
  thoughts: readonly DeepReadonly<Thought>[],
  tick: Tick,
  defs: Readonly<Record<ThoughtKey, ThoughtDef>>,
  limit = 3,
  names: ReadonlyMap<string, string> = new Map(),
): ThoughtLine[] {
  const byGroup = new Map<
    string,
    { key: ThoughtKey; refId: EntityId | undefined; value: number; count: number }
  >();
  for (const thought of thoughts) {
    if (thought.expiresAtTick <= tick) continue;
    const group = thoughtGroup(thought.key, thought.refId);
    const sum = byGroup.get(group) ?? {
      key: thought.key,
      refId: thought.refId,
      value: 0,
      count: 0,
    };
    byGroup.set(group, { ...sum, value: sum.value + thought.value, count: sum.count + 1 });
  }
  return [...byGroup.values()]
    .map(({ key, refId, value, count }) => ({
      key,
      label: fillRef(defs[key].label, refId === undefined ? undefined : names.get(refId)),
      value,
      count,
    }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value) || a.label.localeCompare(b.label))
    .slice(0, limit);
}

/** "stood a long watch", "brought the ship through clean ×2", "Jax Okonkwo keeps beating me". */
export function thoughtText(line: ThoughtLine): string {
  return line.count > 1 ? `${line.label} ×${line.count}` : line.label;
}

// ---------------------------------------------------------------------------------------------
// Interests and relationships (slice 4)
// ---------------------------------------------------------------------------------------------

/** Interest tags as the inspector says them. */
const INTEREST_WORDS: Readonly<Record<InterestTag, string>> = {
  cards: "cards",
  boardgames: "board games",
  vids: "vids",
  debate: "debate",
  music: "music",
  exercise: "exercise",
  sparring: "sparring",
  reading: "reading",
  tinkering: "tinkering",
  cooking: "cooking",
  stargazing: "stargazing",
  gossip: "gossip",
};

/**
 * What someone likes doing off watch: "likes cards (keen), vids; dislikes reading". The strong
 * like leads and is marked keen; "nothing in particular" for someone with no likes or dislikes.
 */
export function interestsLine(interests: DeepReadonly<Interests>): string {
  const { strong } = interests;
  const likes = [
    ...(strong === undefined ? [] : [`${INTEREST_WORDS[strong]} (keen)`]),
    ...interests.likes.filter((tag) => tag !== strong).map((tag) => INTEREST_WORDS[tag]),
  ];
  const parts = [
    ...(likes.length === 0 ? [] : [`likes ${likes.join(", ")}`]),
    ...(interests.dislikes.length === 0
      ? []
      : [`dislikes ${interests.dislikes.map((tag) => INTEREST_WORDS[tag]).join(", ")}`]),
  ];
  return parts.length === 0 ? "nothing in particular" : parts.join("; ");
}

/**
 * Affinity at which someone counts as close, and its negative as at odds: the digest's bands
 * (slice 4 call 24), so the inspector and the narrator name the same people. Compatibility alone
 * reaches ±2 (§affinity), so naming someone takes something remembered about them as well.
 */
export const CLOSE_AFFINITY = 3;

/** "+4", "−3" (a true minus sign: the inspector's numbers are read, not parsed). */
function signed(value: number): string {
  return value > 0 ? `+${value}` : `−${Math.abs(value)}`;
}

/**
 * Who someone feels close to and at odds with, from their own side of it (`self.affinity`):
 * "close to Jax Okonkwo (+4)", then "at odds with Priya Kessler (−3)", the strongest two each
 * way. Only people on the roster are named: `pruneSocial` drops anyone who left, and an id the
 * view has no name for is not a line to show the player.
 */
export function relationshipsLines(
  affinity: Readonly<Record<ActorId, number>>,
  roster: readonly Pick<RosterEntry, "actorId" | "name">[],
): string[] {
  const named = roster.flatMap((entry) => {
    const value = affinity[entry.actorId];
    return value === undefined ? [] : [{ name: entry.name, value }];
  });
  const close = named
    .filter((r) => r.value >= CLOSE_AFFINITY)
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
    .slice(0, 2)
    .map((r) => `close to ${r.name} (${signed(r.value)})`);
  const odds = named
    .filter((r) => r.value <= -CLOSE_AFFINITY)
    .sort((a, b) => a.value - b.value || a.name.localeCompare(b.name))
    .slice(0, 2)
    .map((r) => `at odds with ${r.name} (${signed(r.value)})`);
  return [...close, ...odds];
}

/** Everything the inspector says about a crew member's watch and frame of mind. */
export interface PersonWords {
  readonly watch: string;
  readonly helm?: string;
  readonly mood: MoodWord;
  readonly thoughts: readonly ThoughtLine[];
  /** Slice 4: `interestsLine`. */
  readonly interests: string;
  /** Slice 4: `relationshipsLines`; empty when nobody stands out. */
  readonly relationships: readonly string[];
}

export function personWords(
  view: Pick<AgentViewSnapshot, "self" | "tick" | "roster">,
  defs: Readonly<Record<ThoughtKey, ThoughtDef>>,
  bands: MoodBands,
): PersonWords {
  const { self } = view;
  const helm = helmLine(self.watch);
  const names = new Map<string, string>(view.roster.map((r) => [r.actorId, r.name]));
  return {
    watch: watchLine(self),
    ...(helm === undefined ? {} : { helm }),
    mood: moodWord(self.mood, bands),
    thoughts: topThoughts(self.thoughts, view.tick, defs, 3, names),
    interests: interestsLine(self.interests),
    relationships: relationshipsLines(self.affinity, view.roster),
  };
}
