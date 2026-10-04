/**
 * `crew beats` (D76, ship-life §9 "Measure it"): the tuning instrument for the ship's day. Runs
 * the pacing voyage (`pacing.ts`'s `VoyageScript`, registry and content) round trip after round
 * trip until N ship's days have passed, with an instant narrator (every hook answered at once with
 * no commands) and every card answered by its left side, and reports:
 *
 * - beats per watch by kind (bells, handovers, meals, faults, hazards, cards, conversations):
 *   the total and the mean, least and most over the run's watches;
 * - per person, the share of sim time in each activity class (read from the canvas label, which
 *   is what the player sees) and the longest idle stretch;
 * - how long the helm stood empty while the ship was not docked;
 * - port calls by watch of the day: time docked, with cargo to move, with cargo to move and
 *   nobody hauling (a stall), and with someone on the gangway;
 * - each person's sleep starts, as seconds into each day (the rhythm's anchor, D77).
 *
 * Unlike `crew pacing` there is no wall clock: the sim simply advances, so the numbers are sim
 * time and independent of playback speed. An event at tick T happened in the step ending at T,
 * so it is counted in the watch holding tick T − 1: the bell that ends a watch counts in it.
 */
import {
  type Command,
  type CommandId,
  type EventType,
  type Kernel,
  type NarratorHook,
  type SimEvent,
  type World,
  actionLabel,
  createKernel,
  watchTicks,
} from "@crew/sim";
import {
  type PacingScenario,
  VoyageScript,
  createPacingRegistry,
  loadPacingContent,
} from "./pacing";

// ---------------------------------------------------------------------------------------------
// What is counted
// ---------------------------------------------------------------------------------------------

/** The beats per watch, by the event that marks each. */
export const BEAT_EVENTS = {
  bells: "bell",
  handovers: "helmRelieved",
  meals: "ateMeal",
  faults: "faultOccurred",
  hazards: "navHazard",
  cards: "decisionPending",
  conversations: "conversation",
} as const satisfies Record<string, EventType>;
export type BeatKind = keyof typeof BEAT_EVENTS;
const BEAT_KINDS = Object.keys(BEAT_EVENTS) as BeatKind[];

export const ACTIVITY_CLASSES = [
  "helm",
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
 * is "other", and the report lists those labels so a new one is noticed.
 */
const LABEL_CLASSES: readonly (readonly [RegExp, ActivityClass])[] = [
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
];

export function activityClass(label: string): ActivityClass {
  for (const [pattern, cls] of LABEL_CLASSES) if (pattern.test(label)) return cls;
  return "other";
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
}

export interface BeatsTallyResult {
  readonly watches: number;
  readonly beats: Readonly<Record<BeatKind, BeatStats>>;
  readonly people: readonly PersonBeats[];
  readonly helmUnattendedSeconds: number;
  /** Port calls by watch of the day (index = watch of the day). */
  readonly port: readonly PortWatchBeats[];
  /** Labels that matched no class, with the sim-seconds spent in each. */
  readonly otherLabels: Readonly<Record<string, number>>;
}

/** One person's label at a sample. */
export interface PersonSample {
  readonly id: string;
  readonly name: string;
  readonly label: string;
}

interface PersonTally {
  readonly name: string;
  readonly ticks: Record<ActivityClass, number>;
  idleRun: number;
  longestIdle: number;
  asleep: boolean;
  readonly sleepStartTicks: number[];
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
  BEAT_KINDS.map((kind) => [BEAT_EVENTS[kind], kind] as const),
);

export class BeatsTally {
  private readonly perWatch: Record<BeatKind, number[]>;
  private readonly people = new Map<string, PersonTally>();
  private readonly other = new Map<string, number>();
  private readonly port: PortWatchTally[];
  private unattendedTicks = 0;

  /**
   * @param watches the run's watches; events in later watches (none, if the run stops at the
   *   end of its last watch) are an error.
   * @param ticksPerWatch from the config (`watchTicks`).
   * @param watchesPerDay from the config (`time.watchesPerDay`), for the port calls by watch.
   */
  constructor(
    private readonly watches: number,
    private readonly ticksPerWatch: number,
    private readonly tickRate: number,
    private readonly watchesPerDay: number,
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
  }

  /** The watch an event at `tick` is counted in (the step ending at `tick`). */
  watchOf(tick: number): number {
    return Math.floor(Math.max(0, tick - 1) / this.ticksPerWatch);
  }

  events(events: readonly Pick<SimEvent, "type" | "tick">[]): void {
    for (const event of events) {
      const kind = EVENT_TO_BEAT.get(event.type);
      if (kind === undefined) continue;
      const watch = this.watchOf(event.tick);
      const counts = this.perWatch[kind];
      if (watch >= this.watches) {
        throw new RangeError(`${event.type} at tick ${event.tick} is past the run's last watch`);
      }
      counts[watch] = (counts[watch] ?? 0) + 1;
    }
  }

  /**
   * `ticks` of sim time ending at `ship.tick`, with each person's label at its end and the
   * ship's state then.
   */
  sample(ticks: number, people: readonly PersonSample[], ship: ShipSample): void {
    if (ship.helmEmpty) this.unattendedTicks += ticks;
    let hauling = false;
    let gangway = false;
    for (const person of people) {
      const tally = this.personTally(person);
      const cls = activityClass(person.label);
      tally.ticks[cls] += ticks;
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
    };
    this.people.set(person.id, fresh);
    return fresh;
  }

  result(): BeatsTallyResult {
    const beats = Object.fromEntries(
      BEAT_KINDS.map((kind) => {
        const counts = this.perWatch[kind];
        const total = counts.reduce((sum, n) => sum + n, 0);
        return [
          kind,
          {
            total,
            perWatchMean: total / this.watches,
            perWatchMin: Math.min(...counts),
            perWatchMax: Math.max(...counts),
          },
        ];
      }),
    ) as Record<BeatKind, BeatStats>;
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
      people,
      helmUnattendedSeconds: this.unattendedTicks / this.tickRate,
      port,
      otherLabels,
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
}

function crewSamples(world: World): PersonSample[] {
  return Object.values(world.state.actors)
    .filter((actor) => actor.crew && actor.passenger !== true)
    .map((actor) => ({
      id: actor.id,
      name: actor.name,
      label: actionLabel(actor, world.state, world.content),
    }));
}

/** Run `days` ship's days of the pacing voyage and tally its beats. Deterministic per seed. */
export function runBeats(options: BeatsOptions, kernel?: Kernel): BeatsResult {
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
  const tally = new BeatsTally(watches, ticksPerWatch, tickRate, values.time.watchesPerDay);
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
  let roundTrips = 0;
  let stuckAdvances = 0;

  while (world.state.tick < endTick) {
    const before = world.state.tick;
    const result = k.advance(world, Math.min(SAMPLE_TICKS, endTick - before));
    const advanced = world.state.tick - before;
    tally.events(result.events);
    if (advanced > 0) {
      stuckAdvances = 0;
      const people = crewSamples(world);
      const underway = world.state.travel.stage !== "docked";
      const helmEmpty = underway && !people.some((p) => p.label === "at the helm");
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
      });
    }
    script.step(world, result.events);
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
  };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

export interface BeatsCliOptions {
  readonly days: number;
  readonly seed: number;
  readonly scenarios: readonly PacingScenario[];
  readonly json: boolean;
}

const USAGE = "crew beats [--days 3] [--seed 1] [--scenario plain|freight|both] [--json]";

export function parseBeatsArgs(args: readonly string[]): BeatsCliOptions | { error: string } {
  let days = 3;
  let seed = 1;
  let scenarios: readonly PacingScenario[] = ["plain", "freight"];
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
        seed = parsed;
        i += 1;
        break;
      }
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
  return { days, seed, scenarios, json };
}

