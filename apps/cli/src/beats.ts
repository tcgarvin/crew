/**
 * `crew beats` (D76, ship-life §9 "Measure it"): the tuning instrument for the ship's day. Runs
 * the pacing voyage (`pacing.ts`'s `VoyageScript`, registry and content) round trip after round
 * trip until N ship's days have passed, with an instant narrator (every hook answered at once with
 * no commands) and every card answered by its left side, and reports:
 *
 * - beats per watch by kind (bells, handovers, meals served, servings eaten hot and as rations,
 *   meals missed, servings spoiled, rooms turned filthy and mopped clean, faults, hazards, cards,
 *   conversations): the total and the mean, least and most over the run's watches;
 * - rooms at `dirty` and at `filthy` at the end of each watch (D82);
 * - how full the mess gets: for each meal served, how many ate it hot within
 *   `MESS_WINDOW_DAYS` (D83's target: at least `MESS_FULL_EATERS`, three times a day);
 * - per person, the share of sim time in each activity class (read from the canvas label, which
 *   is what the player sees), cooking and mopping among them, and the longest idle stretch;
 * - the provisions aboard at the end, in crates and days of meals (D81);
 * - how long the helm stood empty while the ship was not docked;
 * - port calls by watch of the day: time docked, with cargo to move, with cargo to move and
 *   nobody hauling (a stall), and with someone on the gangway;
 * - each person's sleep starts, as seconds into each day (the rhythm's anchor, D77);
 * - off watch (D84-D87, slice 4 call 22): group sessions opened, started, collapsed and
 *   abandoned per watch and by activity, contests, arguments, spirited talks, performances and
 *   rivalry streaks, solo activities started (by kind), and the ticker's notable-or-better lines
 *   per watch, all and the off-watch family's; per person, the share of time recreating, the days they recreated and the
 *   longest stretch bored (recreation above `seekThreshold`, and above `RECREATION_HIGH`); at the
 *   end, the affinity extremes and every rivalry;
 * - machine wear (D90): each wearing machine's condition at the end of each ship's day, the
 *   lowest it fell to, and how often it was serviced;
 * - the asteroid fields (D95, `beats-field.ts`): the run schedules one a leg (`--fields`), and
 *   the report gives each field's rocks, hull lost, time stuck, first intercom report and ticker
 *   lines, the totals per severity, scars patched and plated, and whether the ship was lost.
 *   `--seeds` runs several seeds and says how many ships were lost over them.
 *
 * Unlike `crew pacing` there is no wall clock: the sim simply advances, so the numbers are sim
 * time and independent of playback speed. An event at tick T happened in the step ending at T,
 * so it is counted in the watch holding tick T − 1: the bell that ends a watch counts in it.
 */
import { rivalryPhrase } from "@crew/narrator";
import {
  type ActorId,
  type Command,
  type CommandId,
  type ContentBundle,
  type EventType,
  FIELD_EVENT_TYPES,
  type Kernel,
  type MachineId,
  type NarratorHook,
  OFF_WATCH_EVENT_TYPES,
  type SimEvent,
  type World,
  actionLabel,
  affinitiesFrom,
  createKernel,
  dayTicks,
  provisionsCratesAboard,
  provisionsDays,
  tickerLine,
  watchTicks,
} from "@crew/sim";
import {
  FIELD_PLANS,
  type FieldPlan,
  FieldScript,
  FieldTally,
  type FieldTallyResult,
  fieldSection,
} from "./beats-field";
import {
  type PacingScenario,
  VoyageScript,
  createPacingRegistry,
  loadPacingContent,
} from "./pacing";
import { type ChunkedRun, drain, drainAsync } from "./yielding";

// ---------------------------------------------------------------------------------------------
// What is counted
// ---------------------------------------------------------------------------------------------

/** An event as the tally reads it: its type, tick and payload (still discriminated by type). */
export type BeatEvent = SimEvent extends infer E
  ? E extends SimEvent
    ? Pick<E, "type" | "tick" | "payload">
    : never
  : never;

/**
 * The beats per watch: the event that marks each, and how much one event counts (1 unless
 * said). Eating splits on the `ateMeal` payload's `ration` (D81: a hot meal or a ration pack);
 * a spoiled sweep counts its servings.
 */
export const BEAT_EVENTS = {
  bells: { type: "bell" },
  handovers: { type: "helmRelieved" },
  mealsServed: { type: "mealServed" },
  eatenHot: { type: "ateMeal", ration: false },
  eatenRation: { type: "ateMeal", ration: true },
  mealsMissed: { type: "mealMissed" },
  servingsSpoiled: { type: "mealSpoiled" },
  roomsFilthy: { type: "roomFilthy" },
  roomsCleaned: { type: "roomCleaned" },
  faults: { type: "faultOccurred" },
  hazards: { type: "navHazard" },
  cards: { type: "decisionPending" },
  conversations: { type: "conversation" },
  // Slice 4 (call 22): off watch. `sessionEnded` splits on its outcome.
  sessionsOpened: { type: "sessionOpened" },
  sessionsStarted: { type: "sessionStarted" },
  sessionsCollapsed: { type: "sessionCollapsed" },
  sessionsAbandoned: { type: "sessionEnded", outcome: "abandoned" },
  contests: { type: "sessionEnded", outcome: "contest" },
  arguments: { type: "sessionEnded", outcome: "debate", argued: true },
  spiritedTalks: { type: "sessionEnded", outcome: "debate", argued: false },
  performances: { type: "sessionEnded", outcome: "perform" },
  rivalryStreaks: { type: "rivalryStreak" },
} as const satisfies Record<
  string,
  {
    readonly type: EventType;
    readonly ration?: boolean;
    readonly outcome?: string;
    readonly argued?: boolean;
  }
>;

/**
 * Beats counted from samples rather than events: a solo activity begun (no event marks one,
 * call 18), a notable-or-better line on the ticker (what the player reads), and such a line from
 * the off-watch family (`OFF_WATCH_EVENT_TYPES`: recreation, social, cabins), whose count per
 * watch is call 22's twelve (D84 tuning: the twelve was meant for the slice's own lines, not the
 * whole ticker's).
 */
export const SAMPLED_BEATS = ["soloActivities", "tickerLines", "offWatchLines"] as const;
export type BeatKind = keyof typeof BEAT_EVENTS | (typeof SAMPLED_BEATS)[number];
const BEAT_KINDS: readonly BeatKind[] = [
  ...(Object.keys(BEAT_EVENTS) as (keyof typeof BEAT_EVENTS)[]),
  ...SAMPLED_BEATS,
];

/** Event types whose beat depends on the payload (`beatsOf` splits them). */
const SPLIT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  "ateMeal",
  "mealSpoiled",
  "sessionEnded",
]);

