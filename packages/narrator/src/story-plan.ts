/**
 * §the-plan: the server's bookkeeping for the narrator's plan (season, arc, episode), the sibling
 * of `mergeThreads`. The model rewrites the plan in its notes turn; the server keeps what only it
 * can know: which beats landed and when (§beat-attribution), how many times a tier was rewritten,
 * the premise it replaced, and which tiers ended (§seasons-and-stalls). The server states the
 * record and never judges the pace (D46).
 */
import type { DeepReadonly, SimEvent, WorldState } from "@crew/sim";
import {
  type ArcSketch,
  type BeatInMotion,
  type BeatTension,
  EMPTY_SKETCH,
  NOTES_LIMITS,
  type PastArc,
  type PlanTier,
  type PlannedBeat,
  type StoryPlan,
  type Tempo,
} from "./notes";

/** §the-plan: a beat as the model writes it; everything else about it is the server's. */
export interface WrittenBeat {
  readonly name: string;
  readonly what: string;
  readonly tension: BeatTension;
  readonly thread: string;
  readonly decided: boolean;
}

/** §the-plan: a tier as the model writes it. An empty premise keeps the tier as it stands. */
export interface WrittenSketch {
  readonly premise: string;
  readonly beats: readonly WrittenBeat[];
  readonly until: string;
  readonly tempo: Tempo;
  readonly revised: string;
}

/** §the-plan: the plan as the model writes it in the notes turn. */
export interface WrittenPlan {
  readonly season: WrittenSketch;
  readonly arc: WrittenSketch;
  readonly episode: WrittenSketch;
  /** §seasons-and-stalls: tiers that finished this call; a wider tier ends the narrower ones. */
  readonly ended: readonly PlanTier[];
  /** §beat-attribution: arc or season beats that happened this call, by exact name. */
  readonly landed: readonly string[];
}

const KEEP_SKETCH: WrittenSketch = {
  premise: "",
  beats: [],
  until: "",
  tempo: "steady",
  revised: "",
};

/** The plan written so that nothing changes: every tier kept, nothing ended or landed. */
export const KEEP_PLAN: WrittenPlan = {
  season: KEEP_SKETCH,
  arc: KEEP_SKETCH,
  episode: KEEP_SKETCH,
  ended: [],
  landed: [],
};

/**
 * §beat-attribution: when a beat named by an intent lands. A card or an offer lands when it goes
 * up or is made; a pressure or an outcome lever when its event fires.
 */
export type BeatLanding = "now" | "onFire";

/** §beat-attribution: one intent of this call that named a beat. */
export interface BeatAttribution {
  readonly beat: string;
  readonly kind: string;
  readonly commandId: string;
  readonly lands: BeatLanding;
}

/** §beat-attribution: the intents that land at the hook tick rather than when they fire. */
export const LANDS_WHEN_MADE: ReadonlySet<string> = new Set([
  "offerJob",
  "surfaceDecision",
  "spawnAtBoundary",
  "stockMarket",
]);

/**
 * §beat-attribution: the events that mean a narrator command fired, when the command's id is among
 * their causes: a fault breaking (scheduled or injected), a hazard rolled, a field seen or hit, a
 * strike, a sum, a memory, a falling-out, a thought, a fault noticed.
 */
const FIRING_EVENTS: ReadonlySet<string> = new Set([
  "faultOccurred",
  "navHazard",
  "fieldSighted",
  "fieldEntered",
  "struck",
  "transacted",
  "memoryPlanted",
  "argument",
  "thoughtGiven",
  "faultObserved",
]);

/** §beat-attribution: events that mean a narrator command will never fire, and why. */
const MISSED_EVENTS: Readonly<Record<string, string>> = {
  commandRejected: "the sim refused it",
  navHazardMissed: "the leg ended before it fired",
  fieldMissed: "the leg ended before it came",
};

/** §beat-attribution: the levers that take effect when applied, the tick after the hook. */
const FIRES_ON_APPLY: ReadonlySet<string> = new Set([
  "strike",
  "transact",
  "plantMemory",
  "fallOut",
  "giveThought",
  "reveal",
  "injectFault",
]);

