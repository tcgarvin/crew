/**
 * Power allocation (SD §9.3, docs/CONTRACTS.md, phase "topology"). Groups each power domain's
 * machines, sums generator supply, allocates it to consumers by authored priority tier
 * (`config.power.priorityOrder`), proportionally within a tier, then tops up a shortfall from —
 * or banks a surplus into — one battery per domain.
 *
 * // W5 decision: recomputes every domain every tick instead of gating on `ctx.dirty.power` /
 * mode-change detection (the perf optimisation asked for in the brief). V1 ships are small
 * (D12 thin slice) so the full recompute is cheap and avoids adding a new derived-cache field
 * just to remember "did anything change". `ctx.dirty.power` is still cleared at the end so a
 * future gate can be layered on without another contract change.
 *
 * // W5 decision: a machine whose `MachinePlacementDef.powerDomain` is absent, or whose def's
 * `power.role` is `"none"`, is not touched by this system at all: no allocation, no mode change.
 */
import type { KernelRegistry } from "../../core/registry";
import type { PowerPriority } from "../../core/types/content";
import type { EventDraft } from "../../core/types/events";
import type { DeckDefId, LocalKey, MachineId } from "../../core/types/ids";
import type { StepCtx, System } from "../../core/types/pipeline";
import type { Machine, OperatingMode } from "../../core/types/ship";
import { clamp } from "../equipment/util";

interface DomainGroup {
  generators: Machine[];
  consumers: Machine[];
  battery: Machine | undefined;
}

/** The power domain a machine's placement names, or `undefined` if it is not on any bus. */
export function domainKeyOf(ctx: StepCtx, machine: Machine): LocalKey | undefined {
  const deck = ctx.content.decks[machine.deckId as DeckDefId];
  const placement = deck?.machines.find((p) => p.key === machine.placementKey);
  return placement?.powerDomain;
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

function emitModeChange(ctx: StepCtx, machine: Machine, from: OperatingMode): void {
  if (machine.actualMode === from) return;
  const draft: EventDraft = {
    type: "machineModeChanged",
    subjectIds: [machine.id],
    causeIds: [],
    source: "sim",
    locationRef: { kind: "machine", machineId: machine.id },
    payload: { machineId: machine.id, from, to: machine.actualMode },
  };
  ctx.emit(draft);
}

function drawKwOf(ctx: StepCtx, machine: Machine): number {
  const def = ctx.defs.machine(machine.defId);
  return def.power.role === "consumer" ? def.power.drawKw : 0;
}

function allocateDomain(
  ctx: StepCtx,
  domainKey: LocalKey,
  group: DomainGroup,
  dtSeconds: number,
): void {
  const { generators, consumers, battery } = group;

  const supplyKw = generators.reduce((sum, g) => {
    const def = ctx.defs.machine(g.defId);
    if (def.power.role !== "generator" || g.actualMode === "off") return sum;
    return sum + def.power.supplyKw * g.output;
  }, 0);

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

  // Battery: charge from surplus, or discharge to cover the shortfall — never both in one tick.
  let batteryFlowKw = 0;
  if (battery !== undefined) {
    const def = ctx.defs.machine(battery.defId);
    if (def.power.role === "battery" && battery.roleState.role === "battery") {
      const stored = battery.roleState.storedKj;
      if (remaining > 1e-9) {
        const roomKj = Math.max(0, def.power.capacityKj - stored);
        const chargeKw = Math.min(
          remaining,
          def.power.maxChargeKw,
          dtSeconds > 0 ? roomKj / dtSeconds : 0,
        );
        if (chargeKw > 1e-9) {
          battery.roleState = {
            role: "battery",
            storedKj: clamp(stored + chargeKw * dtSeconds, 0, def.power.capacityKj),
          };
          batteryFlowKw = chargeKw;
        }
      } else if (totalShort > 1e-9) {
        const availableKw = Math.min(
          def.power.maxDischargeKw,
          dtSeconds > 0 ? stored / dtSeconds : 0,
        );
        let dischargeKw = Math.min(totalShort, availableKw);
        if (dischargeKw > 1e-9) {
          battery.roleState = {
            role: "battery",
            storedKj: clamp(stored - dischargeKw * dtSeconds, 0, def.power.capacityKj),
          };
          batteryFlowKw = -dischargeKw;
          for (const tier of ctx.config.power.priorityOrder) {
            if (dischargeKw <= 1e-9) break;
            for (const c of byTier.get(tier) ?? []) {
              if (dischargeKw <= 1e-9) break;
              const need = drawKwOf(ctx, c) - (allocation.get(c.id) ?? 0);
              if (need <= 0) continue;
              const give = Math.min(need, dischargeKw);
              allocation.set(c.id, (allocation.get(c.id) ?? 0) + give);
              dischargeKw -= give;
            }
          }
        }
      }
    }
  }

  for (const consumer of consumers) {
    const def = ctx.defs.machine(consumer.defId);
    if (def.power.role !== "consumer") continue;
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
    emitModeChange(ctx, consumer, from);
  }
  for (const generator of generators) {
    const def = ctx.defs.machine(generator.defId);
    generator.powerAllocatedKw =
      def.power.role === "generator" && generator.actualMode !== "off"
        ? def.power.supplyKw * generator.output
        : 0;
  }
  if (battery !== undefined) battery.powerAllocatedKw = Math.abs(batteryFlowKw);

  const domain = ctx.state.power.domains[domainKey];
  if (domain !== undefined) {
    domain.supplyKw = supplyKw + Math.max(0, -batteryFlowKw);
    domain.demandKw = totalDemand;
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