/** The beats an event marks and how much each counts; empty for an event not counted. */
export function beatsOf(event: BeatEvent): readonly { kind: BeatKind; count: number }[] {
  switch (event.type) {
    case "ateMeal":
      return [{ kind: event.payload.ration ? "eatenRation" : "eatenHot", count: 1 }];
    case "mealSpoiled":
      return [{ kind: "servingsSpoiled", count: event.payload.count }];
    case "sessionEnded":
      return sessionEndedBeats(event.payload);
    default: {
      const kind = EVENT_TO_BEAT.get(event.type);
      return kind === undefined ? [] : [{ kind, count: 1 }];
    }
  }
}

/** A session's end: abandoned, a contest with a winner, an argument or a talk, a performance. */
function sessionEndedBeats(
  payload: Extract<BeatEvent, { type: "sessionEnded" }>["payload"],
): readonly { kind: BeatKind; count: number }[] {
  switch (payload.outcome) {
    case "abandoned":
      return [{ kind: "sessionsAbandoned", count: 1 }];
    case "contest":
      return payload.winnerId === undefined ? [] : [{ kind: "contests", count: 1 }];
    case "debate":
      return [{ kind: payload.argued === true ? "arguments" : "spiritedTalks", count: 1 }];
    case "perform":
      return [{ kind: "performances", count: 1 }];
    case "bond":
    case "none":
      return [];
  }
}

/** Rooms counted at the end of each watch, by tier (D82). */
export const ROOM_TIERS_COUNTED = ["dirty", "filthy"] as const;
export type CountedTier = (typeof ROOM_TIERS_COUNTED)[number];

/** D83: a meal "fills the mess" when this many eat it hot within `MESS_WINDOW_DAYS` of the serve. */
export const MESS_FULL_EATERS = 6;
export const MESS_WINDOW_DAYS = 0.05;

/** D84: recreation at or above this is "very bored" (call 22: nobody above it for a day). */
export const RECREATION_HIGH = 0.8;

export const ACTIVITY_CLASSES = [
  "recreating",
  "helm",
  "cooking",
  "mopping",
  "gangway",
  "rounds",
  "hauling",
  "repairing",
  "asleep",
  "eating",
  "resting or chatting",
  "idle",
  "walking",
  "ashore",
  "other",
] as const;
export type ActivityClass = (typeof ACTIVITY_CLASSES)[number];

/**
 * Canvas labels (`systems/work/labels.ts`, `core/render.ts` `actionLabel`) to classes, first
 * match wins. "helm" is the bridge: the helm and plotting a course. "ashore" is the captain's
 * business on the dock and in the port (D70) and buying at the market (D47). Anything unmatched
 * is "other", and the report lists those labels so a new one is noticed. "cooking" is the galley's
 * work (D81: fetching provisions, at the stove, serving, a plate to the helm); "mopping" is a
 * cleaning trip (D82: the mop fetched, the rooms mopped, the mop put away). The stander eating in
 * the seat ("at the helm, eating") is still at the helm. "recreating" (D84) is any label in
 * `recreationLabels` (the activities' own, from content), checked first, or fetching and
 * putting back a book.
 */
const LABEL_CLASSES: readonly (readonly [RegExp, ActivityClass])[] = [
  [/^(fetching provisions|cooking|serving dinner|taking a plate to the helm)/, "cooking"],
  [/^(fetching the mop|mopping|putting the mop away)/, "mopping"],
  [
    /^(at the helm|going to the helm|taking the helm|relieving .+ at the helm|plotting a course)/,
    "helm",
  ],
  [/^on the gangway/, "gangway"],
  [/^doing rounds/, "rounds"],
  [
    /^(hauling|stowing|picking up|putting down|loading|unloading|moving crates|fetching the hand truck|returning the hand truck|parking the hand truck)/,
    "hauling",
  ],
  [
    /^(inspecting|servicing|fixing|diagnosing|repairing|removing a part|installing a part|testing|operating|manning)/,
    "repairing",
  ],
  [/^(asleep|sleeping|lying down|waking up)/, "asleep"],
  [/^eating/, "eating"],
  [/^(resting|chatting)/, "resting or chatting"],
  [/^(idle|waiting)$/, "idle"],
  [
    /^(going ashore to look for work|looking for work|looking round|going to see|talking|ashore|buying)/,
    "ashore",
  ],
  [/^(walking|going ashore|coming aboard|leaving the helm)/, "walking"],
  [/^(fetching a book|putting the book back)/, "recreating"],
];

export function activityClass(label: string, recreationLabels: ReadonlySet<string>): ActivityClass {
  if (recreationLabels.has(label)) return "recreating";
  for (const [pattern, cls] of LABEL_CLASSES) if (pattern.test(label)) return cls;
  return "other";
}

/**
 * Every label a person recreating shows (`systems/work/labels.ts` `recreateLabel` and the fetch
 * of an owned instrument): each activity's label, waiting label and solo label, and "fetching
 * the harmonica" / "putting the harmonica away" for each `instrument` item.
 */
export function recreationLabels(content: ContentBundle): ReadonlySet<string> {
  const labels = new Set<string>();
  for (const def of Object.values(content.activities)) {
    labels.add(def.label);
    labels.add(def.waitingLabel);
    if (def.solo !== undefined) labels.add(def.solo.label);
  }
  for (const item of Object.values(content.items)) {
    if (!item.tags.includes("instrument")) continue;
    const name = item.name.toLowerCase();
    labels.add(`fetching the ${name}`);
    labels.add(`putting the ${name} away`);
  }
  return labels;
}

// ---------------------------------------------------------------------------------------------
// The tally (pure: fed events and samples, so it can be tested without a sim)
// ---------------------------------------------------------------------------------------------

export interface BeatStats {
  readonly total: number;
  readonly perWatchMean: number;
  readonly perWatchMin: number;
  readonly perWatchMax: number;
}

export interface PersonBeats {
  readonly name: string;
  /** Share of sampled sim time in each class, 0..1; the classes sum to 1. */
  readonly shares: Readonly<Record<ActivityClass, number>>;
  readonly longestIdleSeconds: number;
  /** When they fell asleep, in sim time: the day (from 1) and the second of that day. */
  readonly sleepStarts: readonly SleepStart[];
  /** D84: days (of the run's) with any time recreating. */
  readonly daysRecreated: number;
  /** D84: the longest stretch with recreation above `seekThreshold`. */
  readonly longestBoredSeconds: number;
  /** D84: the longest stretch with recreation at or above `RECREATION_HIGH`. */
  readonly longestVeryBoredSeconds: number;
}

/** D84: sessions by activity over the run. */
export interface ActivitySessions {
  readonly opened: number;
  readonly started: number;
  readonly collapsed: number;
  readonly abandoned: number;
  /** Solo stretches begun (a solo plan, or a game collapsed to its solo variant). */
  readonly solo: number;
}

