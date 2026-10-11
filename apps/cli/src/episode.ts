/**
 * `crew episode` (expeditions A2, the W4 harness): one errand, end to end, on the real content with
 * every system (`createPacingRegistry`), headless.
 *
 * At tick 0 a scenario `offerJob` posts a `fetchPerson` errand at the start port (the Hub) for the
 * authored site nearest it by the `"all"` port graph (Harrow End, via Green Meridian), surfaced as
 * the offer card and paid at the standard tier of `errandPay` over the path there and back. From
 * then on nothing is scripted: the ship plays itself. Every narrator hook is answered by the null
 * narrator (`nullNarratorResponse` with the content, as the server answers when no model is
 * configured): its commands are sent, then `acknowledgeHook`, and a policy card's template prose is
 * kept for the transcript. Every card is answered by `episodeChoice`: the errand's offer is taken,
 * any other offer passed, the arrival card's `hold-` plan adopted (else its left side), the turn
 * card's "Press on", and anything else its left side (as `crew beats` answers cards).
 *
 * Invariants (`checkInvariants`, `travelViolations`) are checked after every step. The run stops
 * once the job is closed (paid or failed) with the ship docked at home, when the hull is lost, or
 * when the episode has made no progress for `STALL_SECONDS` of sim time (a stage that never comes,
 * e.g. a stubbed landing), and reports the milestones reached in order, every episode event, the
 * ticker as it read with sim times, the cards and how they were answered, money before and after,
 * and any violation. `formatEpisodeTranscript` prints it for a reader judging the pacing:
 *
 *     pnpm --filter @crew/cli dev episode [--seed N] [--site <port id>] [--item <item id>]
 *       [--arrival <posture>] [--unseen <posture>] [--all]
 *
 * (`--all` adds ship life, meals and bells and talk, to the episode's own lines.)
 *
 * Tests may vary it (`EpisodeOptions`): `fetchItem` (`--item`) offers a `fetchItem` errand
 * instead, `turnCard` `pullBack` takes the turn card's other side, `arrivalCard` (`--arrival`)
 * adopts the arrival card's side of another posture (`creep` or `assault` on an item errand's
 * card), `markUnseen` (`--unseen`) has the narrator mark the side of that posture as the way in
 * unseen (§unseen-lever), and `world` plays a further errand on a world an earlier run left (made
 * by `createEpisodeWorld`, run with the same kernel).
 */
import { type DecisionCardText, NARRATOR_TEXT_KEYS, templateCard } from "@crew/content";
import { NULL_NARRATOR_MODEL, commandIdFor, nullNarratorResponse } from "@crew/narrator";
import {
  type Command,
  type CommandId,
  type Decision,
  type DecisionId,
  type DeepReadonly,
  type EnqueueResult,
  type ItemDefId,
  type JobDraft,
  type JobId,
  type Kernel,
  type NarratorHook,
  POSTURES,
  type PortDefId,
  type Posture,
  type SimEvent,
  type World,
  checkInvariants,
  createKernel,
  errandPay,
  isSite,
  portGraph,
  shortestPath,
  siteNearPort,
  tickerLine,
  travelViolations,
} from "@crew/sim";
import { createPacingRegistry, loadPacingContent } from "./pacing";
import { type ChunkedRun, drain, drainAsync } from "./yielding";

// ---------------------------------------------------------------------------------------------
// Options and result
// ---------------------------------------------------------------------------------------------

export interface EpisodeOptions {
  readonly seed: number;
  /** The site to send the ship to; absent, the authored site nearest the start port. */
  readonly siteId?: PortDefId;
  /** Hard cap on sim time, whatever happens (from the run's start). */
  readonly maxSimSeconds?: number;
  /** Fetch one of this item from the site (a `fetchItem` errand) rather than its target. */
  readonly fetchItem?: ItemDefId;
  /** How the turn card is answered: "Press on" (the default) or "Pull back to the ship". */
  readonly turnCard?: TurnCardAnswer;
  /**
   * How the arrival card is answered: the side adopting a plan of this posture (it must be on the
   * card). Absent, the side adopting a `hold` plan, else the left.
   */
  readonly arrivalCard?: Posture;
  /**
   * D105 (§unseen-lever): the null narrator's answer to the arrival card's `policyDecision` hook
   * also marks the side adopting a plan of this posture as the way in unseen, a `markUnseen` sent
   * as the narrator's other commands are (it must be on the card). Absent, nothing is marked.
   */
  readonly markUnseen?: Posture;
  /**
   * Play on this world (made by `createEpisodeWorld` with the same kernel) rather than a new one:
   * a second errand after the first, the ship where the first left her. Absent, a new world.
   */
  readonly world?: World;
  /**
   * Called after each advance (and its answers) with the world and a command sender: a seam for
   * experiments, e.g. standing in for a system that is not there yet. The episode itself needs none.
   */
  readonly afterStep?: (
    world: World,
    send: (command: Omit<Command, "id">) => EnqueueResult,
  ) => void;
  /**
   * The ticks the next advance runs, asked before each one; absent, half a sim second. A test that
   * must see every tick of a stretch (`afterStep` and the invariants run after every advance), say
   * the party stepping onto the site floor, returns 1 there.
   */
  readonly ticksPerAdvance?: (world: World) => number;
}

