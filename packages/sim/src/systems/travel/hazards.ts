/**
 * Navigation hazards (§debris-fields-and-ion-storms): the narrator's `scheduleHazard` places one on
 * the leg, and it fires at the first `transit` tick at or after its `fireAtTick`, rolled against
 * whoever has the helm. A hazard lies on that leg only: if transit ends before it falls due, or the
 * course is given up in port, it is dropped (`navHazardMissed`, notable: a fact for the narrator,
 * no ticker line), never carried to the next leg. It can only be placed while the leg still has
 * transit ahead.
 *
 * The roll: the stander's piloting against the hazard's difficulty,
 * `p = clamp((skill - difficulty + 5) / 10, 0.05, 0.95)` and one `failures` draw `r`: clean if
 * `r < p`, a scrape if `r < p + (1 - p) / 2`, else a delay. Nobody at the helm is `unattended`:
 * a scrape and a delay both, with no roll. A scrape is one fault, weighted, on a ship machine with
 * a fault left to take, pushed onto `machine.scheduledFaults` to fire next tick through the one
 * fault path (D6); a delay sets `routeProgress` back `hazards.delaySeconds` at nominal speed
 * (never below the start of the leg). The stander has a thought about it: `helmCleanPass` for a
 * clean pass, `helmScrape` for a scrape; a delay leaves them none.
 *
 * §forced-faults-and-hazards (D106): a hazard placed with an `outcome` skips the roll: it fires the
 * same way, with that outcome (a scrape or a delay, never both, even at an empty helm), the
 * stander's thought, and `navHazard` marked `forced`.
 *
 * Owner: W3 of ship life slice 2.
 */
import { configTicks } from "../../core/clock";
import { type CommandHandler, NO_TEMP_REFS, causedBy, ok, reject } from "../../core/commands";
import { allocateId } from "../../core/ids";
import { addThought } from "../../core/thoughts";
import { FORCED_HAZARD_OUTCOMES, type FaultDef, HAZARD_KINDS } from "../../core/types/content";
import type { ActorId, LocalKey, MachineId } from "../../core/types/ids";
import type { StepCtx, System } from "../../core/types/pipeline";
import type { Machine } from "../../core/types/ship";
import type { ScheduledHazard } from "../../core/types/state";
import { shipDeckId } from "../../core/world";
import { whoHasTheHelm } from "../watch/helm";

/** The piloting-check difficulty range a hazard may have. */
export const HAZARD_DIFFICULTY_MIN = 1;
export const HAZARD_DIFFICULTY_MAX = 10;

export const scheduleHazard: CommandHandler<"scheduleHazard", null> = {
  validate(ctx, command) {
    const { kind, difficulty, windowTicks, outcome } = command.payload;
    if (!(HAZARD_KINDS as readonly string[]).includes(kind)) {
      return reject("invalidPayload", `scheduleHazard: unknown hazard kind "${kind}"`);
    }
    if (outcome !== undefined && !(FORCED_HAZARD_OUTCOMES as readonly string[]).includes(outcome)) {
      return reject("invalidPayload", `scheduleHazard: unknown outcome "${String(outcome)}"`);
    }
    if (
      !Number.isInteger(difficulty) ||
      difficulty < HAZARD_DIFFICULTY_MIN ||
      difficulty > HAZARD_DIFFICULTY_MAX
    ) {
      return reject(
        "invalidPayload",
        `scheduleHazard: difficulty must be an integer in [${HAZARD_DIFFICULTY_MIN}, ${HAZARD_DIFFICULTY_MAX}], got ${difficulty}`,
      );
    }
    if (!Array.isArray(windowTicks) || windowTicks.length !== 2) {
      return reject("invalidPayload", "scheduleHazard: windowTicks must be [earliest, latest]");
    }
    const [earliest, latest] = windowTicks;
    if (
      !Number.isInteger(earliest) ||
      !Number.isInteger(latest) ||
      earliest < 0 ||
      latest < earliest
    ) {
      return reject(
        "invalidPayload",
        "scheduleHazard: windowTicks must be [earliest, latest] with 0 <= earliest <= latest",
      );
    }
    const maxWindow = configTicks(ctx.config, ctx.config.narrator.maxFaultWindowSeconds);
    if (latest - earliest > maxWindow) {
      return reject(
        "outOfBounds",
        `scheduleHazard: window ${latest - earliest} ticks exceeds max ${maxWindow}`,
      );
    }
    const travel = ctx.state.travel;
    if (travel.stage === "docked" && travel.plannedDestinationId === undefined) {
      return reject(
        "preconditionFailed",
        "scheduleHazard: docked with no course planned; a hazard needs a leg to lie on",
      );
    }
    if (travel.stage === "approaching" || travel.stage === "docking") {
      return reject(
        "preconditionFailed",
        `scheduleHazard: the leg's transit is over (${travel.stage}); a hazard needs a leg to lie on`,
      );
    }
    return ok(null);
  },
  apply(ctx, command) {
    const { kind, difficulty, windowTicks, outcome } = command.payload;
    const [earliest, latest] = windowTicks;
    const fireAtTick = ctx.rng.int("failures", ctx.tick + earliest, ctx.tick + latest);
    const id = allocateId(ctx.state, "hazard");
    ctx.state.hazards.push({
      id,
      kind,
      difficulty,
      fireAtTick,
      causeCommandId: command.id,
      ...(outcome === undefined ? {} : { outcome }),
    });
    // §narrator-lever-budgets: advice, never a refusal; it may go below zero.
    ctx.state.narrator.budget.hazardsRemaining -= 1;
    ctx.emit({
      ...causedBy(command),
      type: "hazardScheduled",
      subjectIds: [],
      payload: { hazardId: id, kind },
    });
    return NO_TEMP_REFS;
  },
};

