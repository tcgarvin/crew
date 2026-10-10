/**
 * Departure gate (§departure-gate, 2026-10-01). A planned departure with an impaired `engine` or
 * `generator` raises one policy decision, "Hold for repairs" / "Leave anyway", instead of leaving
 * quietly.
 *
 * Impaired means one of: blocked (`isMachineBlocked`: inoperable fault, temperature at the limit,
 * integrity below `equipment.integrityInoperableBelow`), an unrepaired fault whose effect is
 * `derate` or `inoperable`, or output below `travel.departureMinOutput` while the machine is
 * wanted on. Owner: "careful that we don't bother the player every time a single system isn't
 * 100%": a symptom-only (overheat) fault, condition, and integrity above the derate threshold
 * never count on their own.
 *
 * Asked at most once per voyage (passengers-and-galaxy §2.3; once per docking with no voyage):
 * not while `departureRiskAccepted` is set for the impairment set that is live now
 * (`impairmentKey`), nor while a gate decision is already queued. The set is keyed on each
 * impaired machine and its faults, not on why it counts as impaired this tick, so a new
 * fault or a repair changes the key, drops the answer and asks again, while a machine hovering at
 * its temperature limit (blocked one tick, low on output the next) does not. The decision is
 * queued through `queuePolicyDecision` (§policy-decision-hook: the kernel narrates it before
 * showing it); the chosen side's command (`holdDepartureForRepairs` / `acceptDepartureRisk`,
 * `command-handlers.ts`) sets the travel flag the gate reads next tick.
 *
 * §repairs-out-of-reach: the gate never waits on a repair that cannot finish. An impairment is *out
 * of reach* when one of the machine's diagnosed faults that keeps it impaired is short of a tool or
 * parts that nothing aboard supplies and the market at the port the ship is at cannot sell
 * (`repairOutOfReach`, `equipment/supplies.ts`). The card offers a hold only for impairments in
 * reach; when none is left, there is nothing to choose: the departure goes ahead, any hold ends,
 * and `departureRepairOutOfReach` says why, per machine ("No welder torch aboard and none to be had
 * at Kessler Drift: leaving with the fusion generator's electrical short unrepaired"). It is
 * remembered as "leave anyway" is, against the live impairment set, so it is said once, and a new
 * fault or a repair asks again. An undiagnosed fault is still work aboard (diagnosis needs no
 * tool), so the gate waits for the diagnosis before it judges.
 *
 * §impairments-out-of-reach: an impairment with no fault of its own that another machine's
 * impairment causes (an engine starved of power by a derated generator, a machine overheating with
 * every coolant pump on its bus down) is in reach only if its cause is; the reason told is the
 * cause's fault, once.
 */
