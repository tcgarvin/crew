/**
 * Equipment tick (SD §9.1–9.2, phase "equipment", every tick): heat, wear, hazard/fault draws,
 * scheduled-fault firing and maintenance-due detection for every machine.
 *
 * Ownership split with `systems/power`: power (phase "topology", earlier in the tick) sets a
 * consumer's `actualMode`/`output` from power availability alone. This system runs after it and
 * may only *further* restrict a machine toward `"off"` (temperature at/above failure point, or an
 * `inoperable` fault) — it never turns back on what power turned off, and for non-consumers
 * (generators, batteries, `"none"`) it is the only system that ever sets `actualMode`, from
 * `desiredMode` each tick so a cleared fault/cooled machine resumes automatically.
 *
 * // W5 decision: `Machine.failure` is one hazard counter with one sampled threshold (as W2 built
 * it in `core/world.ts`), not "a threshold per fault" as sketched in the original brief — the
 * shipped type only has room for one. When the counter crosses the threshold this system draws
 * *which* fault fires (weighted by `FaultDef.weight`, excluding faults already present) from the
 * `failures` stream, satisfying D6 (kernel samples fault timing) without a breaking type change.
 *
 * // W5 decision: `MachineHeatDef.coolPerSecond` is nominally a flat passive-cooling rate (W0
 * decision in `content.ts`: "cooling loops (SD §9.4) are deferred"). This system still honours a
 * *coolant pump*, but as a simple multiplier, not a loop/pipe simulation: if any other machine
 * tagged `"cooling"` shares this machine's power domain, cooling only applies at full rate while
 * at least one of them is `actualMode: "on"`; otherwise it falls to `COOLANT_OFFLINE_COOLING_FRACTION`.
 * A machine with no `"cooling"`-tagged machine on its domain is unaffected (no pump, no penalty).
 *
 * // W5 decision (schema gap, report to W10): there is no `MachineDef` field for a symptom
 * diagnosis's duration/skill (`RepairRecipe` only covers repair, and `MaintenanceDef.inspect` is
 * for routine maintenance, not fault diagnosis). `DIAGNOSE_SECONDS`/`DIAGNOSE_SKILL` below are
 * hardcoded pending a content schema addition (e.g. `MachineDef.diagnose: RecipeStep`).
 *
 * // W5 decision (schema gap, report to W10): there is no config/content field for how much
 * `condition` a completed repair restores. `REPAIR_CONDITION_RESTORE` below is hardcoded pending
 * a `ConfigDef.equipment.repairConditionRestore` addition; adding it now would require also
 * updating `packages/content`'s (W10-owned) Zod schema, out of scope here.
 *
 * Integrity counts (§integrity). Output carries an integrity factor (1 above
 * `config.equipment.integrityDerateBelow`, linear to 0 at `integrityInoperableBelow`) and a
 * machine below the inoperable threshold is blocked like an inoperable fault until a completed
 * fault repair (`recipes.ts`) lifts its integrity back to at least `integrityDerateBelow`.
 * Overheat is still the only thing that costs integrity.
 */
import { ticksToSeconds } from "../../core/clock";
import { allocateId } from "../../core/ids";
import type { KernelRegistry } from "../../core/registry";
import type { ConfigDef, MachineDef } from "../../core/types/content";
import type { DerateCause, EventDraft } from "../../core/types/events";
import type { CommandId, ItemDefId, LocalKey, MachineId, ProblemId } from "../../core/types/ids";
import type { StepCtx, System } from "../../core/types/pipeline";
import type { Machine } from "../../core/types/ship";
import type { Problem, ProblemOfKind } from "../../core/types/work";
import { domainKeyOf } from "../power/power";
import { raiseProblem, resolveProblem } from "./problems";
import { repairShortfall, unitsAboard } from "./supplies";
import { clamp, machineEvent } from "./util";

