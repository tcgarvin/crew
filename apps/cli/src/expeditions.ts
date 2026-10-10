/**
 * `crew expeditions` (expeditions A1, plan "The `crew expeditions` instrument"): the tuning
 * instrument for the fight. For each plan, cast and seed it starts the default game, sets the ship
 * down at the site at tick 0 with `scenarioStartExpedition { siteId, cast, plan }`, advances until
 * `expeditionResolved` (or the instrument gives up, `GIVE_UP_AFTER_SECONDS` in), and records the
 * fight. The run never calls the narrator and answers every card left, as `crew beats` does.
 *
 * Per plan and cast, over n × seeds fights: the outcome mix, seconds from contact to the end and
 * from the muster to contact, wounds per fight per side by severity, people down and dead per
 * side, how the fight ended (`broke`: every cast fighter still in it fled or gave up; `attrition`:
 * all down; `objective`: it ended with some still standing; `withdraw`; `timeout`), the cast's fled
 * and surrendered shares, shots and the hit rate per side, the share of the party who wavered and
 * who broke, and the ticker's notable-or-better lines per fight.
 *
 * The casts: `default` is the map's `defaultCast`; `shaky` makes every guard shaky and paid;
 * `hard` makes every guard hard and devoted and arms the unarmed or melee ones with blasters while
 * the armed cap (`SITE_LIMITS.armed`) allows.
 *
 * Seeded, so the same code and seed give the same fight (`sfc32`, no `Math.random`); the numbers
 * are sim seconds.
 */
import {
  type ActorId,
  type Command,
  type CommandId,
  type ContentBundle,
  DEFAULT_PLANS,
  EXPEDITION_OUTCOMES,
  type EffectiveConfig,
  type ExpeditionOutcome,
  type Kernel,
  type PlanId,
  type PlanOption,
  type PortDefId,
  SITE_LIMITS,
  type ScenarioDefId,
  type SimEvent,
  type SiteCastEntryDef,
  WOUND_SEVERITIES,
  type World,
  type WoundSeverity,
  createKernel,
  planMenu,
  tickerLine,
} from "@crew/sim";
import { createPacingRegistry, loadPacingContent } from "./pacing";
import { type ChunkedRun, drain, drainAsync } from "./yielding";

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

export const CAST_VARIANTS = ["default", "shaky", "hard"] as const;
export type CastVariant = (typeof CAST_VARIANTS)[number];

export interface ExpeditionsOptions {
  readonly siteId: PortDefId;
  /** Plan ids, or `all`: the menu's default pair, every posture lethal and armed, assault stun. */
  readonly plans: "all" | readonly PlanId[];
  readonly casts: readonly CastVariant[];
  /** Fights per seed. */
  readonly n: number;
  readonly seeds: readonly number[];
}

const DEFAULT_SITE = "port.boathouse" as PortDefId;

/**
 * How long after the start the instrument stops waiting for `expeditionResolved` and records the
 * fight as cut off: past the muster and the walk, the approach's own timeout and
 * `maxFightSeconds`, so only a fight the sim never ends reaches it.
 */
export const GIVE_UP_AFTER_SECONDS = 360;

/** Ticks per advance: half a second at 20 Hz, so a waver shorter than that may go unseen. */
const ADVANCE_TICKS = 10;

/** Advances between yields (`yielding.ts`): 30 sim seconds. */
const ADVANCES_PER_CHUNK = 60;

/** World seeds per instrument seed: fight `i` of seed `s` runs on world seed `s × this + i`. */
const SEED_STRIDE = 10_000;

// ---------------------------------------------------------------------------------------------
// Casts and plans
// ---------------------------------------------------------------------------------------------

/** The site's default cast under a variant (see the module comment). */
export function castFor(
  defaultCast: readonly SiteCastEntryDef[],
  variant: CastVariant,
): SiteCastEntryDef[] {
  switch (variant) {
    case "default":
      return [...defaultCast];
    case "shaky":
      return defaultCast.map((e) =>
        e.part === "guard" ? { ...e, resolve: "shaky", tie: "paid" } : e,
      );
    case "hard": {
      let armed = defaultCast.filter((e) => e.arms !== "none").length;
      return defaultCast.map((e) => {
        if (e.part !== "guard") return e;
        const rearm = e.arms !== "blaster" && (e.arms !== "none" || armed < SITE_LIMITS.armed);
        if (rearm && e.arms === "none") armed += 1;
        return {
          ...e,
          resolve: "hard",
          tie: "devoted",
          arms: rearm ? "blaster" : e.arms,
        };
      });
    }
  }
}