/** Bounds on the chance of a clean pass, so no check is ever certain either way. */
const CLEAN_CHANCE_MIN = 0.05;
const CLEAN_CHANCE_MAX = 0.95;

export type HazardOutcome = "clean" | "scrape" | "delay" | "unattended";

/** The chance a stander at piloting `skill` takes a hazard of `difficulty` clean. */
export function cleanPassChance(skill: number, difficulty: number): number {
  const p = (skill - difficulty + 5) / 10;
  return Math.min(CLEAN_CHANCE_MAX, Math.max(CLEAN_CHANCE_MIN, p));
}

/** The outcome of a roll `r` in [0, 1) at clean-pass chance `p`: the rest split scrape/delay. */
export function hazardOutcome(p: number, r: number): Exclude<HazardOutcome, "unattended"> {
  if (r < p) return "clean";
  if (r < p + (1 - p) / 2) return "scrape";
  return "delay";
}

/**
 * Has the leg the waiting hazards lie on ended without them? Its transit is over (`approaching`,
 * `docking`), or the ship is in port with no course to fly (given up before the leg began).
 */
function legGone(travel: StepCtx["state"]["travel"]): boolean {
  if (travel.stage === "docked") return travel.plannedDestinationId === undefined;
  return travel.stage === "approaching" || travel.stage === "docking";
}

/**
 * Fires every due hazard while the ship is in transit, and drops the ones the leg left unfired
 * (`navHazardMissed`) once it is gone (phase `equipment`, after travel, so the tick transit ends
 * is the tick they go).
 */
export const hazardsSystem: System = {
  name: "travel.hazards",
  phase: "equipment",
  run(ctx) {
    if (ctx.state.hazards.length === 0) return;
    if (legGone(ctx.state.travel)) {
      missAll(ctx);
      return;
    }
    if (ctx.state.travel.stage !== "transit") return;
    if (!ctx.state.hazards.some((hazard) => hazard.fireAtTick <= ctx.tick)) return;
    const due = ctx.state.hazards.filter((hazard) => hazard.fireAtTick <= ctx.tick);
    ctx.state.hazards = ctx.state.hazards.filter((hazard) => hazard.fireAtTick > ctx.tick);
    for (const hazard of due) fireHazard(ctx, hazard);
  },
};

/** Drops every waiting hazard with the leg it lay on, each with a `navHazardMissed`. */
function missAll(ctx: StepCtx): void {
  const travel = ctx.state.travel;
  const leg =
    travel.stage === "docked"
      ? { fromPortId: travel.portId }
      : { fromPortId: travel.fromPortId, toPortId: travel.toPortId };
  const missed = ctx.state.hazards;
  ctx.state.hazards = [];
  for (const hazard of missed) {
    ctx.emit({
      type: "navHazardMissed",
      subjectIds: [],
      causeIds: hazard.causeCommandId === undefined ? [] : [hazard.causeCommandId],
      source: "sim",
      payload: { hazardId: hazard.id, kind: hazard.kind, difficulty: hazard.difficulty, ...leg },
    });
  }
}