/** W5 decision: see module doc — pending `MachineDef` field for diagnosis. */
export const DIAGNOSE_SECONDS = 20;
export const DIAGNOSE_SKILL = { skill: "engineering", min: 1 } as const;
/** W5 decision: see module doc — pending `ConfigDef.equipment.repairConditionRestore`. */
export const REPAIR_CONDITION_RESTORE = 0.5;
/** W5 decision: see module doc — residual cooling fraction while a domain's coolant pump is down. */
const COOLANT_OFFLINE_COOLING_FRACTION = 0.2;

type EquipmentConfig = ConfigDef["equipment"];

/**
 * §integrity: output factor from integrity: 1 at or above `integrityDerateBelow`, falling linearly
 * to 0 at `integrityInoperableBelow` (and 0 below it, where the machine is blocked outright).
 */
export function integrityOutputFactor(integrity: number, config: EquipmentConfig): number {
  const { integrityDerateBelow: derateBelow, integrityInoperableBelow: inoperableBelow } = config;
  if (integrity >= derateBelow) return 1;
  if (integrity < inoperableBelow || derateBelow <= inoperableBelow) return 0;
  return clamp((integrity - inoperableBelow) / (derateBelow - inoperableBelow), 0, 1);
}

/** §integrity: integrity so low the machine will not run until repaired. */
export function isIntegrityBlocked(integrity: number, config: EquipmentConfig): boolean {
  return integrity < config.integrityInoperableBelow;
}

/**
 * Whether `machine` is blocked from running regardless of power: an `inoperable` fault, its
 * temperature at the failure point, or integrity below the inoperable threshold. The same rule
 * `tickMachine` applies, exported so travel's departure gate (§departure-gate) asks the same
 * question.
 */
export function isMachineBlocked(
  machine: Pick<Machine, "faults" | "temperature" | "integrity">,
  def: Pick<MachineDef, "faults">,
  config: EquipmentConfig,
): boolean {
  const inoperableFault = machine.faults.some(
    (f) => def.faults.find((d) => d.key === f.faultKey)?.effect.kind === "inoperable",
  );
  return (
    inoperableFault || machine.temperature >= 1 || isIntegrityBlocked(machine.integrity, config)
  );
}

/** The smallest output factor names the cause; ties go to the earlier entry. */
function derateCause(factors: readonly (readonly [DerateCause, number])[]): DerateCause {
  let worst = factors[0] ?? (["power", 1] as const);
  for (const entry of factors) if (entry[1] < worst[1]) worst = entry;
  return worst[0];
}

/**
 * Where each machine's coolant comes from, for one equipment run: its power domain, and the
 * `"cooling"`-tagged machines on each domain. Domains and tags come from content and placements,
 * which nothing in this phase changes, so the index is built once per run rather than scanning
 * every machine for every machine (that all-pairs scan was the system's main cost on a Freighter
 * Mk2). It holds the live `Machine` objects, so a pump this run has already switched off reads as
 * off to every machine ticked after it, exactly as a fresh scan would.
 */
interface CoolantIndex {
  readonly domainOf: ReadonlyMap<MachineId, LocalKey>;
  readonly coolersByDomain: ReadonlyMap<LocalKey, readonly Machine[]>;
}

function buildCoolantIndex(ctx: StepCtx, machines: readonly Machine[]): CoolantIndex {
  const domainOf = new Map<MachineId, LocalKey>();
  const coolersByDomain = new Map<LocalKey, Machine[]>();
  for (const machine of machines) {
    const domainKey = domainKeyOf(ctx, machine);
    if (domainKey === undefined) continue;
    domainOf.set(machine.id, domainKey);
    if (!ctx.defs.machine(machine.defId).tags.includes("cooling")) continue;
    const coolers = coolersByDomain.get(domainKey);
    if (coolers === undefined) coolersByDomain.set(domainKey, [machine]);
    else coolers.push(machine);
  }
  return { domainOf, coolersByDomain };
}