export interface SleepStart {
  readonly day: number;
  readonly secondOfDay: number;
}

/** Port calls on one watch of the day, in sim seconds over the run. */
export interface PortWatchBeats {
  readonly dockedSeconds: number;
  /** Docked with cargo to load or unload. */
  readonly cargoOpenSeconds: number;
  /** Docked with cargo to move and nobody hauling. */
  readonly cargoStallSeconds: number;
  readonly longestCargoStallSeconds: number;
  /** Docked with no helm watch open (no course plotted): a gangway watch is wanted. */
  readonly gangwayWantedSeconds: number;
  /** Docked with someone on the gangway. */
  readonly gangwaySeconds: number;
}

/** How full the mess got at each meal served (D83). */
export interface MessFill {
  readonly serves: number;
  /** Hot servings eaten within `MESS_WINDOW_DAYS` of a serve, averaged over the serves. */
  readonly meanEaters: number;
  readonly fewestEaters: number;
  /** Serves eaten hot by at least `MESS_FULL_EATERS` within the window. */
  readonly fullServes: number;
}

/** The ship at the end of a sample. */
export interface ShipSample {
  readonly tick: number;
  readonly docked: boolean;
  /** Not docked and nobody at the helm. */
  readonly helmEmpty: boolean;
  /** The helm's `watch` post is open (a course plotted in port, or underway). */
  readonly helmWatchOpen: boolean;
  /** A `cargoToLoad` or `cargoToUnload` problem is open. */
  readonly cargoOpen: boolean;
  /** Rooms at each counted tier now (`state.dirt.tiers`). */
  readonly rooms: Readonly<Record<CountedTier, number>>;
}

export interface BeatsTallyResult {
  readonly watches: number;
  readonly beats: Readonly<Record<BeatKind, BeatStats>>;
  /** Rooms at each counted tier at the end of each watch (its last sample). */
  readonly roomsAtWatchEnd: Readonly<Record<CountedTier, BeatStats>>;
  readonly messFill: MessFill;
  readonly people: readonly PersonBeats[];
  readonly helmUnattendedSeconds: number;
  /** Port calls by watch of the day (index = watch of the day). */
  readonly port: readonly PortWatchBeats[];
  /** Labels that matched no class, with the sim-seconds spent in each. */
  readonly otherLabels: Readonly<Record<string, number>>;
  /** D84: sessions and solo stretches by activity id. */
  readonly byActivity: Readonly<Record<string, ActivitySessions>>;
}

/** D84: what the tally needs to know about recreation. */
export interface RecreationTallyConfig {
  /** `config.needs.seekThreshold`: above it someone is bored. */
  readonly seekThreshold: number;
  /** `recreationLabels(content)`. */
  readonly labels: ReadonlySet<string>;
}

/** One person's label at a sample. */
export interface PersonSample {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  /** `needs.recreation` now. */
  readonly recreation: number;
  /** The activity they are playing on their own now (a solo `recreate` step), or null. */
  readonly soloActivityId: string | null;
}

interface PersonTally {
  readonly name: string;
  readonly ticks: Record<ActivityClass, number>;
  idleRun: number;
  longestIdle: number;
  asleep: boolean;
  readonly sleepStartTicks: number[];
  readonly recreatedDays: Set<number>;
  boredRun: number;
  longestBored: number;
  veryBoredRun: number;
  longestVeryBored: number;
  soloActivityId: string | null;
}

interface ActivityTally {
  opened: number;
  started: number;
  collapsed: number;
  abandoned: number;
  solo: number;
}

interface PortWatchTally {
  docked: number;
  cargoOpen: number;
  cargoStall: number;
  stallRun: number;
  longestStall: number;
  gangwayWanted: number;
  gangway: number;
}

const EVENT_TO_BEAT: ReadonlyMap<string, BeatKind> = new Map(
  (Object.keys(BEAT_EVENTS) as (keyof typeof BEAT_EVENTS)[])
    .filter((kind) => !SPLIT_TYPES.has(BEAT_EVENTS[kind].type))
    .map((kind) => [BEAT_EVENTS[kind].type, kind] as const),
);

function statsOf(counts: readonly number[], watches: number): BeatStats {
  const total = counts.reduce((sum, n) => sum + n, 0);
  return {
    total,
    perWatchMean: total / watches,
    perWatchMin: Math.min(...counts),
    perWatchMax: Math.max(...counts),
  };
}

export class BeatsTally {
  private readonly perWatch: Record<BeatKind, number[]>;
  private readonly roomsAtEnd: Record<CountedTier, number[]>;
  private readonly serveTicks: number[] = [];
  private readonly hotEatTicks: number[] = [];
  private readonly people = new Map<string, PersonTally>();
  private readonly other = new Map<string, number>();
  private readonly port: PortWatchTally[];
  private readonly activities = new Map<string, ActivityTally>();
  private unattendedTicks = 0;

  /**
   * @param watches the run's watches; events in later watches (none, if the run stops at the
   *   end of its last watch) are an error.
   * @param ticksPerWatch from the config (`watchTicks`).
   * @param watchesPerDay from the config (`time.watchesPerDay`), for the port calls by watch.
   * @param messWindowTicks `MESS_WINDOW_DAYS` in ticks: how soon after a serve a hot meal
   *   eaten counts toward that serve's mess.
   * @param recreation the boredom threshold and the recreation labels (D84).
   */
  constructor(
    private readonly watches: number,
    private readonly ticksPerWatch: number,
    private readonly tickRate: number,
    private readonly watchesPerDay: number,
    private readonly messWindowTicks: number,
    private readonly recreation: RecreationTallyConfig,
  ) {
    if (!Number.isInteger(watches) || watches <= 0) {
      throw new RangeError(`BeatsTally: watches must be a positive integer, got ${watches}`);
    }
    if (!Number.isInteger(watchesPerDay) || watchesPerDay <= 0) {
      throw new RangeError(
        `BeatsTally: watchesPerDay must be a positive integer, got ${watchesPerDay}`,
      );
    }
    this.port = Array.from({ length: watchesPerDay }, () => ({
      docked: 0,
      cargoOpen: 0,
      cargoStall: 0,
      stallRun: 0,
      longestStall: 0,
      gangwayWanted: 0,
      gangway: 0,
    }));
    this.perWatch = Object.fromEntries(
      BEAT_KINDS.map((kind) => [kind, new Array<number>(watches).fill(0)]),
    ) as Record<BeatKind, number[]>;
    this.roomsAtEnd = Object.fromEntries(
      ROOM_TIERS_COUNTED.map((tier) => [tier, new Array<number>(watches).fill(0)]),
    ) as Record<CountedTier, number[]>;
  }