/** The plans `all` stands for, from the menu at the site: in the menu's order. */
export function instrumentPlans(menu: readonly PlanOption[]): PlanId[] {
  const pair = new Set(DEFAULT_PLANS.map((p) => p.id));
  const wanted = (o: PlanOption): boolean =>
    pair.has(o.id) ||
    (o.plan.squad === "armedOnly" &&
      (o.plan.fire === "lethal" || (o.plan.fire === "stun" && o.plan.posture === "assault")));
  return menu.filter((o) => o.available && wanted(o)).map((o) => o.id);
}

/** The caller asked for something the site cannot give: an unknown site or an unoffered plan. */
export class ExpeditionsRequestError extends Error {
  override readonly name = "ExpeditionsRequestError";
}

// ---------------------------------------------------------------------------------------------
// One fight
// ---------------------------------------------------------------------------------------------

export type FightEnding = "broke" | "attrition" | "objective" | "withdraw" | "timeout";

type PerSide<T> = { us: T; them: T };

/** One fight as the instrument saw it. Seconds are `null` when the moment never came. */
export interface FightRecord {
  readonly plan: PlanId;
  readonly cast: CastVariant;
  readonly seed: number;
  readonly worldSeed: number;
  /** The sim's outcome, or `cutOff` when the instrument gave up first. */
  readonly outcome: ExpeditionOutcome | "cutOff";
  readonly ending: FightEnding;
  readonly musterToContactSeconds: number | null;
  readonly contactToEndSeconds: number | null;
  readonly party: number;
  /** The cast who fight (target and guards; bystanders and allies apart). */
  readonly castFighters: number;
  readonly wounds: PerSide<Record<WoundSeverity, number>>;
  readonly bystandersWounded: number;
  readonly down: PerSide<number>;
  readonly dead: PerSide<number>;
  readonly castFled: number;
  readonly castSurrendered: number;
  readonly shots: PerSide<number>;
  readonly hits: PerSide<number>;
  readonly partyWavered: number;
  readonly partyBroke: number;
  readonly tickerLines: number;
}

function zeroSeverities(): Record<WoundSeverity, number> {
  return Object.fromEntries(WOUND_SEVERITIES.map((s) => [s, 0])) as Record<WoundSeverity, number>;
}

/** What the fight's events and samples add up to while it runs. */
class FightTally {
  readonly wounds: PerSide<Record<WoundSeverity, number>> = {
    us: zeroSeverities(),
    them: zeroSeverities(),
  };
  bystandersWounded = 0;
  readonly down: PerSide<Set<ActorId>> = { us: new Set(), them: new Set() };
  readonly dead: PerSide<Set<ActorId>> = { us: new Set(), them: new Set() };
  readonly fled = new Set<ActorId>();
  readonly surrendered = new Set<ActorId>();
  readonly shots: PerSide<number> = { us: 0, them: 0 };
  readonly hits: PerSide<number> = { us: 0, them: 0 };
  readonly wavered = new Set<ActorId>();
  readonly brokeUs = new Set<ActorId>();
  musteredTick: number | null = null;
  contactTick: number | null = null;
  resolved: { tick: number; outcome: ExpeditionOutcome } | null = null;
  tickerLines = 0;

  constructor(
    private readonly party: ReadonlySet<ActorId>,
    private readonly bystanders: ReadonlySet<ActorId>,
  ) {}

  private sideOf(id: ActorId): "us" | "them" {
    return this.party.has(id) ? "us" : "them";
  }