/** Full cooling unless other `"cooling"` machines share this one's domain and none is on. */
function coolantAvailable(index: CoolantIndex, machine: Machine): boolean {
  const domainKey = index.domainOf.get(machine.id);
  if (domainKey === undefined) return true;
  let hasCooler = false;
  for (const cooler of index.coolersByDomain.get(domainKey) ?? []) {
    if (cooler.id === machine.id) continue;
    if (cooler.actualMode === "on") return true;
    hasCooler = true;
  }
  return !hasCooler;
}

/**
 * Add `faultKey` to `machine` (no-op if already present, per the ship.ts W0 decision that a
 * machine holds at most one fault per key), raise its `machineSymptom` problem and emit
 * `faultOccurred`. The one path both natural hazard draws and fired `scheduleFault`/scenario
 * faults should go through.
 */
export function applyFault(
  ctx: StepCtx,
  machine: Machine,
  def: MachineDef,
  faultKey: LocalKey,
  causeCommandId?: CommandId,
): void {
  if (machine.faults.some((f) => f.faultKey === faultKey)) return;
  const faultDef = def.faults.find((f) => f.key === faultKey);
  if (faultDef === undefined) return;
  machine.faults.push({
    faultKey,
    sinceTick: ctx.tick,
    diagnosed: false,
    repairStepIndex: 0,
    repairStepProgress: 0,
    ...(causeCommandId !== undefined ? { causeCommandId } : {}),
  });
  ctx.dirty.power = true;
  ctx.emit({
    type: "faultOccurred",
    subjectIds: [machine.id],
    causeIds: causeCommandId !== undefined ? [causeCommandId] : [],
    source: "sim",
    locationRef: { kind: "machine", machineId: machine.id },
    payload: { machineId: machine.id, faultKey },
  });
  raiseSymptomProblem(ctx, machine, faultDef);
}

/**
 * Open the `machineSymptom` problem for an undiagnosed fault.
 *
 * W5 decision (revised in Integration 2): symptoms are `discovered` (perception must write the
 * actor a `problem` fact before it is visible) except `sensor`-channel symptoms, which show on
 * the ship's panels and are `public` — the symptom channel is the "has a sensor" marker W5 was
 * missing.
 */
function raiseSymptomProblem(
  ctx: StepCtx,
  machine: Machine,
  faultDef: MachineDef["faults"][number],
): ProblemId {
  const { problemId, event } = raiseProblem(ctx.state, ctx.tick, {
    kind: "machineSymptom",
    payload: { machineId: machine.id, symptomKey: faultDef.symptom.key },
    dedupeKey: `machineSymptom:${machine.id}:${faultDef.key}`,
    visibility: faultDef.symptom.channel === "sensor" ? "public" : "discovered",
    baseUrgency: "essentialOperation",
    location: { kind: "machine", machineId: machine.id },
  });
  if (event !== undefined) ctx.emit(event);
  return problemId;
}

/**
 * §thought-and-reveal-levers: the narrator's `reveal`. The symptom problem of `faultDef` on
 * `machine` (opened if the fault has none yet) goes `public`, as an intercom report makes the damage
 * it relays (`intercom/report.ts`), so every crew member's view has it and the planner sends
 * someone to inspect. Returns the problem.
 */
export function revealSymptom(
  ctx: StepCtx,
  machine: Machine,
  faultDef: MachineDef["faults"][number],
): Problem {
  const problemId = raiseSymptomProblem(ctx, machine, faultDef);
  const problem = ctx.state.work.problems[problemId];
  if (problem === undefined) throw new Error(`revealSymptom: problem ${problemId} vanished`);
  problem.visibility = "public";
  return problem;
}

/**
 * Integration 2: a fault that arrived without going through `applyFault` (core's
 * `scenarioInjectFault`, a scenario's `initialFaults`) still needs its symptom problem, or nobody
 * would ever look at it. Undiagnosed faults with no open symptom problem get one here.
 */