const key = (text: string) => text.trim().toLowerCase();

type Evidence =
  | { readonly kind: "fired"; readonly tick: number }
  | { readonly kind: "waiting" }
  | { readonly kind: "missed"; readonly why: string };

/**
 * What became of one command: its firing event in recent events, a refusal or a miss there, or
 * failing those (recent events are capped and may have lost it) the state: a scheduled fault,
 * hazard or field still waiting, a fault or a field that happened, an applied lever.
 */
function evidenceFor(
  motion: BeatInMotion,
  events: readonly SimEvent[],
  state: DeepReadonly<WorldState>,
): Evidence {
  const id = motion.commandId;
  for (const event of events) {
    if (!event.causeIds.includes(id as never)) continue;
    if (FIRING_EVENTS.has(event.type)) return { kind: "fired", tick: event.tick };
    const why = MISSED_EVENTS[event.type];
    if (why !== undefined) return { kind: "missed", why };
  }
  for (const machine of Object.values(state.machines)) {
    const fault = machine.faults.find((f) => f.causeCommandId === id);
    if (fault !== undefined) return { kind: "fired", tick: fault.sinceTick };
    if (machine.scheduledFaults.some((f) => f.causeCommandId === id)) return { kind: "waiting" };
  }
  if (state.hazards.some((h) => h.causeCommandId === id)) return { kind: "waiting" };
  const field = state.field;
  if (field?.causeCommandId === id) {
    return field.noticedAtTick === undefined
      ? { kind: "waiting" }
      : { kind: "fired", tick: field.noticedAtTick };
  }
  // An applied lever with its event lost to the recent-events cap: it applied the tick after the
  // hook. A refusal lost the same way cannot be told apart, and a refusal is rare (the translator
  // checks the same impossibles first).
  if (FIRES_ON_APPLY.has(motion.kind) && state.commands.recentIds.includes(id as never)) {
    return { kind: "fired", tick: motion.sinceTick + 1 };
  }
  return { kind: "missed", why: "it never fired" };
}

/**
 * §beat-attribution: before the digest, stamp the episode beats whose levers fired since the last
 * call (landed at the event's tick), keep those still waiting, and put back to planned (with a line
 * for "rejected last time") those whose every lever was refused or never fired.
 */
export function stampFiredBeats(
  plan: StoryPlan,
  events: readonly SimEvent[],
  state: DeepReadonly<WorldState>,
): { readonly plan: StoryPlan; readonly corrections: readonly string[] } {
  const corrections: string[] = [];
  const beats = plan.episode.beats.map((beat): PlannedBeat => {
    if (beat.inMotion.length === 0) return beat;
    const evidence = beat.inMotion.map((m) => ({ m, e: evidenceFor(m, events, state) }));
    const fired = evidence.flatMap(({ e }) => (e.kind === "fired" ? [e.tick] : []));
    if (fired.length > 0) {
      return { ...beat, status: "landed", landedTick: Math.min(...fired), inMotion: [] };
    }
    const waiting = evidence.filter(({ e }) => e.kind === "waiting").map(({ m }) => m);
    for (const { m, e } of evidence) {
      if (e.kind !== "missed") continue;
      corrections.push(
        waiting.length > 0
          ? `beat "${beat.name}": your ${m.kind} for it did not land (${e.why}); another lever for it is still waiting`
          : `beat "${beat.name}": your ${m.kind} for it did not land (${e.why}); the beat is planned again`,
      );
    }
    return { ...beat, inMotion: waiting };
  });
  return { plan: { ...plan, episode: { ...plan.episode, beats } }, corrections };
}

function planned(beat: WrittenBeat): PlannedBeat {
  return { ...beat, status: "planned", landedTick: null, inMotion: [] };
}

function landedAt(beat: PlannedBeat, tick: number): PlannedBeat {
  return { ...beat, status: "landed", landedTick: tick, inMotion: [] };
}

/** A beat that is part of the record: it happened, or a lever for it is on its way. */
const inRecord = (beat: PlannedBeat) => beat.status === "landed" || beat.inMotion.length > 0;

