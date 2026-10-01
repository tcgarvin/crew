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
 * D35 (2026-10-01): integrity counts. Output carries an integrity factor (1 above
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
import type { CommandId, LocalKey } from "../../core/types/ids";
import type { StepCtx, System } from "../../core/types/pipeline";
import type { Machine } from "../../core/types/ship";
import { domainKeyOf } from "../power/power";
import { raiseProblem, resolveProblem } from "./problems";
import { clamp } from "./util";

/** W5 decision: see module doc — pending `MachineDef` field for diagnosis. */
export const DIAGNOSE_SECONDS = 20;
export const DIAGNOSE_SKILL = { skill: "engineering", min: 1 } as const;
/** W5 decision: see module doc — pending `ConfigDef.equipment.repairConditionRestore`. */
export const REPAIR_CONDITION_RESTORE = 0.5;
/** W5 decision: see module doc — residual cooling fraction while a domain's coolant pump is down. */
const COOLANT_OFFLINE_COOLING_FRACTION = 0.2;

type EquipmentConfig = ConfigDef["equipment"];

/**
 * D35: output factor from integrity: 1 at or above `integrityDerateBelow`, falling linearly to 0
 * at `integrityInoperableBelow` (and 0 below it, where the machine is blocked outright).
 */
export function integrityOutputFactor(integrity: number, config: EquipmentConfig): number {
  const { integrityDerateBelow: derateBelow, integrityInoperableBelow: inoperableBelow } = config;
  if (integrity >= derateBelow) return 1;
  if (integrity < inoperableBelow || derateBelow <= inoperableBelow) return 0;
  return clamp((integrity - inoperableBelow) / (derateBelow - inoperableBelow), 0, 1);
}

/** D35: integrity so low the machine will not run until repaired. */
export function isIntegrityBlocked(integrity: number, config: EquipmentConfig): boolean {
  return integrity < config.integrityInoperableBelow;
}

/**
 * Whether `machine` is blocked from running regardless of power: an `inoperable` fault, its
 * temperature at the failure point, or integrity below the inoperable threshold. The same rule
 * `tickMachine` applies, exported so travel's departure gate (D36) asks the same question.
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

function coolantAvailable(ctx: StepCtx, machine: Machine): boolean {
  const domainKey = domainKeyOf(ctx, machine);
  if (domainKey === undefined) return true;
  const coolants = Object.values(ctx.state.machines).filter((m) => {
    if (m.id === machine.id) return false;
    if (domainKeyOf(ctx, m) !== domainKey) return false;
    return ctx.defs.machine(m.defId).tags.includes("cooling");
  });
  if (coolants.length === 0) return true;
  return coolants.some((m) => m.actualMode === "on");
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
): void {
  const { event } = raiseProblem(ctx.state, ctx.tick, {
    kind: "machineSymptom",
    payload: { machineId: machine.id, symptomKey: faultDef.symptom.key },
    dedupeKey: `machineSymptom:${machine.id}:${faultDef.key}`,
    visibility: faultDef.symptom.channel === "sensor" ? "public" : "discovered",
    baseUrgency: "essentialOperation",
    location: { kind: "machine", machineId: machine.id },
  });
  if (event !== undefined) ctx.emit(event);
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

function fireScheduledFaults(ctx: StepCtx, machine: Machine, def: MachineDef): void {
  if (machine.scheduledFaults.length === 0) return;
  const due = machine.scheduledFaults.filter((sf) => sf.fireAtTick <= ctx.tick);
  if (due.length === 0) return;
  machine.scheduledFaults = machine.scheduledFaults.filter((sf) => sf.fireAtTick > ctx.tick);
  for (const sf of due) applyFault(ctx, machine, def, sf.faultKey, sf.causeCommandId);
}

function tickMachine(ctx: StepCtx, machine: Machine, dtSeconds: number): void {
  const def = ctx.defs.machine(machine.defId);
  fireScheduledFaults(ctx, machine, def);
  ensureSymptomProblems(ctx, machine, def);

  let inoperableFromFault = false;
  let faultOutputFactor = 1;
  let faultExtraHeat = 0;
  for (const fault of machine.faults) {
    const faultDef = def.faults.find((f) => f.key === fault.faultKey);
    if (faultDef === undefined) continue;
    if (faultDef.effect.kind === "inoperable") inoperableFromFault = true;
    else if (faultDef.effect.kind === "derate") faultOutputFactor *= faultDef.effect.outputFactor;
    else if (faultDef.effect.kind === "overheat")
      faultExtraHeat += faultDef.effect.extraRisePerSecond;
  }

  // Heat: rise while genuinely operating (power on and not inoperable), fall toward ambient
  // otherwise, gated by coolant-pump availability (see module doc).
  const poweredOn = machine.actualMode === "on";
  const generatingHeat = poweredOn && !inoperableFromFault;
  const modeFactor =
    def.power.role === "consumer" && def.power.drawKw > 0
      ? clamp(machine.powerAllocatedKw / def.power.drawKw, 0, 1)
      : 1;
  const riseRate = generatingHeat ? def.heat.risePerSecond * modeFactor + faultExtraHeat : 0;
  const coolRate =
    def.heat.coolPerSecond *
    (coolantAvailable(ctx, machine) ? 1 : COOLANT_OFFLINE_COOLING_FRACTION);
  const newTemp = clamp(machine.temperature + (riseRate - coolRate) * dtSeconds, 0, 1.5);
  machine.temperature = newTemp;

  if (newTemp > 1) {
    machine.integrity = clamp(
      machine.integrity - ctx.config.equipment.overheatDamagePerSecond * dtSeconds,
      0,
      1,
    );
  }

  let heatFactor = 1;
  if (newTemp >= 1) heatFactor = 0;
  else if (newTemp > def.heat.derateAbove) heatFactor = (1 - newTemp) / (1 - def.heat.derateAbove);

  // D35: integrity after this tick's overheat damage, so a machine that just crossed the
  // inoperable threshold stops now rather than next tick.
  const integrityFactor = integrityOutputFactor(machine.integrity, ctx.config.equipment);
  const integrityBlocked = isIntegrityBlocked(machine.integrity, ctx.config.equipment);

  // Mode: power already set the baseline this tick; equipment may only push further toward off.
  const blocked = inoperableFromFault || newTemp >= 1 || integrityBlocked;
  const wasMode = machine.actualMode;
  if (def.power.role === "consumer") {
    if (blocked) machine.actualMode = "off";
  } else {
    machine.actualMode = blocked ? "off" : machine.desiredMode;
  }
  if (machine.actualMode !== wasMode) {
    ctx.emit({
      type: "machineModeChanged",
      subjectIds: [machine.id],
      causeIds: [],
      source: "sim",
      locationRef: { kind: "machine", machineId: machine.id },
      payload: { machineId: machine.id, from: wasMode, to: machine.actualMode },
    });
  }

  const finalOn = machine.actualMode === "on";
  const powerFraction =
    def.power.role === "consumer" && def.power.drawKw > 0
      ? clamp(machine.powerAllocatedKw / def.power.drawKw, 0, 1)
      : 1;
  const oldOutput = machine.output;
  const newOutput = finalOn
    ? clamp(powerFraction * heatFactor * faultOutputFactor * integrityFactor, 0, 1)
    : 0;
  machine.output = newOutput;
  if (oldOutput >= 1 && newOutput < 1) {
    const cause = derateCause([
      ["power", powerFraction],
      ["heat", heatFactor],
      ["fault", faultOutputFactor],
      ["integrity", integrityFactor],
    ]);
    ctx.emit({
      type: "machineDerated",
      subjectIds: [machine.id],
      causeIds: [],
      source: "sim",
      locationRef: { kind: "machine", machineId: machine.id },
      payload: { machineId: machine.id, output: newOutput, cause },
    });
  }

  // Wear and hazard accumulate only while truly operating.
  if (finalOn) {
    machine.condition = clamp(machine.condition - def.failure.wearPerSecond * dtSeconds, 0, 1);
    const heatHazardFactor = 1 + (def.failure.heatFactor - 1) * clamp(newTemp, 0, 1);
    const wearFactor = 1 - machine.condition;
    const hazardRate =
      def.failure.baseHazardPerSecond *
      ctx.config.equipment.hazardScale *
      heatHazardFactor *
      (1 + wearFactor);
    machine.failure.accumulatedHazard += hazardRate * dtSeconds;
  }

  if (machine.failure.accumulatedHazard >= machine.failure.threshold) {
    const candidates = def.faults.filter(
      (f) => !machine.faults.some((mf) => mf.faultKey === f.key),
    );
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

  // Maintenance due.
  if (def.maintenance !== undefined) {
    const dedupeKey = `maintenanceDue:${machine.id}`;
    if (machine.condition < ctx.config.equipment.maintenanceConditionBelow) {
      const { event } = raiseProblem(ctx.state, ctx.tick, {
        kind: "maintenanceDue",
        payload: { machineId: machine.id },
        dedupeKey,
        visibility: "public",
        baseUrgency: "routineObligation",
        location: { kind: "machine", machineId: machine.id },
      });
      if (event !== undefined) ctx.emit(event);
    } else {
      const event = resolveProblem(ctx.state, dedupeKey);
      if (event !== undefined) ctx.emit(event);
    }
  }
}

export const equipmentSystem: System = {
  name: "equipment.tick",
  phase: "equipment",
  run(ctx) {
    const dtSeconds = ticksToSeconds(ctx.elapsedTicks, ctx.config.time.tickRate);
    for (const machine of Object.values(ctx.state.machines)) {
      tickMachine(ctx, machine, dtSeconds);
    }
  },
};

export function registerEquipmentSystem(registry: KernelRegistry): void {
  registry.registerSystem(equipmentSystem);
}
