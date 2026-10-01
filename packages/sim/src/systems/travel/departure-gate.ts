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
 * Asked at most once per docking: not while `departureRiskAccepted` is set, nor while a gate
 * decision is already queued. The decision is queued through `queuePolicyDecision` (D37: the
 * kernel narrates it before showing it); the chosen side's command (`holdDepartureForRepairs` /
 * `acceptDepartureRisk`, `command-handlers.ts`) sets the travel flag the gate reads next tick.
 */
import { queuePolicyDecision } from "../../core/decisions";
import type { Actor } from "../../core/types/actor";
import type { MachineDef } from "../../core/types/content";
import type { MachineId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { Machine } from "../../core/types/ship";
import { isMachineBlocked } from "../equipment/equipment";
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

function impairmentOf(ctx: StepCtx, machine: Machine, def: MachineDef): Impairment | undefined {
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

/** The most serious impairment among `engine`/`generator` machines, or none. */
export function worstImpairment(ctx: StepCtx): Impairment | undefined {
  let worst: Impairment | undefined;
  for (const machine of Object.values(ctx.state.machines)) {
    const def = ctx.content.machines[machine.defId];
    if (def === undefined) continue;
    if (!def.tags.includes("engine") && !def.tags.includes("generator")) continue;
    const found = impairmentOf(ctx, machine, def);
    if (found === undefined) continue;
    if (
      worst === undefined ||
      SEVERITY[found.reason] > SEVERITY[worst.reason] ||
      (SEVERITY[found.reason] === SEVERITY[worst.reason] && found.output < worst.output)
    ) {
      worst = found;
    }
  }
  return worst;
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
 * `departureHoldLifted` event) the tick nothing is impaired any more.
 */
export function departureCleared(ctx: StepCtx): boolean {
  const travel = ctx.state.travel;
  if (travel.departureRiskAccepted === true) return true;
  const impairment = worstImpairment(ctx);
  if (impairment === undefined) {
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
  if (travel.holdForRepairs === true) return false;
  if (gateDecisionPending(ctx)) return false;
  raiseDepartureGate(ctx, impairment);
  return false;
}