/** §the-plan: a fresh sketch from what the model wrote (a new tier, or the first). */
function sketchFrom(written: WrittenSketch, tick: number): ArcSketch {
  if (written.premise.trim() === "") return EMPTY_SKETCH;
  return {
    premise: written.premise,
    beats: written.beats.map(planned),
    until: written.until,
    tempo: written.tempo,
    revised: written.revised,
    revisions: 0,
    previousPremise: "",
    openedTick: tick,
  };
}

/**
 * §the-plan: a tier the model rewrote. Beats carry their status by name. A beat in the record (it
 * landed, or a lever for it is on its way) that the model left out is kept and reported; a planned
 * beat left out is set aside, `changed` when the model said why this call (`revised` is new) and
 * `skipped` otherwise, and shown one call. A new premise bumps `revisions` and the old one rides
 * one call.
 */
function rewriteSketch(
  tier: PlanTier,
  previous: ArcSketch,
  written: WrittenSketch,
  tick: number,
  corrections: string[],
): ArcSketch {
  if (previous.premise === "") return sketchFrom(written, tick);
  const before = new Map(previous.beats.map((b) => [key(b.name), b]));
  const writtenKeys = new Set(written.beats.map((b) => key(b.name)));
  const kept = previous.beats.filter((b) => !writtenKeys.has(key(b.name)) && inRecord(b));
  for (const b of kept) {
    corrections.push(
      `kept beat "${b.name}" of your ${tier}: it ${b.status === "landed" ? "has landed" : "is in motion"} and stays in the plan; list it again`,
    );
  }
  const rewritten = written.beats.map((w): PlannedBeat => {
    const earlier = before.get(key(w.name));
    if (earlier === undefined || !inRecord(earlier)) return planned(w);
    return {
      ...w,
      status: earlier.status,
      landedTick: earlier.landedTick,
      inMotion: earlier.inMotion,
    };
  });
  const why = key(written.revised) !== key(previous.revised) ? "changed" : "skipped";
  const setAside = previous.beats
    .filter((b) => !writtenKeys.has(key(b.name)) && b.status === "planned" && !inRecord(b))
    .map((b): PlannedBeat => ({ ...b, status: why, landedTick: tick }));
  const room = NOTES_LIMITS.planBeats - kept.length;
  if (rewritten.length > room) {
    corrections.push(
      `your ${tier} had more beats than fit (${NOTES_LIMITS.planBeats} with those kept): the last ${rewritten.length - room} were left out`,
    );
  }
  const beats = [...kept, ...rewritten.slice(0, Math.max(0, room))];
  const newPremise = key(written.premise) !== key(previous.premise);
  return {
    premise: written.premise,
    beats: [...beats, ...setAside.slice(0, Math.max(0, NOTES_LIMITS.planBeats - beats.length))],
    until: written.until,
    tempo: written.tempo,
    revised: written.revised,
    revisions: previous.revisions + (newPremise ? 1 : 0),
    previousPremise: newPremise ? previous.premise : "",
    openedTick: previous.openedTick,
  };
}

/** Beats set aside (`changed`, `skipped`) ride one call; the next merge lets them go. */
function withoutSetAside(sketch: ArcSketch): ArcSketch {
  return {
    ...sketch,
    beats: sketch.beats.filter((b) => b.status === "planned" || b.status === "landed"),
    previousPremise: "",
  };
}

const ARCHIVED_STATUS: Readonly<Record<PlannedBeat["status"], string>> = {
  planned: "never landed",
  landed: "landed",
  skipped: "skipped",
  changed: "changed",
};

/** §seasons-and-stalls: an ended season or arc, as a past arc (premise as its title). */
function pastArcOf(tier: "season" | "arc", sketch: ArcSketch, tick: number): PastArc {
  const beats = sketch.beats.map((b) => `${b.name} (${ARCHIVED_STATUS[b.status]})`).join("; ");
  const revised = sketch.revised === "" ? "" : ` Last revised: ${sketch.revised}`;
  return {
    title: sketch.premise,
    scale: tier,
    people: [],
    openedTick: sketch.openedTick,
    closedTick: tick,
    ending: "planEnded",
    shape: `${sketch.tempo} ${tier}`,
    summary: `${sketch.premise} Beats: ${beats === "" ? "none" : beats}.${revised}`,
  };
}

