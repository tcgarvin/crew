/**
 * Power allocation (SD §9.3, docs/CONTRACTS.md, phase "topology"). Groups each power domain's
 * machines, sums generator supply, allocates it to consumers by authored priority tier
 * (`config.power.priorityOrder`), proportionally within a tier, then tops up a shortfall from —
 * or banks a surplus into — one battery per domain.
 *
 * // W5 decision: recomputes every domain every tick instead of gating on `ctx.dirty.power` /
 * mode-change detection (the perf optimisation asked for in the brief). V1 ships are small
 * (thin slice) so the full recompute is cheap and avoids adding a new derived-cache field
 * just to remember "did anything change". `ctx.dirty.power` is still cleared at the end so a
 * future gate can be layered on without another contract change.
 *
 * // W5 decision: a machine whose `MachinePlacementDef.powerDomain` is absent, or whose def's
 * `power.role` is `"none"`, is not touched by this system at all: no allocation, no mode change.
 */
import type { KernelRegistry } from "../../core/registry";
import type { DeckDef, PowerPriority } from "../../core/types/content";
import type { EventDraft } from "../../core/types/events";
import type { DeckDefId, LocalKey, MachineId } from "../../core/types/ids";
import type { StepCtx, System } from "../../core/types/pipeline";
import type { Machine, OperatingMode } from "../../core/types/ship";
import { clamp, machineEvent } from "../equipment/util";

interface DomainGroup {
  generators: Machine[];
  consumers: Machine[];
  battery: Machine | undefined;
}

/**
 * Each placement's power domain by placement key, per deck def. Content is immutable, so the
 * entry is never stale and a fresh process rebuilds it on first use (as `berthDock` does); a
 * repeated key keeps its first placement, as a linear search would.
 */
const domainsByDeck = new WeakMap<DeckDef, ReadonlyMap<string, LocalKey | undefined>>();

function placementDomains(deck: DeckDef): ReadonlyMap<string, LocalKey | undefined> {
  const cached = domainsByDeck.get(deck);
  if (cached !== undefined) return cached;
  const domains = new Map<string, LocalKey | undefined>();
  for (const placement of deck.machines) {
    if (!domains.has(placement.key)) domains.set(placement.key, placement.powerDomain);
  }
  domainsByDeck.set(deck, domains);
  return domains;
}

/** The power domain a machine's placement names, or `undefined` if it is not on any bus. */
export function domainKeyOf(
  ctx: Pick<StepCtx, "content">,
  machine: Pick<Machine, "deckId" | "placementKey">,
): LocalKey | undefined {
  const deck = ctx.content.decks[machine.deckId as DeckDefId];
  return deck === undefined ? undefined : placementDomains(deck).get(machine.placementKey);
}

function groupByDomain(ctx: StepCtx): Map<LocalKey, DomainGroup> {
  const groups = new Map<LocalKey, DomainGroup>();
  const machines = Object.values(ctx.state.machines).sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const machine of machines) {
    const domainKey = domainKeyOf(ctx, machine);
    if (domainKey === undefined || !(domainKey in ctx.state.power.domains)) continue;
    const def = ctx.defs.machine(machine.defId);
    if (def.power.role === "none") continue;
    let group = groups.get(domainKey);
    if (group === undefined) {
      group = { generators: [], consumers: [], battery: undefined };
      groups.set(domainKey, group);
    }
    if (def.power.role === "generator") group.generators.push(machine);
    else if (def.power.role === "consumer") group.consumers.push(machine);
    else if (def.power.role === "battery") group.battery = machine;
  }
  return groups;
}

function drawKwOf(ctx: StepCtx, machine: Machine): number {
  const def = ctx.defs.machine(machine.defId);
  return def.power.role === "consumer" ? def.power.drawKw : 0;
}

/** What a generator puts on its bus this tick (0 when off). */
function generatedKw(ctx: StepCtx, generator: Machine): number {
  const def = ctx.defs.machine(generator.defId);
  return def.power.role === "generator" && generator.actualMode !== "off"
    ? def.power.supplyKw * generator.output
    : 0;
}

/** Consumers that want power, by priority tier, each tier in id order. */
function consumersByTier(ctx: StepCtx, consumers: readonly Machine[]) {
  const byTier = new Map<PowerPriority, Machine[]>();
  for (const consumer of consumers) {
    if (consumer.desiredMode === "off") continue;
    const def = ctx.defs.machine(consumer.defId);
    if (def.power.role !== "consumer") continue;
    const list = byTier.get(def.power.priority);
    if (list === undefined) byTier.set(def.power.priority, [consumer]);
    else list.push(consumer);
  }
  for (const list of byTier.values()) list.sort((a, b) => (a.id < b.id ? -1 : 1));
  return byTier;
}

interface Allocation {
  readonly allocation: Map<MachineId, number>;
  /** Supply left over after every tier. */
  readonly remaining: number;
  readonly totalDemand: number;
  /** Demand left unmet. */
  readonly totalShort: number;
}

/** Hand out `supplyKw` tier by tier, proportionally within the tier it runs out in. */
function allocateByTier(
  ctx: StepCtx,
  byTier: ReadonlyMap<PowerPriority, readonly Machine[]>,
  supplyKw: number,
): Allocation {
  const allocation = new Map<MachineId, number>();
  let remaining = supplyKw;
  let totalDemand = 0;
  let totalShort = 0;
  for (const tier of ctx.config.power.priorityOrder) {
    const tierConsumers = byTier.get(tier) ?? [];
    const tierDemand = tierConsumers.reduce((sum, c) => sum + drawKwOf(ctx, c), 0);
    totalDemand += tierDemand;
    if (tierDemand <= 0) continue;
    if (tierDemand <= remaining) {
      for (const c of tierConsumers) allocation.set(c.id, drawKwOf(ctx, c));
      remaining -= tierDemand;
    } else {
      const share = remaining / tierDemand;
      for (const c of tierConsumers) allocation.set(c.id, drawKwOf(ctx, c) * share);
      totalShort += tierDemand - remaining;
      remaining = 0;
    }
  }
  return { allocation, remaining, totalDemand, totalShort };
}