  /** The watch an event at `tick` is counted in (the step ending at `tick`). */
  watchOf(tick: number): number {
    return Math.floor(Math.max(0, tick - 1) / this.ticksPerWatch);
  }

  events(events: readonly BeatEvent[]): void {
    for (const event of events) {
      for (const beat of beatsOf(event)) {
        this.count(beat.kind, event.tick, beat.count, event.type);
        if (beat.kind === "mealsServed") this.serveTicks.push(event.tick);
        if (beat.kind === "eatenHot") this.hotEatTicks.push(event.tick);
      }
      this.activityEvent(event);
    }
  }

  /** Lines that reached the ticker, notable or better, and which were off watch's (D84, call 22). */
  tickerLines(lines: readonly TickerSample[]): void {
    for (const line of lines) {
      this.count("tickerLines", line.tick, 1, "ticker line");
      if (line.offWatch) this.count("offWatchLines", line.tick, 1, "off-watch ticker line");
    }
  }

  private count(kind: BeatKind, tick: number, n: number, what: string): void {
    const watch = this.watchOf(tick);
    if (watch >= this.watches) {
      throw new RangeError(`${what} at tick ${tick} is past the run's last watch`);
    }
    const counts = this.perWatch[kind];
    counts[watch] = (counts[watch] ?? 0) + n;
  }

  /** D84: sessions by activity. */
  private activityEvent(event: BeatEvent): void {
    switch (event.type) {
      case "sessionOpened":
        this.activityTally(event.payload.activityId).opened += 1;
        return;
      case "sessionStarted":
        this.activityTally(event.payload.activityId).started += 1;
        return;
      case "sessionCollapsed":
        this.activityTally(event.payload.activityId).collapsed += 1;
        return;
      case "sessionEnded":
        if (event.payload.outcome === "abandoned") {
          this.activityTally(event.payload.activityId).abandoned += 1;
        }
        return;
      default:
        return;
    }
  }

  private activityTally(activityId: string): ActivityTally {
    const known = this.activities.get(activityId);
    if (known !== undefined) return known;
    const fresh = { opened: 0, started: 0, collapsed: 0, abandoned: 0, solo: 0 };
    this.activities.set(activityId, fresh);
    return fresh;
  }

  /**
   * `ticks` of sim time ending at `ship.tick`, with each person's label at its end and the
   * ship's state then.
   */
  sample(ticks: number, people: readonly PersonSample[], ship: ShipSample): void {
    if (ship.helmEmpty) this.unattendedTicks += ticks;
    // The watch's last sample stands for its end: each sample overwrites the one before.
    const watch = this.watchOf(ship.tick);
    if (watch < this.watches) {
      for (const tier of ROOM_TIERS_COUNTED) this.roomsAtEnd[tier][watch] = ship.rooms[tier];
    }
    let hauling = false;
    let gangway = false;
    for (const person of people) {
      const tally = this.personTally(person);
      const cls = activityClass(person.label, this.recreation.labels);
      tally.ticks[cls] += ticks;
      this.sampleRecreation(tally, person, ticks, ship.tick, cls === "recreating");
      if (cls === "hauling") hauling = true;
      if (cls === "gangway") gangway = true;
      if (cls === "other")
        this.other.set(person.label, (this.other.get(person.label) ?? 0) + ticks);
      if (cls === "idle") {
        tally.idleRun += ticks;
        tally.longestIdle = Math.max(tally.longestIdle, tally.idleRun);
      } else {
        tally.idleRun = 0;
      }
      const asleep = cls === "asleep";
      if (asleep && !tally.asleep) tally.sleepStartTicks.push(ship.tick - ticks);
      tally.asleep = asleep;
    }
    const port = this.port[this.watchOf(ship.tick) % this.watchesPerDay];
    if (port === undefined) throw new RangeError(`no port tally for tick ${ship.tick}`);
    if (!ship.docked) {
      port.stallRun = 0;
      return;
    }
    port.docked += ticks;
    if (!ship.helmWatchOpen) port.gangwayWanted += ticks;
    if (gangway) port.gangway += ticks;
    if (ship.cargoOpen) port.cargoOpen += ticks;
    if (ship.cargoOpen && !hauling) {
      port.cargoStall += ticks;
      port.stallRun += ticks;
      port.longestStall = Math.max(port.longestStall, port.stallRun);
    } else {
      port.stallRun = 0;
    }
  }

  /** D84: days recreated, bored stretches, solo activities begun. */
  private sampleRecreation(
    tally: PersonTally,
    person: PersonSample,
    ticks: number,
    tick: number,
    recreating: boolean,
  ): void {
    const dayTicks = this.ticksPerWatch * this.watchesPerDay;
    if (recreating) tally.recreatedDays.add(Math.floor(Math.max(0, tick - 1) / dayTicks));
    tally.boredRun = person.recreation > this.recreation.seekThreshold ? tally.boredRun + ticks : 0;
    tally.longestBored = Math.max(tally.longestBored, tally.boredRun);
    tally.veryBoredRun = person.recreation >= RECREATION_HIGH ? tally.veryBoredRun + ticks : 0;
    tally.longestVeryBored = Math.max(tally.longestVeryBored, tally.veryBoredRun);
    const solo = person.soloActivityId;
    if (solo !== null && solo !== tally.soloActivityId) {
      this.count("soloActivities", tick, 1, "solo activity");
      this.activityTally(solo).solo += 1;
    }
    tally.soloActivityId = solo;
  }

  private personTally(person: PersonSample): PersonTally {
    const known = this.people.get(person.id);
    if (known !== undefined) return known;
    const fresh: PersonTally = {
      name: person.name,
      ticks: Object.fromEntries(ACTIVITY_CLASSES.map((c) => [c, 0])) as Record<
        ActivityClass,
        number
      >,
      idleRun: 0,
      longestIdle: 0,
      asleep: false,
      sleepStartTicks: [],
      recreatedDays: new Set(),
      boredRun: 0,
      longestBored: 0,
      veryBoredRun: 0,
      longestVeryBored: 0,
      soloActivityId: null,
    };
    this.people.set(person.id, fresh);
    return fresh;
  }

  /** For each serve, the hot meals eaten in `[serve, serve + messWindowTicks)`. */
  private messFill(): MessFill {
    const eaters = this.serveTicks.map(
      (serve) =>
        this.hotEatTicks.filter((tick) => tick >= serve && tick < serve + this.messWindowTicks)
          .length,
    );
    const serves = eaters.length;
    return {
      serves,
      meanEaters: serves === 0 ? 0 : eaters.reduce((sum, n) => sum + n, 0) / serves,
      fewestEaters: serves === 0 ? 0 : Math.min(...eaters),
      fullServes: eaters.filter((n) => n >= MESS_FULL_EATERS).length,
    };
  }