/** The tiers that end: a wider tier ends every narrower one. */
function endedTiers(ended: readonly PlanTier[]): ReadonlySet<PlanTier> {
  const out = new Set<PlanTier>(ended);
  if (out.has("season")) out.add("arc");
  if (out.has("arc")) out.add("episode");
  return out;
}

/** Land each named beat still planned in `sketch`; returns the sketch and the names it matched. */
function landNamed(
  sketch: ArcSketch,
  names: readonly string[],
  tick: number,
): { readonly sketch: ArcSketch; readonly matched: ReadonlySet<string> } {
  const wanted = new Set(names.map(key));
  const matched = new Set<string>();
  const beats = sketch.beats.map((b) => {
    if (!wanted.has(key(b.name))) return b;
    matched.add(key(b.name));
    return b.status === "planned" ? landedAt(b, tick) : b;
  });
  return { sketch: { ...sketch, beats }, matched };
}

/** §beat-attribution: apply this call's attributions to the episode; returns those it matched. */
function attribute(
  episode: ArcSketch,
  attributions: readonly BeatAttribution[],
  tick: number,
): { readonly episode: ArcSketch; readonly unmatched: readonly BeatAttribution[] } {
  const unmatched: BeatAttribution[] = [];
  let beats = episode.beats;
  for (const a of attributions) {
    const i = beats.findIndex((b) => key(b.name) === key(a.beat));
    const beat = beats[i];
    if (beat === undefined) {
      unmatched.push(a);
      continue;
    }
    if (beat.status === "landed") continue;
    const next: PlannedBeat =
      a.lands === "now"
        ? landedAt(beat, tick)
        : {
            ...beat,
            status: "planned",
            inMotion: [...beat.inMotion, { commandId: a.commandId, kind: a.kind, sinceTick: tick }],
          };
    beats = beats.map((b, j) => (j === i ? next : b));
  }
  return { episode: { ...episode, beats }, unmatched };
}

export interface PlanMergeInput {
  readonly written: WrittenPlan;
  readonly previous: StoryPlan;
  readonly tick: number;
  /** This call's intents that named a beat. */
  readonly attributions: readonly BeatAttribution[];
  /** §closing-cards: the title of the thread this call's closing card ended. */
  readonly closedThread: string | undefined;
  /** This call made an offer (an `offerJob` command). */
  readonly offerMade: boolean;
}

export interface MergedPlan {
  readonly plan: StoryPlan;
  /** Lines for "rejected last time": what the server did to the plan the model wrote. */
  readonly corrections: readonly string[];
  /** §seasons-and-stalls: seasons and arcs that ended this call, for "Past arcs". */
  readonly ended: readonly PastArc[];
}

/**
 * §the-plan: the plan after a call. In order: beats set aside last call are let go; this call's
 * attributions land on (or put in motion) the episode beats the digest showed; arc and season
 * beats the model reports in `landed` land at the hook tick; each tier is ended (a season or arc
 * becomes a past arc, an episode counts toward the stall), kept (empty premise) or rewritten;
 * attributions that named no beat the digest showed are tried on the episode just written, and
 * otherwise reported; a new episode opened by an offer has its setup land; and a closing card sets
 * aside the still-planned beats of its thread as `changed`.
 */