  events(events: readonly SimEvent[], world: World): void {
    for (const event of events) {
      if (
        event.significance !== "trace" &&
        tickerLine(event, world.state, world.content) !== null
      ) {
        this.tickerLines += 1;
      }
      switch (event.type) {
        case "partyMustered":
          this.musteredTick ??= event.tick;
          break;
        case "expeditionContact":
          this.contactTick ??= event.tick;
          break;
        case "expeditionResolved":
          this.resolved ??= { tick: event.tick, outcome: event.payload.outcome };
          break;
        case "wounded": {
          const id = event.payload.actorId;
          if (this.bystanders.has(id)) this.bystandersWounded += 1;
          else this.wounds[this.sideOf(id)][event.payload.severity] += 1;
          break;
        }
        case "incapacitated":
          this.down[this.sideOf(event.payload.actorId)].add(event.payload.actorId);
          break;
        case "died":
          this.dead[this.sideOf(event.payload.actorId)].add(event.payload.actorId);
          break;
        case "shotFired": {
          const side = this.sideOf(event.payload.byActorId);
          this.shots[side] += 1;
          if (event.payload.hit) this.hits[side] += 1;
          break;
        }
        case "combatantBroke": {
          const id = event.payload.actorId;
          if (event.payload.side === "us") this.brokeUs.add(id);
          else if (event.payload.how === "fled") this.fled.add(id);
          else this.surrendered.add(id);
          break;
        }
        default:
          break;
      }
    }
  }

  /** Who in the party is wavering now (no event marks a waver, so it is sampled). */
  sample(world: World): void {
    for (const id of this.party) {
      if (world.state.actors[id]?.combatant?.state === "wavering") this.wavered.add(id);
    }
  }
}

/** How the fight ended, from the outcome and what became of the cast who fight. */
function endingOf(
  outcome: ExpeditionOutcome | "cutOff",
  castFighters: readonly ActorId[],
  tally: FightTally,
): FightEnding {
  if (outcome === "timedOut" || outcome === "cutOff") return "timeout";
  if (outcome === "partyWithdrew" || outcome === "partyRouted") return "withdraw";
  const broke = (id: ActorId) => tally.fled.has(id) || tally.surrendered.has(id);
  const fell = (id: ActorId) => tally.down.them.has(id) || tally.dead.them.has(id);
  if (castFighters.length > 0 && castFighters.every((id) => broke(id) || fell(id))) {
    return castFighters.some(broke) ? "broke" : "attrition";
  }
  return "objective";
}

interface FightSpec {
  readonly siteId: PortDefId;
  readonly plan: PlanId;
  readonly cast: CastVariant;
  readonly castEntries: readonly SiteCastEntryDef[];
  readonly seed: number;
  readonly worldSeed: number;
}

interface FightContext {
  readonly kernel: Kernel;
  readonly bundle: ContentBundle;
  readonly config: EffectiveConfig;
  readonly scenarioId: ScenarioDefId;
}

/** Sends a command the run cannot go on without; a refusal is a bug in the instrument or sim. */
function sender(kernel: Kernel, world: World, label: string): (c: Omit<Command, "id">) => void {
  let count = 0;
  return (command) => {
    count += 1;
    const result = kernel.enqueueCommand(world, {
      ...command,
      id: `cmd:expeditions:${label}:${count}` as CommandId,
    } as Command);
    if (result.status !== "accepted") {
      throw new Error(`${command.kind} rejected: ${JSON.stringify(result)}`);
    }
  };
}