function ensureSymptomProblems(ctx: StepCtx, machine: Machine, def: MachineDef): void {
  for (const fault of machine.faults) {
    if (fault.diagnosed) continue;
    const dedupeKey = `machineSymptom:${machine.id}:${fault.faultKey}`;
    const open = Object.values(ctx.state.work.problems).some(
      (p) => p.dedupeKey === dedupeKey && p.status === "open",
    );
    if (open) continue;
    const faultDef = def.faults.find((f) => f.key === fault.faultKey);
    if (faultDef !== undefined) raiseSymptomProblem(ctx, machine, faultDef);
  }
}

/**
 * §parts-and-tools-needed: a repair stalls for good when a step consumes a part the ship does not
 * have, so the shortfall is a problem of its own (`partsNeeded`, one per machine and item) that
 * commerce answers from the port market while docked. Raised and revised against truth every tick:
 * aboard counts on deck and in hand, so a stack bought at the ramp or found in stores resolves
 * it, and a fault repaired or still undiagnosed never needs anything. §tool-shortfall: a tool kind
 * the repair names and nothing aboard provides is a shortfall too, of one supplying item
 * (`supplies.ts`), bought the same way.
 */
function updatePartsNeeded(ctx: StepCtx, machine: Machine, def: MachineDef): void {
  const diagnosed = machine.faults.some((f) => f.diagnosed);
  const needed = diagnosed
    ? repairShortfall(ctx.content, def, machine.faults, unitsAboard(ctx.state))
    : [];
  const open = new Set<ItemDefId>();
  for (const { itemDefId, count: shortfall } of needed) {
    open.add(itemDefId);
    const dedupeKey = `partsNeeded:${machine.id}:${itemDefId}`;
    const existing = Object.values(ctx.state.work.problems).find(
      (p): p is ProblemOfKind<"partsNeeded"> =>
        p.kind === "partsNeeded" && p.dedupeKey === dedupeKey && p.status === "open",
    );
    if (existing !== undefined) {
      if (existing.payload.count !== shortfall) {
        existing.payload = { ...existing.payload, count: shortfall };
        existing.revision += 1;
      }
      continue;
    }
    const { event } = raiseProblem(ctx.state, ctx.tick, {
      kind: "partsNeeded",
      payload: { machineId: machine.id, itemDefId, count: shortfall },
      dedupeKey,
      visibility: "public",
      baseUrgency: "essentialOperation",
      location: { kind: "machine", machineId: machine.id },
    });
    if (event !== undefined) ctx.emit(event);
  }
  for (const problem of Object.values(ctx.state.work.problems)) {
    if (problem.kind !== "partsNeeded" || problem.status !== "open") continue;
    if (problem.payload.machineId !== machine.id || open.has(problem.payload.itemDefId)) continue;
    const event = resolveProblem(ctx.state, problem.dedupeKey);
    if (event !== undefined) ctx.emit(event);
  }
}

function fireScheduledFaults(ctx: StepCtx, machine: Machine, def: MachineDef): void {
  if (machine.scheduledFaults.length === 0) return;
  const due = machine.scheduledFaults.filter((sf) => sf.fireAtTick <= ctx.tick);
  if (due.length === 0) return;
  machine.scheduledFaults = machine.scheduledFaults.filter((sf) => sf.fireAtTick > ctx.tick);
  for (const sf of due) applyFault(ctx, machine, def, sf.faultKey, sf.causeCommandId);
}

/** What the machine's present faults do to it, combined. */
interface FaultEffects {
  readonly inoperable: boolean;
  readonly outputFactor: number;
  readonly extraHeatPerSecond: number;
}