/** The turn card's two answers (`EpisodeOptions.turnCard`). */
export type TurnCardAnswer = "pressOn" | "pullBack";

/** The episode's beats, in the order they must come (`EpisodeResult.milestones`). */
export const EPISODE_MILESTONES = [
  "offered",
  "accepted",
  "leftHome",
  "waypoint",
  "landed",
  "expeditionStarted",
  "arrivalCard",
  "contact",
  "resolved",
  "liftedOff",
  "home",
  "closed",
] as const;
export type EpisodeMilestone = (typeof EPISODE_MILESTONES)[number];

/** How the episode ended. `stopped`: it stalled or hit the cap before the job was closed. */
export type EpisodeEnding = "paid" | "failed" | "stopped" | "lost";

/** One line of the readable transcript, at a sim time. */
export interface TranscriptLine {
  readonly tick: number;
  readonly seconds: number;
  /** `ticker`: a notable-or-better event's ticker line; `card`/`choice`: a card and its answer. */
  readonly kind: "ticker" | "card" | "choice";
  readonly text: string;
  /** The event type, for a ticker line. */
  readonly eventType?: SimEvent["type"];
  /** The ticker line is one of the episode's own (`EPISODE_EVENT_TYPES`), not ship life. */
  readonly episode: boolean;
}

/** A card that came up and how the policy answered it. */
export interface EpisodeCard {
  readonly decisionId: DecisionId;
  readonly key: string;
  readonly tick: number;
  readonly title: string;
  readonly situation: string;
  readonly side: "left" | "right";
  readonly chosen: string;
  /** The plan the chosen side adopts (`adoptPlan`), for the arrival card. */
  readonly chosenPlanId?: string;
  /** The chosen side calls the party back (`withdrawParty`), for the turn card. */
  readonly chosenWithdraws: boolean;
  /** The null narrator wrote the card's prose (a policy card's `policyDecision` hook). */
  readonly narrated: boolean;
}

export interface EpisodeResult {
  readonly seed: number;
  readonly startPortId: PortDefId;
  readonly siteId: PortDefId;
  readonly nearPortId: PortDefId;
  readonly jobId: JobId | undefined;
  readonly pay: number;
  readonly ending: EpisodeEnding;
  /** Every milestone reached, in the order reached, with its tick. */
  readonly milestones: readonly { readonly name: EpisodeMilestone; readonly tick: number }[];
  /** Why the run stopped short, when `ending` is `stopped`: the last milestone and the stall. */
  readonly stoppedBecause?: string;
  /** The episode's own events (`EPISODE_EVENT_TYPES`), in order. */
  readonly events: readonly SimEvent[];
  readonly transcript: readonly TranscriptLine[];
  readonly cards: readonly EpisodeCard[];
  readonly hooksByKind: Readonly<Partial<Record<NarratorHook["kind"], number>>>;
  /** Every hook, with where the ship was docked when it came (absent: under way). */
  readonly hooks: readonly {
    readonly kind: NarratorHook["kind"];
    readonly tick: number;
    readonly dockedAt?: PortDefId;
  }[];
  /** Every transaction of the run, in order (fees, the errand's pay). */
  readonly transactions: readonly {
    readonly tick: number;
    readonly amount: number;
    readonly reason: string;
    readonly jobId?: JobId;
  }[];
  /** The plan the expedition fought with, read when it resolved. */
  readonly planAdopted?: string;
  /** The arrival card's plan the narrator marked unseen (`EpisodeOptions.markUnseen`). */
  readonly unseenPlanId?: string;
  /** Commands the null narrator answered with that the kernel rejected (should be none). */
  readonly narratorRejections: readonly string[];
  readonly moneyStart: number;
  readonly moneyEnd: number;
  readonly jobStatus: string | undefined;
  readonly errandOutcome: string | undefined;
  readonly simSeconds: number;
  /** Ticks per sim second (`config.time.tickRate`), to read the milestones' ticks. */
  readonly tickRate: number;
  /** Invariant and travel violations, each with the tick it was first seen. */
  readonly violations: readonly string[];
  /** Notable-or-better ticker lines over the whole run, and those that are the episode's own. */
  readonly tickerLines: number;
  readonly episodeTickerLines: number;
}

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** Ticks per advance: half a sim second at 20 Hz. */
const ADVANCE_TICKS = 10;
/** Advances between yields (`yielding.ts`): 100 sim seconds. */
const ADVANCES_PER_CHUNK = 200;
/** No new milestone for this long and the run is declared stopped. */
const STALL_SECONDS = 900;
/** The default hard cap on sim time. */
const DEFAULT_MAX_SIM_SECONDS = 3 * 60 * 60;
/** Notable-or-better events kept for the next narrator call (the web host's cap). */
const RECENT_EVENTS_CAP = 60;