  result(): BeatsTallyResult {
    const beats = Object.fromEntries(
      BEAT_KINDS.map((kind) => [kind, statsOf(this.perWatch[kind], this.watches)]),
    ) as Record<BeatKind, BeatStats>;
    const roomsAtWatchEnd = Object.fromEntries(
      ROOM_TIERS_COUNTED.map((tier) => [tier, statsOf(this.roomsAtEnd[tier], this.watches)]),
    ) as Record<CountedTier, BeatStats>;
    const people = [...this.people.values()].map((p): PersonBeats => {
      const sampled = ACTIVITY_CLASSES.reduce((sum, c) => sum + p.ticks[c], 0);
      const shares = Object.fromEntries(
        ACTIVITY_CLASSES.map((c) => [c, sampled === 0 ? 0 : p.ticks[c] / sampled]),
      ) as Record<ActivityClass, number>;
      const dayTicks = this.ticksPerWatch * this.watchesPerDay;
      const sleepStarts = p.sleepStartTicks.map((tick) => ({
        day: Math.floor(tick / dayTicks) + 1,
        secondOfDay: Math.round((tick % dayTicks) / this.tickRate),
      }));
      return {
        name: p.name,
        shares,
        longestIdleSeconds: p.longestIdle / this.tickRate,
        sleepStarts,
        daysRecreated: p.recreatedDays.size,
        longestBoredSeconds: p.longestBored / this.tickRate,
        longestVeryBoredSeconds: p.longestVeryBored / this.tickRate,
      };
    });
    const port = this.port.map((w) => ({
      dockedSeconds: w.docked / this.tickRate,
      cargoOpenSeconds: w.cargoOpen / this.tickRate,
      cargoStallSeconds: w.cargoStall / this.tickRate,
      longestCargoStallSeconds: w.longestStall / this.tickRate,
      gangwayWantedSeconds: w.gangwayWanted / this.tickRate,
      gangwaySeconds: w.gangway / this.tickRate,
    }));
    const otherLabels = Object.fromEntries(
      [...this.other].sort((a, b) => b[1] - a[1]).map(([label, t]) => [label, t / this.tickRate]),
    );
    return {
      watches: this.watches,
      beats,
      roomsAtWatchEnd,
      messFill: this.messFill(),
      people,
      helmUnattendedSeconds: this.unattendedTicks / this.tickRate,
      port,
      otherLabels,
      byActivity: Object.fromEntries(
        [...this.activities]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, t]) => [id, { ...t }]),
      ),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

/** Sim ticks between activity samples (0.5 s at 20 Hz): fine enough for an idle stretch. */
const SAMPLE_TICKS = 10;

export interface BeatsOptions {
  readonly scenario: PacingScenario;
  readonly days: number;
  readonly seed: number;
  /** D95: which asteroid fields the run schedules, one a leg. */
  readonly fields: FieldPlan;
}

export interface BeatsResult extends BeatsTallyResult {
  readonly scenario: PacingScenario;
  readonly seed: number;
  readonly days: number;
  readonly watchSeconds: number;
  readonly simSeconds: number;
  /** Voyages hub → Ossory → hub completed in the run. */
  readonly roundTrips: number;
  readonly hooksByKind: Readonly<Partial<Record<NarratorHook["kind"], number>>>;
  /** D81: provisions aboard at the end of the run. */
  readonly provisionsCratesAtEnd: number;
  readonly provisionsDaysAtEnd: number;
  /** D85: the warmest and coldest directed affinities at the end, "A → B +4". */
  readonly affinityExtremes: {
    readonly highest: readonly string[];
    readonly lowest: readonly string[];
  };
  /** D85: every rivalry at the end, as the digest says it. */
  readonly rivalries: readonly string[];
  /** D88: the spread of directed affinities between crew at the end of each ship's day. */
  readonly affinityByDay: readonly AffinitySpread[];
  /** D90: every machine that wears, in deck order. */
  readonly machineWear: readonly MachineWear[];
  /** D95: the asteroid fields and what they cost. */
  readonly field: FieldTallyResult;
}

/** D90: how a wearing machine held up over the run. */
export interface MachineWear {
  readonly name: string;
  /** Condition at the end of each ship's day. */
  readonly byDay: readonly number[];
  /** The lowest condition sampled. */
  readonly lowest: number;
  /** Maintenance services completed (`maintenanceDue` resolved). */
  readonly services: number;
}

/** D90: wear tracking over a run, sampled with everything else. */
class WearTally {
  private readonly machines: { id: MachineId; name: string; byDay: number[]; lowest: number }[];
  private readonly services = new Map<string, number>();

  constructor(world: World) {
    this.machines = Object.values(world.state.machines).flatMap((machine) => {
      const def = world.content.machines[machine.defId];
      if (def === undefined || def.failure.wearPerSecond <= 0) return [];
      return [{ id: machine.id, name: def.name, byDay: [], lowest: machine.condition }];
    });
  }

  sample(world: World): void {
    for (const m of this.machines) {
      const condition = world.state.machines[m.id]?.condition ?? 0;
      m.lowest = Math.min(m.lowest, condition);
    }
  }

  endOfDay(world: World): void {
    for (const m of this.machines) m.byDay.push(world.state.machines[m.id]?.condition ?? 0);
  }

  events(events: readonly SimEvent[], world: World): void {
    for (const event of events) {
      if (event.type !== "problemResolved") continue;
      const problem = world.state.work.problems[event.payload.problemId];
      if (problem?.kind !== "maintenanceDue") continue;
      const id = problem.payload.machineId;
      this.services.set(id, (this.services.get(id) ?? 0) + 1);
    }
  }

  result(): MachineWear[] {
    return this.machines.map((m) => ({
      name: m.name,
      byDay: m.byDay,
      lowest: m.lowest,
      services: this.services.get(m.id) ?? 0,
    }));
  }
}

/** D88: one day's directed crew affinities: the extremes and how many pairs stand out. */
export interface AffinitySpread {
  readonly day: number;
  readonly highest: number;
  readonly lowest: number;
  readonly mean: number;
  /** Directed pairs at or above `WARM_AT_LEAST`, and at or below `COLD_AT_MOST`. */
  readonly warm: number;
  readonly cold: number;
}

/** D88: the bands `AffinitySpread` counts: well past "close to", and "at odds with". */
const WARM_AT_LEAST = 6;
const COLD_AT_MOST = -3;

/** How many affinities each end of the extremes lists. */
const AFFINITY_EXTREMES_SHOWN = 3;

/** Rooms at each counted tier now. */
function roomCounts(world: World): Record<CountedTier, number> {
  const tiers = Object.values(world.state.dirt.tiers);
  return {
    dirty: tiers.filter((t) => t === "dirty").length,
    filthy: tiers.filter((t) => t === "filthy").length,
  };
}