function faultEffects(machine: Machine, def: MachineDef): FaultEffects {
  let inoperable = false;
  let outputFactor = 1;
  let extraHeatPerSecond = 0;
  for (const fault of machine.faults) {
    const effect = def.faults.find((f) => f.key === fault.faultKey)?.effect;
    if (effect?.kind === "inoperable") inoperable = true;
    else if (effect?.kind === "derate") outputFactor *= effect.outputFactor;
    else if (effect?.kind === "overheat") extraHeatPerSecond += effect.extraRisePerSecond;
  }
  return { inoperable, outputFactor, extraHeatPerSecond };
}

/** The share of its rated draw a consumer is allocated (1 for anything else). */
function powerFraction(machine: Machine, def: MachineDef): number {
  return def.power.role === "consumer" && def.power.drawKw > 0
    ? clamp(machine.powerAllocatedKw / def.power.drawKw, 0, 1)
    : 1;
}

/**
 * Heat: rise while genuinely operating (power on and not inoperable), fall toward ambient
 * otherwise, gated by coolant-pump availability (see module doc). Overheat costs integrity.
 */
function updateHeat(
  ctx: StepCtx,
  coolant: CoolantIndex,
  machine: Machine,
  def: MachineDef,
  faults: FaultEffects,
  dtSeconds: number,
): void {
  const generatingHeat = machine.actualMode === "on" && !faults.inoperable;
  const riseRate = generatingHeat
    ? def.heat.risePerSecond * powerFraction(machine, def) + faults.extraHeatPerSecond
    : 0;
  const coolRate =
    def.heat.coolPerSecond *
    (coolantAvailable(coolant, machine) ? 1 : COOLANT_OFFLINE_COOLING_FRACTION);
  machine.temperature = clamp(machine.temperature + (riseRate - coolRate) * dtSeconds, 0, 1.5);
  if (machine.temperature > 1) {
    machine.integrity = clamp(
      machine.integrity - ctx.config.equipment.overheatDamagePerSecond * dtSeconds,
      0,
      1,
    );
  }
}

function heatOutputFactor(temperature: number, def: MachineDef): number {
  if (temperature >= 1) return 0;
  if (temperature > def.heat.derateAbove) return (1 - temperature) / (1 - def.heat.derateAbove);
  return 1;
}

/** Power already set the baseline this tick; equipment may only push further toward off. */
function updateMode(ctx: StepCtx, machine: Machine, def: MachineDef): void {
  // §integrity: integrity after this tick's overheat damage, so a machine that just crossed the
  // inoperable threshold stops now rather than next tick.
  const blocked = isMachineBlocked(machine, def, ctx.config.equipment);
  const wasMode = machine.actualMode;
  if (def.power.role === "consumer") {
    if (blocked) machine.actualMode = "off";
  } else {
    machine.actualMode = blocked ? "off" : machine.desiredMode;
  }
  if (machine.actualMode === wasMode) return;
  ctx.emit(
    machineEvent("machineModeChanged", machine.id, {
      machineId: machine.id,
      from: wasMode,
      to: machine.actualMode,
    }),
  );
}

function updateOutput(ctx: StepCtx, machine: Machine, def: MachineDef, faults: FaultEffects): void {
  const factors = [
    ["power", powerFraction(machine, def)],
    ["heat", heatOutputFactor(machine.temperature, def)],
    ["fault", faults.outputFactor],
    ["integrity", integrityOutputFactor(machine.integrity, ctx.config.equipment)],
  ] as const;
  const oldOutput = machine.output;
  const newOutput =
    machine.actualMode === "on"
      ? clamp(
          factors.reduce((p, [, f]) => p * f, 1),
          0,
          1,
        )
      : 0;
  machine.output = newOutput;
  if (oldOutput < 1 || newOutput >= 1) return;
  ctx.emit(
    machineEvent("machineDerated", machine.id, {
      machineId: machine.id,
      output: newOutput,
      cause: derateCause(factors),
    }),
  );
}