function fireHazard(ctx: StepCtx, hazard: ScheduledHazard): void {
  const standerId = whoHasTheHelm(ctx.state, ctx.content);
  const stander = standerId === undefined ? undefined : ctx.state.actors[standerId];
  if (standerId !== undefined && stander === undefined) {
    throw new Error(`hazard ${hazard.id}: the helm's stander ${standerId} is not in state`);
  }
  const skill = stander?.skills.piloting ?? 0;
  // §forced-faults-and-hazards: a decided outcome skips the roll (and the draw), helm or no helm.
  const outcome: HazardOutcome =
    hazard.outcome !== undefined
      ? hazard.outcome
      : stander === undefined
        ? "unattended"
        : hazardOutcome(cleanPassChance(skill, hazard.difficulty), ctx.rng.float("failures"));
  const scraped = outcome === "scrape" || outcome === "unattended";
  const delayed = outcome === "delay" || outcome === "unattended";
  const scrapedMachineId = scraped ? scrape(ctx, hazard) : undefined;
  const lostSeconds = delayed ? delay(ctx) : 0;
  if (stander !== undefined && outcome === "clean") addThought(ctx, stander, "helmCleanPass");
  if (stander !== undefined && outcome === "scrape") addThought(ctx, stander, "helmScrape");
  emitNavHazard(ctx, hazard, { standerId, skill, outcome, scrapedMachineId, lostSeconds });
}

interface NavHazardResult {
  readonly standerId: ActorId | undefined;
  readonly skill: number;
  readonly outcome: HazardOutcome;
  readonly scrapedMachineId: MachineId | undefined;
  readonly lostSeconds: number;
}

function emitNavHazard(ctx: StepCtx, hazard: ScheduledHazard, result: NavHazardResult): void {
  const { standerId, skill, outcome, scrapedMachineId, lostSeconds } = result;
  ctx.emit({
    type: "navHazard",
    subjectIds: [
      ...(standerId === undefined ? [] : [standerId]),
      ...(scrapedMachineId === undefined ? [] : [scrapedMachineId]),
    ],
    causeIds: hazard.causeCommandId === undefined ? [] : [hazard.causeCommandId],
    source: "sim",
    payload: {
      hazardId: hazard.id,
      kind: hazard.kind,
      difficulty: hazard.difficulty,
      ...(standerId === undefined ? {} : { standerId }),
      skill,
      outcome,
      ...(scrapedMachineId === undefined ? {} : { scrapedMachineId }),
      lostSeconds,
      ...(hazard.outcome === undefined ? {} : { forced: true as const }),
    },
  });
}

/** Faults `machine` could still take: not present, not already on its way, with some weight. */
function faultsLeft(ctx: StepCtx, machine: Machine): readonly FaultDef[] {
  const taken = new Set<LocalKey>([
    ...machine.faults.map((f) => f.faultKey),
    ...machine.scheduledFaults.map((f) => f.faultKey),
  ]);
  return ctx.defs.machine(machine.defId).faults.filter((f) => f.weight > 0 && !taken.has(f.key));
}

/**
 * A scrape: one fault, from a ship machine chosen by how many faults it has left to take, then
 * by the faults' weights, scheduled for next tick. Returns the machine, or undefined when no
 * machine aboard has a fault left to take (the hull took it and nothing broke).
 */
function scrape(ctx: StepCtx, hazard: ScheduledHazard): MachineId | undefined {
  const deckId = shipDeckId(ctx.state);
  const candidates = Object.values(ctx.state.machines)
    .filter((machine) => machine.deckId === deckId)
    .map((machine) => ({ machine, faults: faultsLeft(ctx, machine) }))
    .filter((candidate) => candidate.faults.length > 0);
  if (candidates.length === 0) return undefined;
  const causeCommandId = hazard.causeCommandId;
  if (causeCommandId === undefined) {
    // Every hazard comes from `scheduleHazard` today; a kernel-sampled one needs
    // `ScheduledFault.causeCommandId` made optional first.
    throw new Error(`hazard ${hazard.id} has no cause command for the fault it schedules`);
  }
  const { machine, faults } = ctx.rng.weighted(
    "failures",
    candidates.map((candidate) => ({ item: candidate, weight: candidate.faults.length })),
  );
  const fault = ctx.rng.weighted(
    "failures",
    faults.map((f) => ({ item: f, weight: f.weight })),
  );
  machine.scheduledFaults = [
    ...machine.scheduledFaults,
    { faultKey: fault.key, fireAtTick: ctx.tick + 1, causeCommandId },
  ];
  return machine.id;
}

/** A delay: the leg set back `hazards.delaySeconds` at nominal speed. Returns the seconds lost. */
function delay(ctx: StepCtx): number {
  const travel = ctx.state.travel;
  if (travel.stage !== "transit") throw new Error("a hazard delay outside transit");
  const speed = ctx.config.travel.nominalSpeed;
  const before = travel.routeProgress;
  travel.routeProgress = Math.max(0, before - ctx.config.hazards.delaySeconds * speed);
  travel.stageProgress =
    travel.routeDistance === 0 ? 1 : travel.routeProgress / travel.routeDistance;
  return speed > 0 ? (before - travel.routeProgress) / speed : 0;
}