/** The activity of a solo `recreate` step the actor is on now, or null. */
function soloActivityOf(
  actor: World["state"]["actors"][keyof World["state"]["actors"]],
): string | null {
  const activity = actor.activity;
  if (activity.kind === "idle") return null;
  const step = activity.plan?.steps[activity.plan.stepIndex];
  return step?.kind === "recreate" && step.role === "solo" ? step.activityId : null;
}

function crewSamples(world: World): PersonSample[] {
  return Object.values(world.state.actors)
    .filter((actor) => actor.crew && actor.passenger !== true)
    .map((actor) => ({
      id: actor.id,
      name: actor.name,
      label: actionLabel(actor, world.state, world.content),
      recreation: actor.needs.recreation,
      soloActivityId: soloActivityOf(actor),
    }));
}

/**
 * Is anyone at the helm, by the canvas labels? "at the helm, eating" is still at the helm (a plate
 * carried to the stander, D81; D84 tuning: it was counted as an empty helm).
 */
export function helmStood(labels: readonly string[]): boolean {
  return labels.some((label) => label.startsWith("at the helm"));
}

/** A notable-or-better line on the ticker: when, and whether the off-watch family's. */
export interface TickerSample {
  readonly tick: number;
  readonly offWatch: boolean;
}

/** D95: how many of the last advance's ticker lines were the field family's. */
function fieldTickerLines(world: World): number {
  return world.caches.diagnostics.lastEvents.filter(
    (event) =>
      FIELD_EVENT_TYPES.has(event.type) &&
      event.significance !== "trace" &&
      tickerLine(event, world.state, world.content) !== null,
  ).length;
}

/** The notable-or-better lines the last advance put on the ticker (as `getRenderFrame` does). */
function tickerSamples(world: World): TickerSample[] {
  return world.caches.diagnostics.lastEvents.flatMap((event) =>
    event.significance === "trace" || tickerLine(event, world.state, world.content) === null
      ? []
      : [{ tick: event.tick, offWatch: OFF_WATCH_EVENT_TYPES.has(event.type) }],
  );
}

/** D88: every directed affinity between crew members (passengers come and go), by name. */
function crewAffinities(world: World): { text: string; affinity: number }[] {
  const { actors } = world.state;
  const crew = Object.values(actors).filter((a) => a.crew && a.passenger !== true);
  const ids = new Set(crew.map((a) => a.id));
  return crew.flatMap((from) =>
    Object.entries(affinitiesFrom(world.state, world.config.values.social, from.id))
      .filter(([to]) => ids.has(to as ActorId))
      .map(([to, affinity]) => ({
        text: `${from.name} → ${actors[to as ActorId]?.name ?? to}`,
        affinity,
      })),
  );
}

/** D88: today's spread of crew affinities. */
function affinitySpread(world: World, day: number): AffinitySpread {
  const values = crewAffinities(world).map((a) => a.affinity);
  return {
    day,
    highest: Math.max(...values),
    lowest: Math.min(...values),
    mean: values.reduce((sum, v) => sum + v, 0) / values.length,
    warm: values.filter((v) => v >= WARM_AT_LEAST).length,
    cold: values.filter((v) => v <= COLD_AT_MOST).length,
  };
}

/** D85: the warmest and coldest feelings aboard at the end, "Jax Okonkwo → Tomas Ruiz +4". */
function affinityExtremes(world: World): BeatsResult["affinityExtremes"] {
  const all = crewAffinities(world);
  const said = (a: { text: string; affinity: number }) =>
    `${a.text} ${a.affinity > 0 ? "+" : ""}${a.affinity}`;
  const byAffinity = [...all].sort(
    (a, b) => b.affinity - a.affinity || a.text.localeCompare(b.text),
  );
  return {
    highest: byAffinity
      .filter((a) => a.affinity > 0)
      .slice(0, AFFINITY_EXTREMES_SHOWN)
      .map(said),
    lowest: byAffinity
      .filter((a) => a.affinity < 0)
      .reverse()
      .slice(0, AFFINITY_EXTREMES_SHOWN)
      .map(said),
  };
}

function rivalriesAtEnd(world: World): string[] {
  return Object.entries(world.state.social.rivalries)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, r]) => rivalryPhrase(world.state, world.content, key, r) ?? []);
}

/** Run `days` ship's days of the pacing voyage and tally its beats. Deterministic per seed. */
export function runBeats(options: BeatsOptions, kernel?: Kernel): BeatsResult {
  return drain(beatsRun(options, kernel));
}

/** `runBeats`, letting the event loop run between chunks (for tests; see `yielding.ts`). */
export function runBeatsAsync(options: BeatsOptions, kernel?: Kernel): Promise<BeatsResult> {
  return drainAsync(beatsRun(options, kernel));
}

/** Advances between yields: 100 sim seconds at 20 Hz. */
const ADVANCES_PER_CHUNK = 200;

