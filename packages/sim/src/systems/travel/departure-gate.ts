/**
 * Departure gate (D36, 2026-10-01). A planned departure with an impaired `engine` or `generator`
 * raises one policy decision, "Hold for repairs" / "Leave anyway", instead of leaving quietly.
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
 * (`impairmentKey`), nor while a gate decision is already queued. A new fault or a repair
 * changes the key, drops the answer and asks again. The decision is queued through
 * `queuePolicyDecision` (D37: the kernel narrates it before showing it); the chosen side's
 * command (`holdDepartureForRepairs` / `acceptDepartureRisk`, `command-handlers.ts`) sets the
 * travel flag the gate reads next tick.
 *
 * D71: the gate never waits on a repair that cannot finish. An impairment is *out of reach* when
 * one of the machine's diagnosed faults that keeps it impaired is short of a tool or parts that
 * nothing aboard supplies and the market at the port the ship is at cannot sell
 * (`repairOutOfReach`, `equipment/supplies.ts`). The card offers a hold only for impairments in
 * reach; when none is left, there is nothing to choose: the departure goes ahead, any hold ends,
 * and `departureRepairOutOfReach` says why, per machine ("No welder torch aboard and none to be
 * had at Kessler Drift: leaving with the fusion generator's electrical short unrepaired"). It is
 * remembered as "leave anyway" is, against the live impairment set, so it is said once, and a
 * new fault or a repair asks again. An undiagnosed fault is still work aboard (diagnosis needs no
 * tool), so the gate waits for the diagnosis before it judges.
 */
import { queuePolicyDecision } from "../../core/decisions";
import type { Actor } from "../../core/types/actor";
import type { MachineDef } from "../../core/types/content";
import type { LocalKey, MachineId, PortDefId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { Machine } from "../../core/types/ship";
import { isMachineBlocked } from "../equipment/equipment";
import { type RepairOutOfReach, repairOutOfReach } from "../equipment/supplies";
import { commandActor } from "./roster";

/** Prompt key of the gate card; `@crew/content` `templates.ts` renders it. */
export const DEPARTURE_GATE_PROMPT_KEY = "travel.departureGate";

/**
 * Why a machine counts as impaired, worst first. `faultDerated` is a `fault` whose output is
 * already below 1 (the card says so in words); the two are the same severity.
 */
export type ImpairmentReason = "blocked" | "faultDerated" | "fault" | "lowOutput";

export interface Impairment {
  readonly machineId: MachineId;
  readonly machineName: string;
  readonly reason: ImpairmentReason;
  readonly output: number;
}

const SEVERITY: Readonly<Record<ImpairmentReason, number>> = {
  blocked: 3,
  faultDerated: 2,
  fault: 2,
  lowOutput: 1,
};

/** What the gate reads: truth, content and the thresholds in config. */
export type GateCtx = Pick<StepCtx, "state" | "content" | "config">;

function impairmentOf(ctx: GateCtx, machine: Machine, def: MachineDef): Impairment | undefined {
  const base = { machineId: machine.id, machineName: def.name, output: machine.output };
  if (isMachineBlocked(machine, def, ctx.config.equipment)) return { ...base, reason: "blocked" };
  const disablingFault = machine.faults.some((fault) => {
    const kind = def.faults.find((d) => d.key === fault.faultKey)?.effect.kind;
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
export function impairments(ctx: GateCtx): Impairment[] {
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
 * The impaired set as one string (`machineId:reason`, sorted, comma-joined; "" when nothing is
 * impaired). "Leave anyway" is remembered against this, so a new fault or a repair re-asks.
 */
export function impairmentKey(ctx: GateCtx): string {
  return impairments(ctx)
    .map((i) => `${i.machineId}:${i.reason}`)
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
    const kind = def.faults.find((d) => d.key === fault.faultKey)?.effect.kind;
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

/** D71: why holding for `impairment` would never end, or `undefined` when its repair can finish. */
export function impairmentOutOfReach(
  ctx: GateCtx,
  impairment: Impairment,
): RepairOutOfReach | undefined {
  const machine = ctx.state.machines[impairment.machineId];
  const def = machine === undefined ? undefined : ctx.content.machines[machine.defId];
  if (machine === undefined || def === undefined) return undefined;
  const faultKeys = heldForFaults(machine, def, impairment.reason);
  if (faultKeys.size === 0) return undefined;
  return repairOutOfReach(ctx.state, ctx.content, machine, def, faultKeys, portHere(ctx));
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

/** The most serious impairment among `engine`/`generator` machines, or none. */
export function worstImpairment(ctx: GateCtx): Impairment | undefined {
  return worstOf(impairments(ctx));
}

/** A gate card is already queued (pending) for the captain. */
export function gateDecisionPending(ctx: Pick<StepCtx, "state">): boolean {
  const { records, queue } = ctx.state.decisions;
  return queue.some((id) => {
    const decision = records[id];
    return decision?.status === "pending" && decision.prompt.key === DEPARTURE_GATE_PROMPT_KEY;
  });
}

/** D29: the card is spoken by the crew member tagged `engineer`, when the ship has one. */
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
 * `departureHoldLifted` event) the tick nothing is impaired any more. D71: the card is raised
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
      const toPortId = travel.stage === "docked" ? travel.plannedDestinationId : travel.toPortId;
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
    const why = impairmentOutOfReach(ctx, impairment);
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
 * D71: every impairment left is out of reach here, so the departure goes ahead: a hold ends,
 * each machine's reason is told (`departureRepairOutOfReach`, narrative, a narrator hook in the
 * default config), and the gate remembers the set as answered so it is told once.
 */
function leaveWithRepairsOutOfReach(
  ctx: StepCtx,
  outOfReach: ReadonlyMap<Impairment, RepairOutOfReach>,
): void {
  const travel = ctx.state.travel;
  const portId = portHere(ctx);
  const toPortId = travel.stage === "docked" ? travel.plannedDestinationId : travel.toPortId;
  const heldForRepairs = travel.holdForRepairs === true;
  // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
  delete travel.holdForRepairs;
  travel.departureRiskAccepted = true;
  travel.acceptedImpairmentKey = impairmentKey(ctx);
  if (portId === undefined || toPortId === undefined) return;
  for (const [impairment, why] of outOfReach) {
    ctx.emit({
      type: "departureRepairOutOfReach",
      subjectIds: [impairment.machineId],
      causeIds: [],
      source: "sim",
      locationRef: { kind: "machine", machineId: impairment.machineId },
      payload: {
        machineId: impairment.machineId,
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