function* fightRun(ctx: FightContext, spec: FightSpec): ChunkedRun<FightRecord> {
  const { kernel } = ctx;
  const world = kernel.createWorld(ctx.scenarioId, spec.worldSeed, ctx.bundle, ctx.config);
  const send = sender(kernel, world, `${spec.plan}:${spec.worldSeed}`);
  send({
    source: "scenario",
    kind: "scenarioStartExpedition",
    payload: { siteId: spec.siteId, cast: spec.castEntries, plan: spec.plan },
  });
  const tickRate = world.config.values.time.tickRate;
  const first = kernel.advance(world, 1);
  const expedition = world.state.expedition;
  if (expedition === undefined) {
    throw new Error(`expedition to ${spec.siteId} did not start (plan ${spec.plan})`);
  }
  const startTick = expedition.startedTick;
  const party = new Set(expedition.party);
  const castOf = (pred: (part: SiteCastEntryDef["part"]) => boolean): ActorId[] =>
    Object.values(world.state.actors)
      .filter((a) => a.combatant?.side === "them" && pred(a.combatant.disposition.part))
      .map((a) => a.id);
  const bystanders = new Set(castOf((part) => part === "bystander"));
  const castFighters = castOf((part) => part === "target" || part === "guard");
  const tally = new FightTally(party, bystanders);
  tally.events(first.events, world);

  const giveUpTick = startTick + GIVE_UP_AFTER_SECONDS * tickRate;
  let advances = 0;
  while (tally.resolved === null && world.state.tick < giveUpTick) {
    advances += 1;
    if (advances % ADVANCES_PER_CHUNK === 0) yield;
    const result = kernel.advance(world, ADVANCE_TICKS);
    tally.events(result.events, world);
    tally.sample(world);
    if (result.halt.kind === "hook") {
      const hook = world.state.narrator.pendingHook;
      if (hook === undefined) throw new Error("hook halt without a pending hook");
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
      throw new Error(`the ship was lost during the expedition (seed ${spec.worldSeed})`);
    }
  }

  const outcome = tally.resolved?.outcome ?? "cutOff";
  const seconds = (from: number | null, to: number | null): number | null =>
    from === null || to === null ? null : (to - from) / tickRate;
  return {
    plan: spec.plan,
    cast: spec.cast,
    seed: spec.seed,
    worldSeed: spec.worldSeed,
    outcome,
    ending: endingOf(outcome, castFighters, tally),
    musterToContactSeconds: seconds(tally.musteredTick, tally.contactTick),
    contactToEndSeconds: seconds(tally.contactTick, tally.resolved?.tick ?? null),
    party: party.size,
    castFighters: castFighters.length,
    wounds: tally.wounds,
    bystandersWounded: tally.bystandersWounded,
    down: { us: tally.down.us.size, them: tally.down.them.size },
    dead: { us: tally.dead.us.size, them: tally.dead.them.size },
    castFled: tally.fled.size,
    castSurrendered: tally.surrendered.size,
    shots: tally.shots,
    hits: tally.hits,
    partyWavered: tally.wavered.size,
    partyBroke: tally.brokeUs.size,
    tickerLines: tally.tickerLines,
  };
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

/**
 * The plan menu at the site as the instrument's fights will see it: a fresh world, the expedition
 * started without a plan, one tick.
 */
function menuAtSite(ctx: FightContext, siteId: PortDefId): PlanOption[] {
  const world = ctx.kernel.createWorld(ctx.scenarioId, 1, ctx.bundle, ctx.config);
  sender(
    ctx.kernel,
    world,
    "menu",
  )({
    source: "scenario",
    kind: "scenarioStartExpedition",
    payload: { siteId },
  });
  ctx.kernel.advance(world, 1);
  return planMenu(world.state, ctx.bundle, ctx.config.values);
}

/** The plans to run: `all` resolved against the menu, or named ones checked against it. */
function plansToRun(options: ExpeditionsOptions, menu: readonly PlanOption[]): PlanId[] {
  if (options.plans === "all") return instrumentPlans(menu);
  const offered = menu.filter((o) => o.available).map((o) => o.id);
  for (const id of options.plans) {
    if (!offered.includes(id)) {
      throw new ExpeditionsRequestError(
        `plan "${id}" is not available at ${options.siteId} (menu: ${offered.join(", ")})`,
      );
    }
  }
  return [...options.plans];
}

function* expeditionsRun(options: ExpeditionsOptions, kernel?: Kernel): ChunkedRun<FightRecord[]> {
  if (!Number.isInteger(options.n) || options.n <= 0) {
    throw new RangeError(`crew expeditions: n must be a positive integer, got ${options.n}`);
  }
  const { bundle, config, scenarioId } = loadPacingContent();
  const ctx: FightContext = {
    kernel: kernel ?? createKernel(createPacingRegistry()),
    bundle,
    config,
    scenarioId,
  };
  const dock = Object.values(bundle.docks ?? {}).find((d) => d.portId === options.siteId);
  if (dock === undefined || dock.kind !== "site") {
    throw new ExpeditionsRequestError(`"${options.siteId}" is not a site with a map`);
  }
  const plans = plansToRun(options, menuAtSite(ctx, options.siteId));
  const records: FightRecord[] = [];
  for (const cast of options.casts) {
    const castEntries = castFor(dock.defaultCast ?? [], cast);
    for (const plan of plans) {
      for (const seed of options.seeds) {
        for (let i = 0; i < options.n; i++) {
          const worldSeed = seed * SEED_STRIDE + i;
          const spec = { siteId: options.siteId, plan, cast, castEntries, seed, worldSeed };
          records.push(yield* fightRun(ctx, spec));
        }
      }
    }
  }
  return records;
}

/** Run every fight the options name. Throws on a plan the site's menu does not offer. */
export function runExpeditions(options: ExpeditionsOptions, kernel?: Kernel): FightRecord[] {
  return drain(expeditionsRun(options, kernel));
}

/** `runExpeditions`, letting the event loop run between chunks (for tests; see `yielding.ts`). */
export function runExpeditionsAsync(
  options: ExpeditionsOptions,
  kernel?: Kernel,
): Promise<FightRecord[]> {
  return drainAsync(expeditionsRun(options, kernel));
}

// ---------------------------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------------------------

export interface SecondsStats {
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  /** Fights the figure exists for. */
  readonly of: number;
}

/** One plan against one cast, over its fights. Rates are per fight; shares are in [0, 1]. */
export interface PlanSummary {
  readonly plan: PlanId;
  readonly cast: CastVariant;
  readonly fights: number;
  readonly outcomes: Record<ExpeditionOutcome | "cutOff", number>;
  readonly endings: Record<FightEnding, number>;
  readonly contactToEnd: SecondsStats | null;
  readonly musterToContact: SecondsStats | null;
  readonly woundsPerFight: PerSide<Record<WoundSeverity, number>>;
  readonly bystandersWoundedPerFight: number;
  readonly downPerFight: PerSide<number>;
  readonly deadPerFight: PerSide<number>;
  readonly castFledShare: number;
  readonly castSurrenderedShare: number;
  readonly shotsPerFight: PerSide<number>;
  /** Hits over shots; `null` when the side never fired. */
  readonly hitRate: PerSide<number | null>;
  readonly partyWaveredShare: number;
  readonly partyBrokeShare: number;
  readonly tickerLinesPerFight: number;
}

function statsOf(values: readonly number[]): SecondsStats | null {
  if (values.length === 0) return null;
  return {
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    of: values.length,
  };
}

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);
const share = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);