export function mergePlan(input: PlanMergeInput): MergedPlan {
  const { written, tick } = input;
  const corrections: string[] = [];
  const pastArcs: PastArc[] = [];
  const first = attribute(withoutSetAside(input.previous.episode), input.attributions, tick);
  const landedBefore = {
    season: landNamed(withoutSetAside(input.previous.season), written.landed, tick),
    arc: landNamed(withoutSetAside(input.previous.arc), written.landed, tick),
  };
  const previous: Record<PlanTier, ArcSketch> = {
    season: landedBefore.season.sketch,
    arc: landedBefore.arc.sketch,
    episode: first.episode,
  };

  const ending = endedTiers(written.ended);
  const next = {} as Record<PlanTier, ArcSketch>;
  for (const tier of ["season", "arc", "episode"] as const) {
    const old = previous[tier];
    if (ending.has(tier)) {
      if (old.premise !== "" && tier !== "episode") pastArcs.push(pastArcOf(tier, old, tick));
      next[tier] = sketchFrom(written[tier], tick);
    } else if (written[tier].premise.trim() === "") {
      next[tier] = old;
    } else {
      next[tier] = rewriteSketch(tier, old, written[tier], tick, corrections);
    }
  }

  // Names reported landed that only the rewritten upper tiers have.
  const seen = new Set([...landedBefore.season.matched, ...landedBefore.arc.matched]);
  const lateNames = written.landed.filter((n) => !seen.has(key(n)));
  const lateSeason = landNamed(next.season, lateNames, tick);
  const lateArc = landNamed(next.arc, lateNames, tick);
  next.season = lateSeason.sketch;
  next.arc = lateArc.sketch;
  // §seasons-and-stalls: an episode that ends with no arc beat landed counts toward a stall; an arc
  // beat or a new arc starts the count again.
  const arcMoved =
    ending.has("arc") || landedBefore.arc.matched.size > 0 || lateArc.matched.size > 0;
  const episodeEnded = ending.has("episode") && previous.episode.premise !== "";
  const episodesSinceArcBeat = arcMoved
    ? 0
    : input.previous.episodesSinceArcBeat + (episodeEnded ? 1 : 0);
  const episodeKeys = new Set(next.episode.beats.map((b) => key(b.name)));
  for (const name of lateNames) {
    const k = key(name);
    if (lateSeason.matched.has(k) || lateArc.matched.has(k)) continue;
    corrections.push(
      episodeKeys.has(k)
        ? `landed "${name}": an episode beat lands when the card or lever that serves it names it in beat, not in landed`
        : `landed "${name}": no arc or season beat has that name; nothing was stamped`,
    );
  }

  // Attributions to a beat the episode only has as of this call's notes.
  const late = attribute(next.episode, first.unmatched, tick);
  next.episode = late.episode;
  for (const a of late.unmatched) {
    corrections.push(
      `beat "${a.beat}" on your ${a.kind} is not a beat of your episode plan: nothing was attributed; copy a name from "Your plan"`,
    );
  }

  // §the-plan: the episode an offer opened has that offer as its setup.
  const opened =
    (ending.has("episode") || previous.episode.premise === "") && next.episode.premise !== "";
  if (opened && input.offerMade && !next.episode.beats.some(inRecord)) {
    const setup = next.episode.beats.findIndex((b) => b.tension === "setup");
    next.episode = {
      ...next.episode,
      beats: next.episode.beats.map((b, i) => (i === setup ? landedAt(b, tick) : b)),
    };
  }

  const closed = input.closedThread;
  const plan: StoryPlan = {
    season: closed === undefined ? next.season : setAsideThread(next.season, closed, tick),
    arc: closed === undefined ? next.arc : setAsideThread(next.arc, closed, tick),
    episode: closed === undefined ? next.episode : setAsideThread(next.episode, closed, tick),
    episodesSinceArcBeat,
  };
  return { plan, corrections, ended: pastArcs };
}

/** §the-plan: a closing card ends its thread, so its still-planned beats can no longer land. */
function setAsideThread(sketch: ArcSketch, thread: string, tick: number): ArcSketch {
  const k = key(thread);
  return {
    ...sketch,
    beats: sketch.beats.map((b) =>
      b.status === "planned" && b.inMotion.length === 0 && b.thread !== "" && key(b.thread) === k
        ? { ...b, status: "changed", landedTick: tick }
        : b,
    ),
  };
}

/** §your-plan-in-the-digest: the first episode beat not yet landed or set aside. */
export function currentBeat(plan: StoryPlan): PlannedBeat | undefined {
  return plan.episode.beats.find((b) => b.status === "planned");
}

/** §the-plan: the tempo that applies now: the episode's over the arc's over the season's. */
export function currentTempo(plan: StoryPlan): Tempo | undefined {
  for (const tier of ["episode", "arc", "season"] as const) {
    if (plan[tier].premise !== "") return plan[tier].tempo;
  }
  return undefined;
}