/** Wear and hazard accumulate only while truly operating; a crossed threshold draws a fault. */
function updateHazard(ctx: StepCtx, machine: Machine, def: MachineDef, dtSeconds: number): void {
  if (machine.actualMode === "on") {
    machine.condition = clamp(machine.condition - def.failure.wearPerSecond * dtSeconds, 0, 1);
    const heatHazardFactor = 1 + (def.failure.heatFactor - 1) * clamp(machine.temperature, 0, 1);
    const wearFactor = 1 - machine.condition;
    const hazardRate =
      def.failure.baseHazardPerSecond *
      ctx.config.equipment.hazardScale *
      heatHazardFactor *
      (1 + wearFactor);
    machine.failure.accumulatedHazard += hazardRate * dtSeconds;
  }
  if (machine.failure.accumulatedHazard < machine.failure.threshold) return;
  const candidates = def.faults.filter((f) => !machine.faults.some((mf) => mf.faultKey === f.key));
  if (candidates.length > 0) {
    const chosen = ctx.rng.weighted(
      "failures",
      candidates.map((f) => ({ item: f, weight: f.weight })),
    );
    applyFault(ctx, machine, def, chosen.key);
  }
  machine.failure.accumulatedHazard = 0;
  machine.failure.threshold = -Math.log(1 - ctx.rng.float("failures"));
}

/**
 * §maintenance-due: maintenance is due below `maintenanceConditionBelow` (routine) and pressing
 * below `maintenanceEssentialBelow` (essential); an open problem is raised to essential as the
 * machine wears on, never lowered, since only the service itself resolves it.
 */
function updateMaintenanceDue(ctx: StepCtx, machine: Machine, def: MachineDef): void {
  if (def.maintenance === undefined) return;
  const dedupeKey = `maintenanceDue:${machine.id}`;
  const { maintenanceConditionBelow, maintenanceEssentialBelow } = ctx.config.equipment;
  if (machine.condition >= maintenanceConditionBelow) {
    const event = resolveProblem(ctx.state, dedupeKey);
    if (event !== undefined) ctx.emit(event);
    return;
  }
  const pressing = machine.condition < maintenanceEssentialBelow;
  const raised = raiseProblem(ctx.state, ctx.tick, {
    kind: "maintenanceDue",
    payload: { machineId: machine.id },
    dedupeKey,
    visibility: "public",
    baseUrgency: pressing ? "essentialOperation" : "routineObligation",
    location: { kind: "machine", machineId: machine.id },
  });
  if (raised.event !== undefined) ctx.emit(raised.event);
  const problem = ctx.state.work.problems[raised.problemId];
  if (pressing && problem !== undefined) problem.baseUrgency = "essentialOperation";
}

function tickMachine(
  ctx: StepCtx,
  coolant: CoolantIndex,
  machine: Machine,
  dtSeconds: number,
): void {
  const def = ctx.defs.machine(machine.defId);
  fireScheduledFaults(ctx, machine, def);
  ensureSymptomProblems(ctx, machine, def);
  updatePartsNeeded(ctx, machine, def);
  const faults = faultEffects(machine, def);
  updateHeat(ctx, coolant, machine, def, faults, dtSeconds);
  updateMode(ctx, machine, def);
  updateOutput(ctx, machine, def, faults);
  updateHazard(ctx, machine, def, dtSeconds);
  updateMaintenanceDue(ctx, machine, def);
}

export const equipmentSystem: System = {
  name: "equipment.tick",
  phase: "equipment",
  run(ctx) {
    const dtSeconds = ticksToSeconds(ctx.elapsedTicks, ctx.config.time.tickRate);
    const machines = Object.values(ctx.state.machines);
    const coolant = buildCoolantIndex(ctx, machines);
    for (const machine of machines) tickMachine(ctx, coolant, machine, dtSeconds);
  },
};

export function registerEquipmentSystem(registry: KernelRegistry): void {
  registry.registerSystem(equipmentSystem);
}