const ERRAND_ISSUER = { name: "Ysolde Maren", role: "grower", org: "Meridian Growers" } as const;
/** Whoever the site's own map puts at its target post (the errand names them so). */
function siteTarget(world: World, siteId: PortDefId): string {
  const site = Object.values(world.content.docks ?? {}).find((dock) => dock.portId === siteId);
  const target = site?.defaultCast?.find((entry) => entry.part === "target")?.name;
  if (target === undefined) throw new Error(`episode: ${siteId} has no target in its cast`);
  return target;
}

/** The event types that tell the episode itself (the rest of the ticker is ship life). */
export const EPISODE_EVENT_TYPES: ReadonlySet<SimEvent["type"]> = new Set<SimEvent["type"]>([
  "jobOffered",
  "jobAccepted",
  "jobDeclined",
  "jobFailed",
  "contractCompleted",
  "paymentMade",
  "passengerBoarded",
  "passengerAshore",
  "passageEnded",
  "departed",
  "arrived",
  "expeditionStarted",
  "partyMustered",
  "expeditionContact",
  "combatantBroke",
  "partyWithdrew",
  "expeditionResolved",
  "decisionResolved",
  "leftOnDock",
]);

// ---------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------

/** The authored site nearest `fromPortId` by the `"all"` graph's path, and its near port. */
export function nearestSite(
  world: World,
  fromPortId: PortDefId,
): { siteId: PortDefId; nearPortId: PortDefId; distance: number } {
  const graph = portGraph(world.content, world.state, "all");
  let best: { siteId: PortDefId; nearPortId: PortDefId; distance: number } | undefined;
  for (const id of Object.keys(world.content.ports) as PortDefId[]) {
    if (!isSite(world.content, id)) continue;
    const near = siteNearPort(world.content, id);
    const path = shortestPath(graph, fromPortId, id);
    if (near === undefined || path === undefined) continue;
    if (best === undefined || path.distance < best.distance) {
      best = { siteId: id, nearPortId: near, distance: path.distance };
    }
  }
  if (best === undefined) throw new Error(`no authored site is reachable from ${fromPortId}`);
  return best;
}

/** The round trip's distance by the `"all"` graph, as `checkErrandBand` measures it. */
function roundTripDistance(world: World, fromPortId: PortDefId, siteId: PortDefId): number {
  const graph = portGraph(world.content, world.state, "all");
  const out = shortestPath(graph, fromPortId, siteId);
  const back = shortestPath(graph, siteId, fromPortId);
  if (out === undefined || back === undefined) {
    throw new Error(`no route ${fromPortId} → ${siteId} and back`);
  }
  return out.distance + back.distance;
}

/**
 * The errand offered at tick 0: bring the site's target back alive, at the standard tier; or, with
 * `fetchItem`, fetch one of that item (named by its def's name, wanted either way).
 */
export function episodeErrand(
  world: World,
  fromPortId: PortDefId,
  siteId: PortDefId,
  fetchItem?: ItemDefId,
): JobDraft {
  const item = fetchItem === undefined ? undefined : world.content.items[fetchItem];
  if (fetchItem !== undefined && item === undefined) {
    throw new Error(`episode: no item "${fetchItem}" in content`);
  }
  const target = item?.name ?? siteTarget(world, siteId);
  const errand: NonNullable<JobDraft["errand"]> =
    item === undefined
      ? { kind: "fetchPerson", siteId, targetName: target, wants: "alive" }
      : { kind: "fetchItem", siteId, targetName: target, itemDefId: item.id, wants: "either" };
  return {
    issuer: ERRAND_ISSUER,
    pitch: {
      key: NARRATOR_TEXT_KEYS.jobPitch,
      params: {},
      prose:
        item === undefined
          ? `${target} took the Growers' seed money and went to ground. I want them back here to answer for it.`
          : `The Growers' ${target} was left out there when the co-op fell apart. I want it back.`,
    },
    description: { key: "job.template", params: {} },
    urgency: "soon",
    fromPortId,
    toPortId: fromPortId,
    cargo: [],
    pay: errandPay(world.config.values, roundTripDistance(world, fromPortId, siteId), "standard")
      .pay,
    errand,
  };
}

// ---------------------------------------------------------------------------------------------
// The decision policy
// ---------------------------------------------------------------------------------------------

type Side = "left" | "right";
const SIDES: readonly Side[] = ["left", "right"];
type SideCommand = DeepReadonly<Decision>["left"]["commands"][number];

/** The first side with a command passing `test` (`want` true) or with none (`want` false). */
function sideWith(
  decision: DeepReadonly<Decision>,
  test: (command: SideCommand) => boolean,
  want = true,
): Side | undefined {
  return SIDES.find((side) => decision[side].commands.some(test) === want);
}

/** The plan a side's command adopts, if it is an `adoptPlan`. */
function adoptedPlan(c: SideCommand): string | undefined {
  return c.kind === "adoptPlan" ? String((c.payload as { planId?: unknown }).planId) : undefined;
}

/** Whether `c` adopts a plan of `posture` (plan ids read `<posture>-<fire>-<squad>`). */
const adopts =
  (posture: Posture) =>
  (c: SideCommand): boolean =>
    adoptedPlan(c)?.startsWith(`${posture}-`) === true;