/**
 * Battery: charge from surplus, or discharge to cover the shortfall — never both in one tick.
 * A discharge tops up `allocation` in tier order. Returns the flow (positive while charging).
 */
function runBattery(
  ctx: StepCtx,
  battery: Machine,
  byTier: ReadonlyMap<PowerPriority, readonly Machine[]>,
  { allocation, remaining, totalShort }: Allocation,
  dtSeconds: number,
): number {
  const def = ctx.defs.machine(battery.defId);
  if (def.power.role !== "battery" || battery.roleState.role !== "battery") return 0;
  const stored = battery.roleState.storedKj;
  const { capacityKj } = def.power;
  // §battery-output: a derated bank (a degraded cell) charges and discharges at its output's share
  // of the rated rates; a blocked one (output 0) does neither.
  const maxChargeKw = def.power.maxChargeKw * battery.output;
  const maxDischargeKw = def.power.maxDischargeKw * battery.output;
  const store = (storedKj: number): void => {
    battery.roleState = { role: "battery", storedKj: clamp(storedKj, 0, capacityKj) };
  };
  if (remaining > 1e-9) {
    const roomKj = Math.max(0, capacityKj - stored);
    const chargeKw = Math.min(remaining, maxChargeKw, dtSeconds > 0 ? roomKj / dtSeconds : 0);
    if (chargeKw <= 1e-9) return 0;
    store(stored + chargeKw * dtSeconds);
    return chargeKw;
  }
  if (totalShort <= 1e-9) return 0;
  const availableKw = Math.min(maxDischargeKw, dtSeconds > 0 ? stored / dtSeconds : 0);
  const dischargeKw = Math.min(totalShort, availableKw);
  if (dischargeKw <= 1e-9) return 0;
  store(stored - dischargeKw * dtSeconds);
  let left = dischargeKw;
  for (const tier of ctx.config.power.priorityOrder) {
    if (left <= 1e-9) break;
    for (const c of byTier.get(tier) ?? []) {
      if (left <= 1e-9) break;
      const need = drawKwOf(ctx, c) - (allocation.get(c.id) ?? 0);
      if (need <= 0) continue;
      const give = Math.min(need, left);
      allocation.set(c.id, (allocation.get(c.id) ?? 0) + give);
      left -= give;
    }
  }
  return -dischargeKw;
}

/** A consumer's mode from what it was allocated (off when it wants to be off). */
function applyAllocation(
  ctx: StepCtx,
  consumer: Machine,
  allocation: ReadonlyMap<MachineId, number>,
) {
  const def = ctx.defs.machine(consumer.defId);
  if (def.power.role !== "consumer") return;
  const from = consumer.actualMode;
  if (consumer.desiredMode === "off") {
    consumer.powerAllocatedKw = 0;
    consumer.actualMode = "off";
  } else {
    const allocated = allocation.get(consumer.id) ?? 0;
    consumer.powerAllocatedKw = allocated;
    if (allocated >= def.power.drawKw - 1e-9) {
      consumer.actualMode = "on";
    } else if (allocated <= 1e-9) {
      consumer.actualMode = "off";
    } else {
      consumer.actualMode = def.power.partialPower === "derate" ? "on" : "off";
    }
  }
  if (consumer.actualMode === from) return;
  ctx.emit(
    machineEvent("machineModeChanged", consumer.id, {
      machineId: consumer.id,
      from,
      to: consumer.actualMode,
    }),
  );
}

function allocateDomain(
  ctx: StepCtx,
  domainKey: LocalKey,
  group: DomainGroup,
  dtSeconds: number,
): void {
  const { generators, consumers, battery } = group;
  const supplyKw = generators.reduce((sum, g) => sum + generatedKw(ctx, g), 0);
  const byTier = consumersByTier(ctx, consumers);
  const allocated = allocateByTier(ctx, byTier, supplyKw);
  const batteryFlowKw =
    battery === undefined ? 0 : runBattery(ctx, battery, byTier, allocated, dtSeconds);

  for (const consumer of consumers) applyAllocation(ctx, consumer, allocated.allocation);
  for (const generator of generators) generator.powerAllocatedKw = generatedKw(ctx, generator);
  if (battery !== undefined) battery.powerAllocatedKw = Math.abs(batteryFlowKw);

  const domain = ctx.state.power.domains[domainKey];
  if (domain !== undefined) {
    domain.supplyKw = supplyKw + Math.max(0, -batteryFlowKw);
    domain.demandKw = allocated.totalDemand;
    domain.batteryFlowKw = batteryFlowKw;
  }
}

export const powerSystem: System = {
  name: "power.allocate",
  phase: "topology",
  run(ctx) {
    const dtSeconds = ctx.elapsedTicks / ctx.config.time.tickRate;
    for (const [domainKey, group] of groupByDomain(ctx)) {
      allocateDomain(ctx, domainKey, group, dtSeconds);
    }
    ctx.dirty.power = false;
  },
};

export function registerPowerSystem(registry: KernelRegistry): void {
  registry.registerSystem(powerSystem);
}