function* beatsRun(options: BeatsOptions, kernel?: Kernel): ChunkedRun<BeatsResult> {
  if (!Number.isInteger(options.days) || options.days <= 0) {
    throw new RangeError(`runBeats: days must be a positive integer, got ${options.days}`);
  }
  const { bundle, config, scenarioId } = loadPacingContent();
  const k = kernel ?? createKernel(createPacingRegistry());
  const world = k.createWorld(scenarioId, options.seed, bundle, config);
  const values = world.config.values;
  const tickRate = values.time.tickRate;
  const watches = options.days * values.time.watchesPerDay;
  const ticksPerWatch = watchTicks(values);
  const endTick = watches * ticksPerWatch;
  const tally = new BeatsTally(
    watches,
    ticksPerWatch,
    tickRate,
    values.time.watchesPerDay,
    dayTicks(values, MESS_WINDOW_DAYS),
    { seekThreshold: values.needs.seekThreshold, labels: recreationLabels(world.content) },
  );
  const hooksByKind: Partial<Record<NarratorHook["kind"], number>> = {};

  let commandCount = 0;
  const send = (command: Omit<Command, "id">): void => {
    commandCount += 1;
    const result = k.enqueueCommand(world, {
      ...command,
      id: `cmd:beats:${commandCount}` as CommandId,
    } as Command);
    if (result.status !== "accepted") {
      throw new Error(`${command.kind} rejected: ${JSON.stringify(result)}`);
    }
  };
  let script = new VoyageScript(options.scenario, send);
  const fieldScript = new FieldScript(options.fields, send);
  const fieldTally = new FieldTally(options.fields, tickRate);
  let roundTrips = 0;
  let stuckAdvances = 0;
  const ticksPerDay = dayTicks(values, 1);
  const affinityByDay: AffinitySpread[] = [];
  const wear = new WearTally(world);

  let advances = 0;
  while (world.state.tick < endTick) {
    advances += 1;
    if (advances % ADVANCES_PER_CHUNK === 0) yield;
    const before = world.state.tick;
    const result = k.advance(world, Math.min(SAMPLE_TICKS, endTick - before));
    const advanced = world.state.tick - before;
    tally.events(result.events);
    wear.events(result.events, world);
    wear.sample(world);
    tally.tickerLines(tickerSamples(world));
    fieldTally.events(result.events);
    fieldTally.tickerLines(fieldTickerLines(world));
    if (advanced > 0) {
      stuckAdvances = 0;
      const people = crewSamples(world);
      const underway = world.state.travel.stage !== "docked";
      const helmEmpty = underway && !helmStood(people.map((p) => p.label));
      const problems = Object.values(world.state.work.problems).filter((p) => p.status === "open");
      const cargoOpen = problems.some(
        (p) => p.kind === "cargoToLoad" || p.kind === "cargoToUnload",
      );
      const helmWatchOpen = problems.some(
        (p) => p.kind === "stationToStaff" && p.payload.post === "watch",
      );
      tally.sample(advanced, people, {
        tick: world.state.tick,
        docked: !underway,
        helmEmpty,
        helmWatchOpen,
        cargoOpen,
        rooms: roomCounts(world),
      });
    }
    if (world.state.tick >= (affinityByDay.length + 1) * ticksPerDay) {
      affinityByDay.push(affinitySpread(world, affinityByDay.length + 1));
      wear.endOfDay(world);
    }
    script.step(world, result.events);
    fieldScript.step(world);
    if (script.done) {
      roundTrips += 1;
      script = new VoyageScript(options.scenario, send);
    }
    if (result.halt.kind === "hook") {
      const hook = world.state.narrator.pendingHook;
      if (hook === undefined) throw new Error("hook halt without a pending hook");
      hooksByKind[hook.kind] = (hooksByKind[hook.kind] ?? 0) + 1;
      send({ source: "system", kind: "acknowledgeHook", payload: { hookId: hook.id } });
    } else if (result.halt.kind === "decision") {
      const head = world.state.decisions.queue[0];
      if (head === undefined) throw new Error("decision halt without a queued decision");
      send({
        source: "player",
        kind: "resolveDecision",
        payload: { decisionId: head, side: "left" },
      });
    } else if (result.halt.kind === "lost") {
      // D93: the hull gave way; the world never steps again, so the run ends here.
      break;
    } else if (advanced === 0) {
      stuckAdvances += 1;
      if (stuckAdvances > 3) throw new Error(`beats run stuck at tick ${world.state.tick}`);
    }
  }

  return {
    ...tally.result(),
    scenario: options.scenario,
    seed: options.seed,
    days: options.days,
    watchSeconds: ticksPerWatch / tickRate,
    simSeconds: world.state.tick / tickRate,
    roundTrips,
    hooksByKind,
    provisionsCratesAtEnd: provisionsCratesAboard(world.state, world.content),
    provisionsDaysAtEnd: provisionsDays(world.state, world.content, values),
    affinityExtremes: affinityExtremes(world),
    rivalries: rivalriesAtEnd(world),
    affinityByDay,
    machineWear: wear.result(),
    field: fieldTally.result(world.state.tick, world.state.hull),
  };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

export interface BeatsCliOptions {
  readonly days: number;
  /** D95: one run per seed per scenario (`--seed 1`, or `--seeds 1-5`). */
  readonly seeds: readonly number[];
  readonly scenarios: readonly PacingScenario[];
  readonly fields: FieldPlan;
  readonly json: boolean;
}

const USAGE =
  "crew beats [--days 3] [--seed 1 | --seeds 1-5] [--scenario plain|freight|both] [--fields none|light|heavy|brutal|cycle] [--json]";

/** "1-5" → [1, 2, 3, 4, 5]; "3" → [3]; undefined when it is neither. */
function parseSeedRange(value: string | undefined): number[] | undefined {
  const match = /^(-?\d+)(?:-(-?\d+))?$/.exec(value ?? "");
  if (match === null) return undefined;
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  if (to < from) return undefined;
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function isFieldPlan(value: string | undefined): value is FieldPlan {
  return (FIELD_PLANS as readonly (string | undefined)[]).includes(value);
}

export function parseBeatsArgs(args: readonly string[]): BeatsCliOptions | { error: string } {
  let days = 3;
  let seeds: readonly number[] = [1];
  let scenarios: readonly PacingScenario[] = ["plain", "freight"];
  let fields: FieldPlan = "cycle";
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = args[i + 1];
    switch (arg) {
      case "--json":
        json = true;
        break;
      case "--days": {
        const parsed = Number(value);
        if (value === undefined || !Number.isInteger(parsed) || parsed <= 0) {
          return { error: `--days: expected a whole number of days, got "${value ?? ""}"` };
        }
        days = parsed;
        i += 1;
        break;
      }
      case "--seed": {
        const parsed = Number(value);
        if (value === undefined || !Number.isInteger(parsed)) {
          return { error: `--seed: bad value "${value ?? ""}"` };
        }
        seeds = [parsed];
        i += 1;
        break;
      }
      case "--seeds": {
        const range = parseSeedRange(value);
        if (range === undefined) {
          return { error: `--seeds: expected a seed or a range like 1-5, got "${value ?? ""}"` };
        }
        seeds = range;
        i += 1;
        break;
      }
      case "--fields":
        if (!isFieldPlan(value)) {
          return { error: `--fields: expected ${FIELD_PLANS.join(", ")}, got "${value ?? ""}"` };
        }
        fields = value;
        i += 1;
        break;
      case "--scenario":
        if (value === "both") scenarios = ["plain", "freight"];
        else if (value === "plain" || value === "freight") scenarios = [value];
        else return { error: `--scenario: expected plain, freight or both, got "${value ?? ""}"` };
        i += 1;
        break;
      default:
        return { error: `unknown option "${arg}"` };
    }
  }
  return { days, seeds, scenarios, fields, json };
}

const pct = (share: number): string => `${Math.round(share * 100)}%`;
const fmt = (n: number, digits = 1): string => n.toFixed(digits);

function scenarioSection(r: BeatsResult): string[] {
  const lines = [
    "",
    `## Scenario: ${r.scenario}, seed ${r.seed} (${r.roundTrips} round trip${r.roundTrips === 1 ? "" : "s"})`,
    "",
    "| Beat | Total | Per watch (mean) | Least | Most |",
    "|---|---|---|---|---|",
  ];
  const row = (name: string, b: BeatStats) =>
    `| ${name} | ${b.total} | ${fmt(b.perWatchMean, 2)} | ${b.perWatchMin} | ${b.perWatchMax} |`;
  for (const kind of BEAT_KINDS) lines.push(row(kind, r.beats[kind]));
  for (const tier of ROOM_TIERS_COUNTED) {
    lines.push(row(`${tier} rooms at watch end`, r.roomsAtWatchEnd[tier]));
  }
  const mess = r.messFill;
  lines.push(
    "",
    `Mess: ${mess.serves} meal${mess.serves === 1 ? "" : "s"} served; eaten hot within ${MESS_WINDOW_DAYS} day of the serve by ${fmt(mess.meanEaters)} on average (fewest ${mess.fewestEaters}); ${mess.fullServes} filled the mess (${MESS_FULL_EATERS}+). Provisions at the end: ${r.provisionsCratesAtEnd} crates, ${fmt(r.provisionsDaysAtEnd)} days.`,
    "",
    `Helm empty while not docked: ${fmt(r.helmUnattendedSeconds)} s. Narrator hooks: ${
      Object.entries(r.hooksByKind)
        .map(([k, n]) => `${k} ${n}`)
        .join(", ") || "none"
    }.`,
    "",
    "| Watch of day | Docked s | Cargo open s | Cargo stall s | Longest stall s | Gangway wanted s | Gangway stood s |",
    "|---|---|---|---|---|---|---|",
  );
  r.port.forEach((w, i) => {
    const cells = [
      w.dockedSeconds,
      w.cargoOpenSeconds,
      w.cargoStallSeconds,
      w.longestCargoStallSeconds,
      w.gangwayWantedSeconds,
      w.gangwaySeconds,
    ].map((s) => fmt(s, 0));
    lines.push(`| ${i} | ${cells.join(" | ")} |`);
  });
  lines.push(
    "",
    `| Person | ${ACTIVITY_CLASSES.join(" | ")} | Longest idle s | Days recreated | Longest bored s | Longest > ${RECREATION_HIGH} s | Sleep starts (s of day) |`,
    `|---|${ACTIVITY_CLASSES.map(() => "---").join("|")}|---|---|---|---|---|`,
  );
  for (const p of r.people) {
    const shares = ACTIVITY_CLASSES.map((c) => (p.shares[c] === 0 ? "" : pct(p.shares[c])));
    const sleeps = p.sleepStarts.map((s) => `d${s.day} ${s.secondOfDay}`).join(", ");
    lines.push(
      `| ${p.name} | ${shares.join(" | ")} | ${fmt(p.longestIdleSeconds, 0)} | ${p.daysRecreated}/${r.days} | ${fmt(p.longestBoredSeconds, 0)} | ${fmt(p.longestVeryBoredSeconds, 0)} | ${sleeps} |`,
    );
  }
  lines.push(...offWatchLines(r), ...wearLines(r), ...fieldSection(r.field));
  const other = Object.entries(r.otherLabels);
  if (other.length > 0) {
    lines.push(
      "",
      `Unclassified labels: ${other.map(([label, s]) => `"${label}" ${fmt(s, 0)} s`).join(", ")}.`,
    );
  }
  return lines;
}

/** D90: each wearing machine's condition by day, its lowest and its services. */
function wearLines(r: BeatsResult): string[] {
  const days = r.machineWear[0]?.byDay.length ?? 0;
  const dayCols = Array.from({ length: days }, (_, i) => `Day ${i + 1}`);
  return [
    "",
    `| Machine | ${dayCols.join(" | ")} | Lowest | Services |`,
    `|---|${dayCols.map(() => "---").join("|")}|---|---|`,
    ...r.machineWear.map(
      (m) =>
        `| ${m.name} | ${m.byDay.map((c) => pct(c)).join(" | ")} | ${pct(m.lowest)} | ${m.services} |`,
    ),
  ];
}

/** D84-D85: sessions by activity, then the affinity extremes and the rivalries at the end. */
function offWatchLines(r: BeatsResult): string[] {
  const lines = [
    "",
    "| Activity | Opened | Started | Collapsed | Abandoned | Solo |",
    "|---|---|---|---|---|---|",
  ];
  const activities = Object.entries(r.byActivity);
  for (const [id, a] of activities) {
    lines.push(
      `| ${id} | ${a.opened} | ${a.started} | ${a.collapsed} | ${a.abandoned} | ${a.solo} |`,
    );
  }
  if (activities.length === 0) lines.push("| (none) | | | | | |");
  const opened = activities.reduce((n, [, a]) => n + a.opened, 0);
  const collapsed = activities.reduce((n, [, a]) => n + a.collapsed, 0);
  const share = opened === 0 ? "n/a" : pct(collapsed / opened);
  lines.push(
    "",
    `Sessions collapsed: ${share} of ${opened} opened.`,
    `Warmest at the end: ${r.affinityExtremes.highest.join("; ") || "none"}. Coldest: ${r.affinityExtremes.lowest.join("; ") || "none"}.`,
    `Rivalries at the end: ${r.rivalries.join("; ") || "none"}.`,
    "",
    `| Day | Highest | Lowest | Mean | Pairs ≥ +${WARM_AT_LEAST} | Pairs ≤ ${COLD_AT_MOST} |`,
    "|---|---|---|---|---|---|",
    ...r.affinityByDay.map(
      (d) =>
        `| ${d.day} | ${d.highest} | ${d.lowest} | ${fmt(d.mean, 1)} | ${d.warm} | ${d.cold} |`,
    ),
  );
  return lines;
}

export function formatBeatsReport(results: readonly BeatsResult[]): string {
  const first = results[0];
  if (first === undefined) return "beats: no results";
  const seeds = [...new Set(results.map((r) => r.seed))];
  const seedWord = seeds.length === 1 ? `seed ${seeds[0]}` : `seeds ${seeds.join(", ")}`;
  const lost = results.filter((r) => r.field.lostAtSeconds !== null);
  return [
    `# Beats: ${first.days} day${first.days === 1 ? "" : "s"}, ${first.watches} watches of ${fmt(first.watchSeconds, 0)} s (${seedWord}, instant narrator, cards answered left, fields ${first.field.plan})`,
    "",
    `Ships lost: ${lost.length} of ${results.length} run${results.length === 1 ? "" : "s"}${lost.length === 0 ? "" : ` (${lost.map((r) => `${r.scenario} seed ${r.seed}`).join(", ")})`}.`,
    ...results.flatMap(scenarioSection),
  ].join("\n");
}

export function runBeatsCli(args: readonly string[]): { output: string; exitCode: 0 | 1 } {
  const options = parseBeatsArgs(args);
  if ("error" in options) {
    return { output: `crew beats: ${options.error} (usage: ${USAGE})`, exitCode: 1 };
  }
  const kernel = createKernel(createPacingRegistry());
  const results = options.scenarios.flatMap((scenario) =>
    options.seeds.map((seed) =>
      runBeats({ scenario, days: options.days, seed, fields: options.fields }, kernel),
    ),
  );
  const output = options.json ? JSON.stringify(results, null, 2) : formatBeatsReport(results);
  return { output, exitCode: 0 };
}