/** The arrival card's side adopting a plan of `posture`; the card having none is a harness error. */
function arrivalSideOf(decision: DeepReadonly<Decision>, posture: Posture): Side {
  const side = sideWith(decision, adopts(posture));
  if (side === undefined) {
    throw new Error(`episode: the arrival card has no "${posture}" side`);
  }
  return side;
}

/**
 * How the episode answers a card: take the errand's offer (its `acceptContract` side) and pass any
 * other; on the arrival card the side adopting a plan of `arrivalCard`'s posture, or absent the
 * side adopting a `hold-` plan, else the left; on the turn card "Press on" (the side with no
 * `withdrawParty`), or with `turnCard` `pullBack` the side with it; anything else its left side,
 * as `crew beats` does.
 */
export function episodeChoice(
  decision: DeepReadonly<Decision>,
  errandJobId: JobId | undefined,
  turnCard: TurnCardAnswer = "pressOn",
  arrivalCard?: Posture,
): Side {
  const accepts = (c: SideCommand) => c.kind === "acceptContract";
  switch (decision.prompt.key) {
    case "job.offer": {
      const ours = decision.jobId !== undefined && decision.jobId === errandJobId;
      return sideWith(decision, accepts, ours) ?? "left";
    }
    case "expedition.arrival":
      return arrivalCard === undefined
        ? (sideWith(decision, adopts("hold")) ?? "left")
        : arrivalSideOf(decision, arrivalCard);
    case "expedition.turn":
      return (
        sideWith(decision, (c) => c.kind === "withdrawParty", turnCard === "pullBack") ?? "left"
      );
    default:
      return "left";
  }
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

/** A new world for an episode: the pacing content's scenario at `seed`. */
export function createEpisodeWorld(kernel: Kernel, seed: number): World {
  const { bundle, config, scenarioId } = loadPacingContent();
  return kernel.createWorld(scenarioId, seed, bundle, config);
}

/** One errand, end to end. Deterministic per seed. */
export function runEpisode(options: EpisodeOptions, kernel?: Kernel): EpisodeResult {
  return drain(episodeRun(options, kernel));
}

/** `runEpisode`, letting the event loop run between chunks (for tests; see `yielding.ts`). */
export function runEpisodeAsync(options: EpisodeOptions, kernel?: Kernel): Promise<EpisodeResult> {
  return drainAsync(episodeRun(options, kernel));
}

/** Tracks which milestones have come, from the events of each advance. */
class Milestones {
  readonly reached: { name: EpisodeMilestone; tick: number }[] = [];
  private readonly seen = new Set<EpisodeMilestone>();
  lastTick = 0;

  constructor(
    private readonly startPortId: PortDefId,
    private readonly siteId: PortDefId,
    private readonly nearPortId: PortDefId,
    startTick: number,
  ) {
    this.lastTick = startTick;
  }

  has(name: EpisodeMilestone): boolean {
    return this.seen.has(name);
  }

  get last(): EpisodeMilestone | undefined {
    return this.reached.at(-1)?.name;
  }

  private mark(name: EpisodeMilestone, tick: number): void {
    if (this.seen.has(name)) return;
    this.seen.add(name);
    this.reached.push({ name, tick });
    this.lastTick = tick;
  }

  /** Marks what `event` reaches, for the errand `jobId`. */
  event(event: SimEvent, jobId: JobId | undefined, decisionKey: (id: DecisionId) => string): void {
    const p = event.payload as Record<string, unknown>;
    const ours = jobId !== undefined && p.jobId === jobId;
    const at = event.tick;
    switch (event.type) {
      case "jobOffered":
        if (ours) this.mark("offered", at);
        return;
      case "jobAccepted":
        if (ours) this.mark("accepted", at);
        return;
      case "departed":
        if (p.fromPortId === this.startPortId && this.has("accepted")) this.mark("leftHome", at);
        if (p.fromPortId === this.siteId && this.has("landed")) this.mark("liftedOff", at);
        return;
      case "arrived":
        if (p.portId === this.nearPortId && this.has("leftHome") && !this.has("landed")) {
          this.mark("waypoint", at);
        }
        if (p.portId === this.siteId && this.has("leftHome")) this.mark("landed", at);
        if (p.portId === this.startPortId && this.has("liftedOff")) this.mark("home", at);
        return;
      case "expeditionStarted":
        if (p.siteId === this.siteId) this.mark("expeditionStarted", at);
        return;
      case "decisionResolved":
        if (decisionKey(p.decisionId as DecisionId) === "expedition.arrival") {
          this.mark("arrivalCard", at);
        }
        return;
      case "expeditionContact":
        this.mark("contact", at);
        return;
      case "expeditionResolved":
        this.mark("resolved", at);
        return;
      case "contractCompleted":
      case "jobFailed":
        if (ours) this.mark("closed", at);
        return;
      default:
        return;
    }
  }
}

/** Where to send the ship: the option's site, or the authored site nearest the start port. */
function siteFor(
  world: World,
  startPortId: PortDefId,
  siteId: PortDefId | undefined,
): { siteId: PortDefId; nearPortId: PortDefId } {
  if (siteId === undefined) return nearestSite(world, startPortId);
  const nearPortId = siteNearPort(world.content, siteId);
  if (nearPortId === undefined) throw new Error(`${siteId} is not a landing site`);
  return { siteId, nearPortId };
}

type Send = (command: Omit<Command, "id">) => EnqueueResult;

/** One episode's state: the world, what it has seen so far, and the answers it gave. */
class EpisodeRun {
  readonly world: World;
  readonly startPortId: PortDefId;
  readonly siteId: PortDefId;
  readonly nearPortId: PortDefId;
  readonly draft: JobDraft;
  readonly moneyStart: number;
  /** The world's tick when the run began (0 for a new world). */
  readonly startTick: number;
  readonly milestones: Milestones;
  jobId: JobId | undefined;
  planAdopted: string | undefined;
  unseenPlanId: string | undefined;
  readonly events: SimEvent[] = [];
  readonly transcript: TranscriptLine[] = [];
  readonly cards: EpisodeCard[] = [];
  readonly hooks: { kind: NarratorHook["kind"]; tick: number; dockedAt?: PortDefId }[] = [];
  readonly narratorRejections: string[] = [];
  readonly violations: string[] = [];
  private readonly seenViolations = new Set<string>();
  private readonly prose = new Map<DecisionId, DecisionCardText>();
  private recentEvents: SimEvent[] = [];
  private commandCount = 0;
  private narratorCalls = 0;

  constructor(
    readonly kernel: Kernel,
    private readonly options: EpisodeOptions,
  ) {
    this.world = options.world ?? createEpisodeWorld(kernel, options.seed);
    this.startTick = this.world.state.tick;
    const travel = this.world.state.travel;
    if (travel.stage !== "docked") throw new Error("the default scenario must start docked");
    this.startPortId = travel.portId;
    const site = siteFor(this.world, this.startPortId, options.siteId);
    this.siteId = site.siteId;
    this.nearPortId = site.nearPortId;
    this.milestones = new Milestones(
      this.startPortId,
      this.siteId,
      this.nearPortId,
      this.startTick,
    );
    this.moneyStart = this.world.state.money.balance;
    this.draft = episodeErrand(this.world, this.startPortId, this.siteId, options.fetchItem);
    this.sendOrThrow({
      source: "scenario",
      kind: "offerJob",
      payload: { job: this.draft, surface: true },
    });
  }

  seconds(tick: number): number {
    return tick / this.world.config.values.time.tickRate;
  }

  readonly send: Send = (command) => {
    this.commandCount += 1;
    return this.kernel.enqueueCommand(this.world, {
      ...command,
      // A run on a world an earlier run played names its commands apart from that run's.
      id: `cmd:episode:${this.startTick === 0 ? "" : `${this.startTick}:`}${this.commandCount}` as CommandId,
    } as Command);
  };

  private sendOrThrow(command: Omit<Command, "id">): void {
    const result = this.send(command);
    if (result.status !== "accepted") {
      throw new Error(`${command.kind} rejected: ${JSON.stringify(result)}`);
    }
  }

  /** The milestones, the episode's events and the ticker from one advance's events. */
  read(events: readonly SimEvent[]): void {
    for (const event of events) {
      if (event.type === "jobOffered" && this.jobId === undefined) {
        const offered = this.world.state.jobs[(event.payload as { jobId: JobId }).jobId];
        if (offered?.errand?.siteId === this.siteId) this.jobId = offered.id;
      }
      if (event.type === "expeditionResolved") {
        this.planAdopted = this.world.state.expedition?.plan?.id;
      }
      this.milestones.event(event, this.jobId, (id) => this.decisionKey(id));
      const episode = EPISODE_EVENT_TYPES.has(event.type);
      if (episode) this.events.push(event);
      if (event.significance !== "trace") this.recentEvents.push(event);
      // The ticker decides what it shows (a few trace events, like the party going down the ramp,
      // have lines), as the web's log does.
      const text = tickerLine(event, this.world.state, this.world.content);
      if (text === null) continue;
      const at = { tick: event.tick, seconds: this.seconds(event.tick) };
      this.transcript.push({ ...at, kind: "ticker", text, eventType: event.type, episode });
    }
    if (this.recentEvents.length > RECENT_EVENTS_CAP) {
      this.recentEvents = this.recentEvents.slice(-RECENT_EVENTS_CAP);
    }
  }

  private decisionKey(id: DecisionId): string {
    return this.world.state.decisions.records[id]?.prompt.key ?? "";
  }

  /** Invariants and travel's own, each violation recorded once with when it was first seen. */
  checkHealth(): void {
    const { state } = this.world;
    for (const text of [...checkInvariants(state), ...travelViolations(this.world)]) {
      if (this.seenViolations.has(text)) continue;
      this.seenViolations.add(text);
      this.violations.push(`t=${this.seconds(state.tick).toFixed(1)}s ${text}`);
    }
  }

  /** The null narrator answers the pending hook: its commands, then the acknowledgement. */
  answerHook(): void {
    const { world } = this;
    const hook = world.state.narrator.pendingHook;
    if (hook === undefined) throw new Error("hook halt without a pending hook");
    const travel = world.state.travel;
    this.hooks.push({
      kind: hook.kind,
      tick: world.state.tick,
      ...(travel.stage === "docked" ? { dockedAt: travel.portId } : {}),
    });
    this.narratorCalls += 1;
    const response = nullNarratorResponse(
      {
        gameId: "episode",
        hook,
        snapshot: this.kernel.serialize(world),
        recentEvents: this.recentEvents,
      },
      { content: world.content, callId: `episode-${this.narratorCalls}` },
    );
    if (response.model !== NULL_NARRATOR_MODEL) throw new Error("not the null narrator");
    if (response.card !== undefined) {
      this.prose.set(response.card.decisionId as DecisionId, response.card);
    }
    const unseen = this.unseenMark(hook, response.callId, response.commands.length);
    for (const command of [...response.commands, ...(unseen === undefined ? [] : [unseen])]) {
      // The hook's tick has passed in the halted world; the command applies at the next one.
      const { targetTick: _hookTick, ...rest } = command as Command & { targetTick?: number };
      const answer = this.kernel.enqueueCommand(world, rest as Command);
      if (answer.status !== "accepted") {
        this.narratorRejections.push(`${command.kind}: ${JSON.stringify(answer)}`);
      }
    }
    this.recentEvents = [];
    this.sendOrThrow({ source: "system", kind: "acknowledgeHook", payload: { hookId: hook.id } });
  }

  /**
   * D105: with `markUnseen`, the narrator's mark on the arrival card's side of that posture, for
   * the card's `policyDecision` hook; nothing for any other hook or without the option.
   */
  private unseenMark(hook: NarratorHook, callId: string, n: number): Command | undefined {
    const posture = this.options.markUnseen;
    if (posture === undefined || hook.kind !== "policyDecision") return undefined;
    const decisionId = hook.context.decisionId as DecisionId;
    const decision = this.world.state.decisions.records[decisionId];
    if (decision?.prompt.key !== "expedition.arrival") return undefined;
    const side = arrivalSideOf(decision, posture);
    const planId = decision[side].commands.map(adoptedPlan).find((id) => id !== undefined);
    if (planId === undefined) throw new Error(`episode: the arrival card's ${side} adopts no plan`);
    this.unseenPlanId = planId;
    return {
      id: commandIdFor(callId, n),
      source: "narrator",
      kind: "markUnseen",
      payload: { decisionId, planId },
    };
  }

  /** `episodeChoice` answers the card at the head of the queue; the card goes in the transcript. */
  answerDecision(): void {
    const { world } = this;
    const head = world.state.decisions.queue[0];
    const decision = head === undefined ? undefined : world.state.decisions.records[head];
    if (head === undefined || decision === undefined) {
      throw new Error("decision halt without a queued decision");
    }
    const side = episodeChoice(
      decision,
      this.jobId,
      this.options.turnCard,
      this.options.arrivalCard,
    );
    const narrated = this.prose.get(head);
    const card = narrated ?? templateCard(decision, world.content);
    const commands = decision[side].commands;
    const adopt = commands.find((c) => c.kind === "adoptPlan")?.payload as
      | { readonly planId: string }
      | undefined;
    const chosen = side === "left" ? card.leftLabel : card.rightLabel;
    const at = { tick: world.state.tick, seconds: this.seconds(world.state.tick), episode: true };
    this.cards.push({
      decisionId: head,
      key: decision.prompt.key,
      tick: at.tick,
      title: card.title,
      situation: card.situation,
      side,
      chosen,
      ...(adopt === undefined ? {} : { chosenPlanId: adopt.planId }),
      chosenWithdraws: commands.some((c) => c.kind === "withdrawParty"),
      narrated: narrated !== undefined,
    });
    this.transcript.push({ ...at, kind: "card", text: `${card.title} — ${card.situation}` });
    this.transcript.push({ ...at, kind: "choice", text: `→ ${chosen}` });
    this.sendOrThrow({
      source: "player",
      kind: "resolveDecision",
      payload: { decisionId: head, side },
    });
  }

  /** Paid or failed with the ship docked at home after the voyage back; else still going. */
  closedAtHome(): "paid" | "failed" | undefined {
    const job = this.jobId === undefined ? undefined : this.world.state.jobs[this.jobId];
    const travel = this.world.state.travel;
    const home =
      travel.stage === "docked" &&
      travel.portId === this.startPortId &&
      travel.voyageDestinationId === undefined &&
      this.milestones.has("home");
    if (!home || job === undefined) return undefined;
    if (job.status === "paid") return "paid";
    return job.status === "failed" ? "failed" : undefined;
  }

  /** Why the run gives up now (a stall or the cap), or undefined while it may still progress. */
  stopReason(maxTicks: number): string | undefined {
    const { state } = this.world;
    const tickRate = this.world.config.values.time.tickRate;
    const stalled = state.tick - this.milestones.lastTick > STALL_SECONDS * tickRate;
    if (!stalled && state.tick < maxTicks) return undefined;
    const travel = state.travel;
    const where = travel.stage === "docked" ? `docked at ${travel.portId}` : travel.stage;
    const job = this.jobId === undefined ? undefined : state.jobs[this.jobId];
    const why = stalled ? `no progress for ${STALL_SECONDS} s` : "the sim-time cap";
    return `${why} after "${this.milestones.last ?? "nothing"}" (${where}, job ${job?.status ?? "none"})`;
  }

  result(seed: number, ending: EpisodeEnding, stoppedBecause?: string): EpisodeResult {
    const { state } = this.world;
    const job = this.jobId === undefined ? undefined : state.jobs[this.jobId];
    const ticker = this.transcript.filter((l) => l.kind === "ticker");
    const hooksByKind: Partial<Record<NarratorHook["kind"], number>> = {};
    for (const hook of this.hooks) hooksByKind[hook.kind] = (hooksByKind[hook.kind] ?? 0) + 1;
    const transactions = Object.values(state.money.transactions)
      .map((t) => ({
        tick: t.tick,
        amount: t.amount,
        reason: t.reason,
        ...(t.jobId === undefined ? {} : { jobId: t.jobId }),
      }))
      .sort((a, b) => a.tick - b.tick);
    return {
      seed,
      startPortId: this.startPortId,
      siteId: this.siteId,
      nearPortId: this.nearPortId,
      jobId: this.jobId,
      pay: this.draft.pay,
      ending,
      milestones: this.milestones.reached,
      ...(stoppedBecause === undefined ? {} : { stoppedBecause }),
      events: this.events,
      transcript: this.transcript,
      cards: this.cards,
      hooksByKind,
      hooks: this.hooks,
      transactions,
      ...(this.planAdopted === undefined ? {} : { planAdopted: this.planAdopted }),
      ...(this.unseenPlanId === undefined ? {} : { unseenPlanId: this.unseenPlanId }),
      narratorRejections: this.narratorRejections,
      moneyStart: this.moneyStart,
      moneyEnd: state.money.balance,
      jobStatus: job?.status,
      errandOutcome: job?.errand?.outcome,
      simSeconds: this.seconds(state.tick),
      tickRate: this.world.config.values.time.tickRate,
      violations: this.violations,
      tickerLines: ticker.length,
      episodeTickerLines: ticker.filter((l) => l.episode).length,
    };
  }
}

function* episodeRun(options: EpisodeOptions, kernel?: Kernel): ChunkedRun<EpisodeResult> {
  const run = new EpisodeRun(kernel ?? createKernel(createPacingRegistry()), options);
  const { world } = run;
  const tickRate = world.config.values.time.tickRate;
  const maxTicks = run.startTick + (options.maxSimSeconds ?? DEFAULT_MAX_SIM_SECONDS) * tickRate;
  let stuckAdvances = 0;
  for (let advances = 1; ; advances += 1) {
    if (advances % ADVANCES_PER_CHUNK === 0) yield;
    const before = world.state.tick;
    const ticks = options.ticksPerAdvance?.(world) ?? ADVANCE_TICKS;
    if (!Number.isInteger(ticks) || ticks < 1) {
      throw new Error(`episode: ticksPerAdvance gave ${ticks}, not a whole number of ticks`);
    }
    const step = run.kernel.advance(world, ticks);
    run.read(step.events);
    // Every step: invariants are what catch a cast member dragged aboard at lift-off and its kin.
    run.checkHealth();
    if (step.halt.kind === "lost") return run.result(options.seed, "lost");
    if (step.halt.kind === "hook") run.answerHook();
    if (step.halt.kind === "decision") run.answerDecision();
    const idle = world.state.tick === before && step.halt.kind === "completed";
    stuckAdvances = idle ? stuckAdvances + 1 : 0;
    if (stuckAdvances > 3) throw new Error(`episode stuck at tick ${world.state.tick}`);
    options.afterStep?.(world, run.send);
    const closed = run.closedAtHome();
    if (closed !== undefined) return run.result(options.seed, closed);
    const stop = run.stopReason(maxTicks);
    if (stop !== undefined) return run.result(options.seed, "stopped", stop);
  }
}

// ---------------------------------------------------------------------------------------------
// The transcript
// ---------------------------------------------------------------------------------------------

/** "12:05" for 725 sim seconds. */
export function clockOf(seconds: number): string {
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  return `${String(minutes).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

export interface TranscriptFormat {
  /** Ship-life lines too (meals, bells, talk), not only the episode's own. */
  readonly all?: boolean;
}

/** The run in brief: how it ended, the money, the milestones with their times, the hooks. */
function transcriptHeader(r: EpisodeResult): string[] {
  const outcome = r.errandOutcome === undefined ? "" : ` (${r.errandOutcome})`;
  const stopped = r.stoppedBecause === undefined ? "" : ` — ${r.stoppedBecause}`;
  const milestones = r.milestones.map((m) => `${m.name} ${clockOf(m.tick / r.tickRate)}`);
  const hooks = Object.entries(r.hooksByKind).map(([kind, n]) => `${kind} ${n}`);
  return [
    `# Episode: seed ${r.seed}, ${r.startPortId} → ${r.siteId} (via ${r.nearPortId}) and home`,
    "",
    `Ending: ${r.ending}${stopped}. Job ${r.jobStatus ?? "never offered"}${outcome}. Sim time ${clockOf(r.simSeconds)}.`,
    `Money ${r.moneyStart} → ${r.moneyEnd} (offered pay ${r.pay}). Ticker: ${r.episodeTickerLines} episode lines of ${r.tickerLines}.`,
    `Milestones: ${milestones.join(", ") || "none"}.`,
    `Hooks: ${hooks.join(", ") || "none"}.`,
    ...(r.unseenPlanId === undefined ? [] : [`The narrator marked ${r.unseenPlanId} unseen.`]),
    ...(r.violations.length === 0 ? [] : [`Violations: ${r.violations.join("; ")}`]),
    ...(r.narratorRejections.length === 0
      ? []
      : [`Narrator commands rejected: ${r.narratorRejections.join("; ")}`]),
  ];
}