/** Shares of each key over the records. */
function sharesOf<K extends string>(
  keys: readonly K[],
  records: readonly FightRecord[],
  pick: (r: FightRecord) => K,
): Record<K, number> {
  return Object.fromEntries(
    keys.map((k) => [k, share(records.filter((r) => pick(r) === k).length, records.length)]),
  ) as Record<K, number>;
}

const OUTCOME_KEYS = [...EXPEDITION_OUTCOMES, "cutOff"] as const;
const ENDINGS: readonly FightEnding[] = ["broke", "attrition", "objective", "withdraw", "timeout"];

/** Summarise one (plan, cast) group of records. */
export function summarise(records: readonly FightRecord[]): PlanSummary {
  const [first] = records;
  if (first === undefined) throw new RangeError("summarise: no fights");
  const fights = records.length;
  const perFight = (pick: (r: FightRecord) => number) => sum(records.map(pick)) / fights;
  const perSide = (pick: (r: FightRecord, side: "us" | "them") => number): PerSide<number> => ({
    us: perFight((r) => pick(r, "us")),
    them: perFight((r) => pick(r, "them")),
  });
  const severities = (side: "us" | "them") =>
    Object.fromEntries(
      WOUND_SEVERITIES.map((s) => [s, perFight((r) => r.wounds[side][s])]),
    ) as Record<WoundSeverity, number>;
  const castTotal = sum(records.map((r) => r.castFighters));
  const partyTotal = sum(records.map((r) => r.party));
  const hitRate = (side: "us" | "them") => {
    const shots = sum(records.map((r) => r.shots[side]));
    return shots === 0 ? null : sum(records.map((r) => r.hits[side])) / shots;
  };
  return {
    plan: first.plan,
    cast: first.cast,
    fights,
    outcomes: sharesOf(OUTCOME_KEYS, records, (r) => r.outcome),
    endings: sharesOf(ENDINGS, records, (r) => r.ending),
    contactToEnd: statsOf(records.flatMap((r) => r.contactToEndSeconds ?? [])),
    musterToContact: statsOf(records.flatMap((r) => r.musterToContactSeconds ?? [])),
    woundsPerFight: { us: severities("us"), them: severities("them") },
    bystandersWoundedPerFight: perFight((r) => r.bystandersWounded),
    downPerFight: perSide((r, side) => r.down[side]),
    deadPerFight: perSide((r, side) => r.dead[side]),
    castFledShare: share(sum(records.map((r) => r.castFled)), castTotal),
    castSurrenderedShare: share(sum(records.map((r) => r.castSurrendered)), castTotal),
    shotsPerFight: perSide((r, side) => r.shots[side]),
    hitRate: { us: hitRate("us"), them: hitRate("them") },
    partyWaveredShare: share(sum(records.map((r) => r.partyWavered)), partyTotal),
    partyBrokeShare: share(sum(records.map((r) => r.partyBroke)), partyTotal),
    tickerLinesPerFight: perFight((r) => r.tickerLines),
  };
}