const pct = (share: number): string => `${Math.round(share * 100)}%`;
const fmt = (n: number, digits = 1): string => n.toFixed(digits);

function scenarioSection(r: BeatsResult): string[] {
  const lines = [
    "",
    `## Scenario: ${r.scenario} (${r.roundTrips} round trip${r.roundTrips === 1 ? "" : "s"})`,
    "",
    "| Beat | Total | Per watch (mean) | Least | Most |",
    "|---|---|---|---|---|",
  ];
  for (const kind of BEAT_KINDS) {
    const b = r.beats[kind];
    lines.push(
      `| ${kind} | ${b.total} | ${fmt(b.perWatchMean, 2)} | ${b.perWatchMin} | ${b.perWatchMax} |`,
    );
  }
  lines.push(
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
    `| Person | ${ACTIVITY_CLASSES.join(" | ")} | Longest idle s | Sleep starts (s of day) |`,
    `|---|${ACTIVITY_CLASSES.map(() => "---").join("|")}|---|---|`,
  );
  for (const p of r.people) {
    const shares = ACTIVITY_CLASSES.map((c) => (p.shares[c] === 0 ? "" : pct(p.shares[c])));
    const sleeps = p.sleepStarts.map((s) => `d${s.day} ${s.secondOfDay}`).join(", ");
    lines.push(
      `| ${p.name} | ${shares.join(" | ")} | ${fmt(p.longestIdleSeconds, 0)} | ${sleeps} |`,
    );
  }
  const other = Object.entries(r.otherLabels);
  if (other.length > 0) {
    lines.push(
      "",
      `Unclassified labels: ${other.map(([label, s]) => `"${label}" ${fmt(s, 0)} s`).join(", ")}.`,
    );
  }
  return lines;
}

export function formatBeatsReport(results: readonly BeatsResult[]): string {
  const first = results[0];
  if (first === undefined) return "beats: no results";
  return [
    `# Beats: ${first.days} day${first.days === 1 ? "" : "s"}, ${first.watches} watches of ${fmt(first.watchSeconds, 0)} s (seed ${first.seed}, instant narrator, cards answered left)`,
    ...results.flatMap(scenarioSection),
  ].join("\n");
}

export function runBeatsCli(args: readonly string[]): { output: string; exitCode: 0 | 1 } {
  const options = parseBeatsArgs(args);
  if ("error" in options) {
    return { output: `crew beats: ${options.error} (usage: ${USAGE})`, exitCode: 1 };
  }
  const kernel = createKernel(createPacingRegistry());
  const results = options.scenarios.map((scenario) =>
    runBeats({ scenario, days: options.days, seed: options.seed }, kernel),
  );
  const output = options.json ? JSON.stringify(results, null, 2) : formatBeatsReport(results);
  return { output, exitCode: 0 };
}