const LINE_MARKS: Readonly<Record<TranscriptLine["kind"], string>> = {
  ticker: " ",
  card: "▣",
  choice: " ",
};

/**
 * The episode as a reader would follow it: the header, then the ticker with sim times (`mm:ss`),
 * each card (▣) and the side taken (→). Ship-life lines (marked ·) only with `all`.
 */
export function formatEpisodeTranscript(r: EpisodeResult, format: TranscriptFormat = {}): string {
  const lines = r.transcript.flatMap((line) => {
    const shipLife = line.kind === "ticker" && !line.episode;
    if (shipLife && format.all !== true) return [];
    return [`${clockOf(line.seconds)} ${shipLife ? "·" : LINE_MARKS[line.kind]} ${line.text}`];
  });
  return [...transcriptHeader(r), "", ...lines].join("\n");
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const USAGE =
  "usage: crew episode [--seed N] [--site <port id>] [--item <item id>] [--arrival <posture>] " +
  "[--unseen <posture>] [--all]";

export interface EpisodeCliOptions extends EpisodeOptions {
  readonly all: boolean;
}

const isPosture = (value: string | undefined): value is Posture =>
  (POSTURES as readonly (string | undefined)[]).includes(value);

/** The flags that take a value. */
type ValueFlag = "--seed" | "--site" | "--item" | "--arrival" | "--unseen";
const VALUE_FLAGS: ReadonlySet<string> = new Set<ValueFlag>([
  "--seed",
  "--site",
  "--item",
  "--arrival",
  "--unseen",
]);

/** One flag's value read into the options, or why it is refused. */
function readFlag(
  flag: ValueFlag,
  value: string | undefined,
): Partial<EpisodeCliOptions> | { error: string } {
  switch (flag) {
    case "--seed": {
      const n = Number(value);
      if (value === undefined || !Number.isInteger(n)) {
        return { error: `--seed needs an integer. ${USAGE}` };
      }
      return { seed: n };
    }
    case "--site":
      return value === undefined
        ? { error: `--site needs a port id. ${USAGE}` }
        : { siteId: value as PortDefId };
    case "--item":
      return value === undefined
        ? { error: `--item needs an item id. ${USAGE}` }
        : { fetchItem: value as ItemDefId };
    case "--arrival":
    case "--unseen": {
      if (!isPosture(value)) {
        return { error: `${flag} needs a posture (${POSTURES.join(", ")}). ${USAGE}` };
      }
      return flag === "--arrival" ? { arrivalCard: value } : { markUnseen: value };
    }
  }
}

export function parseEpisodeArgs(args: readonly string[]): EpisodeCliOptions | { error: string } {
  let options: EpisodeCliOptions = { seed: 1, all: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--all") {
      options = { ...options, all: true };
    } else if (arg !== undefined && VALUE_FLAGS.has(arg)) {
      const read = readFlag(arg as ValueFlag, args[i + 1]);
      if ("error" in read) return read;
      options = { ...options, ...read };
      i += 1;
    } else {
      return { error: `unknown argument "${arg}". ${USAGE}` };
    }
  }
  return options;
}

export function runEpisodeCli(args: readonly string[]): { output: string; exitCode: 0 | 1 } {
  const parsed = parseEpisodeArgs(args);
  if ("error" in parsed) return { output: `crew episode: ${parsed.error}`, exitCode: 1 };
  const { bundle } = loadPacingContent();
  if (parsed.siteId !== undefined && !isSite(bundle, parsed.siteId)) {
    return {
      output: `crew episode: "${parsed.siteId}" is not a landing site. ${USAGE}`,
      exitCode: 1,
    };
  }
  if (parsed.fetchItem !== undefined && bundle.items[parsed.fetchItem] === undefined) {
    return { output: `crew episode: no item "${parsed.fetchItem}". ${USAGE}`, exitCode: 1 };
  }
  const result = runEpisode(parsed);
  const ok =
    (result.ending === "paid" || result.ending === "failed") && result.violations.length === 0;
  return { output: formatEpisodeTranscript(result, { all: parsed.all }), exitCode: ok ? 0 : 1 };
}