import { queuePolicyDecision } from "../../core/decisions";
import type { Actor } from "../../core/types/actor";
import type { MachineDef } from "../../core/types/content";
import type { LocalKey, MachineId, PortDefId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { Machine } from "../../core/types/ship";
import type { TravelState } from "../../core/types/travel";
import { isMachineBlocked } from "../equipment/equipment";
import { type RepairOutOfReach, repairOutOfReach } from "../equipment/supplies";
import { domainKeyOf } from "../power/power";
import { commandActor } from "./roster";

/** Allocation this close to a consumer's draw is full power, not starvation (float noise). */
const POWER_SLACK = 1e-6;

/** Prompt key of the gate card; `@crew/content` `templates.ts` renders it. */
const DEPARTURE_GATE_PROMPT_KEY = "travel.departureGate";

/**
 * Why a machine counts as impaired, worst first. `faultDerated` is a `fault` whose output is
 * already below 1 (the card says so in words); the two are the same severity.
 */
export type ImpairmentReason = "blocked" | "faultDerated" | "fault" | "lowOutput";

interface Impairment {
  readonly machineId: MachineId;
  readonly machineName: string;
  readonly reason: ImpairmentReason;
  readonly output: number;
  /** Every fault on the machine, whatever its effect: what `impairmentKey` remembers. */
  readonly faultKeys: readonly LocalKey[];
}

const SEVERITY: Readonly<Record<ImpairmentReason, number>> = {
  blocked: 3,
  faultDerated: 2,
  fault: 2,
  lowOutput: 1,
};

/** What the gate reads: truth, content and the thresholds in config. */
type GateCtx = Pick<StepCtx, "state" | "content" | "config">;

/** The kind of effect a fault on this machine has, per its def. */
function effectKind(def: MachineDef, fault: Machine["faults"][number]) {
  return def.faults.find((d) => d.key === fault.faultKey)?.effect.kind;
}

function impairmentOf(ctx: GateCtx, machine: Machine, def: MachineDef): Impairment | undefined {
  const base = {
    machineId: machine.id,
    machineName: def.name,
    output: machine.output,
    faultKeys: machine.faults.map((fault) => fault.faultKey),
  };
  if (isMachineBlocked(machine, def, ctx.config.equipment)) return { ...base, reason: "blocked" };
  const disablingFault = machine.faults.some((fault) => {
    const kind = effectKind(def, fault);
    return kind === "derate" || kind === "inoperable";
  });
  if (disablingFault) {
    return { ...base, reason: machine.output < 1 ? "faultDerated" : "fault" };
  }
  if (machine.desiredMode === "on" && machine.output < ctx.config.travel.departureMinOutput) {
    return { ...base, reason: "lowOutput" };
  }
  return undefined;
}

/** Every impairment among `engine`/`generator` machines, in machine key order. */
function impairments(ctx: GateCtx): Impairment[] {
  const found: Impairment[] = [];
  for (const machine of Object.values(ctx.state.machines)) {
    const def = ctx.content.machines[machine.defId];
    if (def === undefined) continue;
    if (!def.tags.includes("engine") && !def.tags.includes("generator")) continue;
    const impairment = impairmentOf(ctx, machine, def);
    if (impairment !== undefined) found.push(impairment);
  }
  return found;
}

/**
 * The impaired set as one string (`machineId:faultKey+faultKey`, faults sorted, machines sorted,
 * comma-joined; "" when nothing is impaired). "Leave anyway" is remembered against this, so a new
 * fault or a repair re-asks. It names every fault on the machine, not the momentary reason
 * nor `heldForFaults` (which depends on the reason): an overheat fault at its temperature limit
 * flips the reason between `blocked` and `lowOutput` or `faultDerated` every few ticks, and a key
 * that followed it dropped the answer and raised the card again each time.
 */
export function impairmentKey(ctx: GateCtx): string {
  return impairments(ctx)
    .map((i) => `${i.machineId}:${[...i.faultKeys].sort().join("+")}`)
    .sort()
    .join(",");
}

/**
 * The faults that keep an impaired machine impaired, as far as a repair goes: every `derate` or
 * `inoperable` fault, and an `overheat` fault while the machine is blocked or low on output (the
 * heat, and the integrity it costs, are what stop it). Repairing a symptom-only fault on a machine
 * impaired for another reason would not clear the impairment, so it does not decide the hold.
 */
function heldForFaults(machine: Machine, def: MachineDef, reason: ImpairmentReason): Set<LocalKey> {
  const overheatCounts = reason === "blocked" || reason === "lowOutput";
  const keys = new Set<LocalKey>();
  for (const fault of machine.faults) {
    const kind = effectKind(def, fault);
    if (kind === "derate" || kind === "inoperable" || (kind === "overheat" && overheatCounts)) {
      keys.add(fault.faultKey);
    }
  }
  return keys;
}

/** The port whose market a hold could buy from: where the ship is docked or casting off. */
function portHere(ctx: Pick<StepCtx, "state">): PortDefId | undefined {
  const travel = ctx.state.travel;
  if (travel.stage === "docked") return travel.portId;
  if (travel.stage === "preparingDeparture") return travel.fromPortId;
  return undefined;
}

/** Where the planned departure is bound: the course set while docked, or the leg under way. */
function departureBound(travel: TravelState): PortDefId | undefined {
  return travel.stage === "docked" ? travel.plannedDestinationId : travel.toPortId;
}

/**
 * §repairs-out-of-reach: why `machineId`'s impairment cannot be cleared by a repair the crew can do
 * with what is aboard and what the market at `portId` sells now (`undefined`: no market, as under
 * way), or `undefined` when it can, or when the machine is not impaired. The gate asks it of the
 * port the ship is at; the limp (§limping-under-way) asks it under way.
 */
export function impairmentOutOfReach(
  ctx: GateCtx,
  machineId: MachineId,
  portId: PortDefId | undefined,
): RepairOutOfReach | undefined {
  return outOfReach(ctx, machineId, portId, new Set());
}

function outOfReach(
  ctx: GateCtx,
  machineId: MachineId,
  portId: PortDefId | undefined,
  seen: Set<MachineId>,
): RepairOutOfReach | undefined {
  const machine = ctx.state.machines[machineId];
  const def = machine === undefined ? undefined : ctx.content.machines[machine.defId];
  if (machine === undefined || def === undefined || seen.has(machineId)) return undefined;
  seen.add(machineId);
  const impairment = impairmentOf(ctx, machine, def);
  if (impairment === undefined) return undefined;
  const faultKeys = heldForFaults(machine, def, impairment.reason);
  if (faultKeys.size > 0) {
    return repairOutOfReach(ctx.state, ctx.content, machine, def, faultKeys, portId);
  }
  // §impairments-out-of-reach: no fault of its own. Starved by another machine's impairment, it is
  // in reach only if that cause is: every cause out of reach puts it out of reach, naming the first
  // cause's fault. No cause found (integrity alone, an overloaded bus, a cycle) keeps the plain
  // answer: in reach.
  const causes = impairedCauses(ctx, machine, def);
  let first: RepairOutOfReach | undefined;
  for (const cause of causes) {
    const why = outOfReach(ctx, cause.id, portId, seen);
    if (why === undefined) return undefined;
    first ??= why;
  }
  return first;
}

/**
 * §impairments-out-of-reach: the impaired machines a fault-free impairment comes from. Power: a
 * consumer allocated less than its draw is starved by its domain's impaired generators. Coolant: a
 * machine hot enough to derate (or blocked at its limit) on a domain whose `"cooling"` machines are
 * all off is overheating for want of them (equipment's coolant rule), so the impaired ones among
 * them are its causes. In machine id order.
 */
function impairedCauses(ctx: GateCtx, machine: Machine, def: MachineDef): Machine[] {
  const domain = domainKeyOf(ctx, machine);
  if (domain === undefined) return [];
  const sameDomain = Object.values(ctx.state.machines)
    .filter((m) => m.id !== machine.id && domainKeyOf(ctx, m) === domain)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const impaired = (m: Machine): boolean => {
    const mDef = ctx.content.machines[m.defId];
    return mDef !== undefined && impairmentOf(ctx, m, mDef) !== undefined;
  };
  const causes = new Set<Machine>();
  const starved =
    def.power.role === "consumer" &&
    def.power.drawKw > 0 &&
    machine.powerAllocatedKw < def.power.drawKw * (1 - POWER_SLACK);
  if (starved) {
    for (const m of sameDomain) {
      if (ctx.content.machines[m.defId]?.power.role === "generator" && impaired(m)) causes.add(m);
    }
  }
  const coolers = sameDomain.filter((m) => ctx.content.machines[m.defId]?.tags.includes("cooling"));
  const hot = machine.temperature >= 1 || machine.temperature > def.heat.derateAbove;
  if (hot && coolers.length > 0 && coolers.every((m) => m.actualMode !== "on")) {
    for (const m of coolers) if (impaired(m)) causes.add(m);
  }
  return [...causes];
}

function worstOf(found: readonly Impairment[]): Impairment | undefined {
  let worst: Impairment | undefined;
  for (const candidate of found) {
    if (
      worst === undefined ||
      SEVERITY[candidate.reason] > SEVERITY[worst.reason] ||
      (SEVERITY[candidate.reason] === SEVERITY[worst.reason] && candidate.output < worst.output)
    ) {
      worst = candidate;
    }
  }
  return worst;
}

/** A gate card is already queued (pending) for the captain. */
function gateDecisionPending(ctx: Pick<StepCtx, "state">): boolean {
  const { records, queue } = ctx.state.decisions;
  return queue.some((id) => {
    const decision = records[id];
    return decision?.status === "pending" && decision.prompt.key === DEPARTURE_GATE_PROMPT_KEY;
  });
}

/**
 * §spoken-cards: the card is spoken by the crew member tagged `engineer`, when the ship has one.
 */
function engineerName(ctx: Pick<StepCtx, "state">): string | undefined {
  const actors = Object.values(ctx.state.actors) as Actor[];
  return actors.find((a) => a.crew && a.roleTags.includes("engineer"))?.name;
}

function raiseDepartureGate(ctx: StepCtx, impairment: Impairment): void {
  const speaker = engineerName(ctx);
  queuePolicyDecision(ctx, {
    perspectiveActorId: commandActor(ctx.state),
    prompt: {
      key: DEPARTURE_GATE_PROMPT_KEY,
      params: {
        machineId: impairment.machineId,
        machine: impairment.machineName,
        reason: impairment.reason,
        ...(speaker === undefined ? {} : { speaker }),
      },
    },
    left: {
      label: { key: "travel.departureGate.hold", params: {} },
      commands: [{ kind: "holdDepartureForRepairs", payload: { machineId: impairment.machineId } }],
      aftermath: { key: "travel.departureGate.hold.aftermath", params: {} },
    },
    right: {
      label: { key: "travel.departureGate.leave", params: {} },
      commands: [{ kind: "acceptDepartureRisk", payload: { machineId: impairment.machineId } }],
      aftermath: { key: "travel.departureGate.leave.aftermath", params: {} },
    },
    machineId: impairment.machineId,
  });
}

/**
 * May the planned departure go ahead this tick? Raises the gate card (once per docking) when an
 * engine/generator is impaired, waits while a hold is in force, and lifts the hold (with a
 * `departureHoldLifted` event) the tick nothing is impaired any more. The card is raised
 * for the worst impairment whose repair is in reach, and with none in reach the departure goes
 * ahead (ending any hold) with a `departureRepairOutOfReach` per machine instead.
 */
export function departureCleared(ctx: StepCtx): boolean {
  const travel = ctx.state.travel;
  if (travel.departureRiskAccepted === true) {
    const key = travel.acceptedImpairmentKey;
    if (key === undefined || key === impairmentKey(ctx)) return true;
    // The impaired set changed since "leave anyway" (a new fault, or a repair): ask again.
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete travel.departureRiskAccepted;
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete travel.acceptedImpairmentKey;
  }
  const found = impairments(ctx);
  if (found.length === 0) {
    if (travel.holdForRepairs === true) {
      // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
      delete travel.holdForRepairs;
      const toPortId = departureBound(travel);
      if (toPortId !== undefined) {
        ctx.emit({
          type: "departureHoldLifted",
          subjectIds: [],
          causeIds: [],
          source: "sim",
          payload: { toPortId },
        });
      }
    }
    return true;
  }
  // The card on the table is answered first; a hold it starts is judged from the next tick.
  if (gateDecisionPending(ctx)) return false;
  const outOfReach = new Map<Impairment, RepairOutOfReach>();
  for (const impairment of found) {
    const why = impairmentOutOfReach(ctx, impairment.machineId, portHere(ctx));
    if (why !== undefined) outOfReach.set(impairment, why);
  }
  const inReach = worstOf(found.filter((i) => !outOfReach.has(i)));
  if (inReach === undefined) {
    leaveWithRepairsOutOfReach(ctx, outOfReach);
    return true;
  }
  if (travel.holdForRepairs === true) return false;
  raiseDepartureGate(ctx, inReach);
  return false;
}

/**
 * §repairs-out-of-reach: every impairment left is out of reach here, so the departure goes ahead: a
 * hold ends, each machine's reason is told (`departureRepairOutOfReach`, narrative, a narrator hook
 * in the default config), and the gate remembers the set as answered so it is told once.
 */
function leaveWithRepairsOutOfReach(
  ctx: StepCtx,
  outOfReach: ReadonlyMap<Impairment, RepairOutOfReach>,
): void {
  const travel = ctx.state.travel;
  const portId = portHere(ctx);
  const toPortId = departureBound(travel);
  const heldForRepairs = travel.holdForRepairs === true;
  // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
  delete travel.holdForRepairs;
  travel.departureRiskAccepted = true;
  travel.acceptedImpairmentKey = impairmentKey(ctx);
  if (portId === undefined || toPortId === undefined) return;
  // §impairments-out-of-reach: told per fault out of reach, so an engine starved by the generator's
  // burnt-out coil is the generator's story, told once.
  const told = new Set<string>();
  for (const why of outOfReach.values()) {
    const key = `${why.machineId}:${why.faultKey}`;
    if (told.has(key)) continue;
    told.add(key);
    ctx.emit({
      type: "departureRepairOutOfReach",
      subjectIds: [why.machineId],
      causeIds: [],
      source: "sim",
      locationRef: { kind: "machine", machineId: why.machineId },
      payload: {
        machineId: why.machineId,
        faultKey: why.faultKey,
        itemDefId: why.itemDefId,
        need: why.need,
        portId,
        toPortId,
        heldForRepairs,
      },
    });
  }
}