/** Summaries per cast (in run order), a row per plan (in run order). */
export function summariesByCast(records: readonly FightRecord[]): Map<CastVariant, PlanSummary[]> {
  const groups = new Map<string, FightRecord[]>();
  for (const r of records) {
    const key = `${r.cast}\u0000${r.plan}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [r]);
    else group.push(r);
  }
  const byCast = new Map<CastVariant, PlanSummary[]>();
  for (const group of groups.values()) {
    const summary = summarise(group);
    byCast.set(summary.cast, [...(byCast.get(summary.cast) ?? []), summary]);
  }
  return byCast;
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

const pct = (s: number): string => `${Math.round(s * 100)}%`;
const fmt = (n: number, digits = 1): string => n.toFixed(digits);
const secs = (s: SecondsStats | null): string =>
  s === null ? "–" : `${fmt(s.mean)} (${fmt(s.min)}–${fmt(s.max)})`;
const sides = (p: PerSide<number>, digits = 2): string =>
  `${fmt(p.us, digits)} / ${fmt(p.them, digits)}`;
const woundCells = (w: Record<WoundSeverity, number>): string =>
  WOUND_SEVERITIES.map((s) => fmt(w[s], 2)).join(" · ");

function castSection(cast: CastVariant, rows: readonly PlanSummary[]): string[] {
  const outcomeHead = OUTCOME_KEYS.join(" | ");
  const endingHead = ENDINGS.join(" | ");
  return [
    "",
    `## Cast: ${cast}`,
    "",
    `| Plan | Fights | ${outcomeHead} | Contact→end s | Muster→contact s |`,
    `|---|---|${OUTCOME_KEYS.map(() => "---").join("|")}|---|---|`,
    ...rows.map(
      (r) =>
        `| ${r.plan} | ${r.fights} | ${OUTCOME_KEYS.map((k) => pct(r.outcomes[k])).join(" | ")} | ${secs(r.contactToEnd)} | ${secs(r.musterToContact)} |`,
    ),
    "",
    `| Plan | ${endingHead} | Cast fled | Cast surrendered | Party wavered | Party broke | Ticker lines |`,
    `|---|${ENDINGS.map(() => "---").join("|")}|---|---|---|---|---|`,
    ...rows.map(
      (r) =>
        `| ${r.plan} | ${ENDINGS.map((k) => pct(r.endings[k])).join(" | ")} | ${pct(r.castFledShare)} | ${pct(r.castSurrenderedShare)} | ${pct(r.partyWaveredShare)} | ${pct(r.partyBrokeShare)} | ${fmt(r.tickerLinesPerFight)} |`,
    ),
    "",
    `| Plan | Wounds us (${WOUND_SEVERITIES.join(" · ")}) | Wounds them | Bystanders hurt | Down us / them | Dead us / them | Shots us / them | Hit rate us / them |`,
    "|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => {
      const hit = (h: number | null) => (h === null ? "–" : pct(h));
      return `| ${r.plan} | ${woundCells(r.woundsPerFight.us)} | ${woundCells(r.woundsPerFight.them)} | ${fmt(r.bystandersWoundedPerFight, 2)} | ${sides(r.downPerFight)} | ${sides(r.deadPerFight)} | ${sides(r.shotsPerFight, 1)} | ${hit(r.hitRate.us)} / ${hit(r.hitRate.them)} |`;
    }),
  ];
}

export function formatExpeditionsReport(
  options: ExpeditionsOptions,
  records: readonly FightRecord[],
): string {
  const seedWord =
    options.seeds.length === 1 ? `seed ${options.seeds[0]}` : `seeds ${options.seeds.join(", ")}`;
  const lines = [
    `# Expeditions at ${options.siteId}: ${options.n} fight${options.n === 1 ? "" : "s"} a seed (${seedWord}), rates per fight, wounds by severity, cut off after ${GIVE_UP_AFTER_SECONDS} s`,
  ];
  for (const [cast, rows] of summariesByCast(records)) lines.push(...castSection(cast, rows));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

export interface ExpeditionsCliOptions extends ExpeditionsOptions {
  readonly json: boolean;
}

const USAGE =
  "crew expeditions [--site port.boathouse] [--plans <ids|all>] [--casts <default,shaky,hard|all>] [--n 20] [--seeds 1-5 | 1,3,5] [--json]";

/** "1-5" → [1..5]; "1,3,5" → [1, 3, 5]; "3" → [3]; undefined when it is none of these. */
export function parseSeeds(value: string | undefined): number[] | undefined {
  if (value === undefined) return undefined;
  const range = /^(-?\d+)-(-?\d+)$/.exec(value);
  if (range !== null) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (to < from) return undefined;
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }
  if (!/^-?\d+(,-?\d+)*$/.test(value)) return undefined;
  return value.split(",").map(Number);
}

function isCastVariant(value: string): value is CastVariant {
  return (CAST_VARIANTS as readonly string[]).includes(value);
}

export function parseExpeditionsArgs(
  args: readonly string[],
): ExpeditionsCliOptions | { error: string } {
  let siteId = DEFAULT_SITE;
  let plans: "all" | readonly PlanId[] = "all";
  let casts: readonly CastVariant[] = CAST_VARIANTS;
  let n = 20;
  let seeds: readonly number[] = [1, 2, 3, 4, 5];
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = args[i + 1];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (value === undefined) return { error: `${arg}: missing a value` };
    i += 1;
    switch (arg) {
      case "--site":
        siteId = value as PortDefId;
        break;
      case "--plans":
        plans = value === "all" ? "all" : value.split(",");
        break;
      case "--casts": {
        if (value === "all") {
          casts = CAST_VARIANTS;
          break;
        }
        const named = value.split(",");
        const bad = named.find((c) => !isCastVariant(c));
        if (bad !== undefined) {
          return { error: `--casts: expected ${CAST_VARIANTS.join(", ")} or all, got "${bad}"` };
        }
        casts = named.filter(isCastVariant);
        break;
      }
      case "--n": {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return { error: `--n: expected a whole number of fights, got "${value}"` };
        }
        n = parsed;
        break;
      }
      case "--seeds": {
        const parsed = parseSeeds(value);
        if (parsed === undefined) {
          return { error: `--seeds: expected a seed, a range like 1-5 or a list, got "${value}"` };
        }
        seeds = parsed;
        break;
      }
      default:
        return { error: `unknown option "${arg}"` };
    }
  }
  return { siteId, plans, casts, n, seeds, json };
}

export function runExpeditionsCli(args: readonly string[]): { output: string; exitCode: 0 | 1 } {
  const options = parseExpeditionsArgs(args);
  if ("error" in options) {
    return { output: `crew expeditions: ${options.error} (usage: ${USAGE})`, exitCode: 1 };
  }
  let records: FightRecord[];
  try {
    records = runExpeditions(options);
  } catch (error) {
    if (!(error instanceof ExpeditionsRequestError)) throw error;
    return { output: `crew expeditions: ${error.message}`, exitCode: 1 };
  }
  const output = options.json
    ? JSON.stringify(records, null, 2)
    : formatExpeditionsReport(options, records);
  return { output, exitCode: 0 };
}
