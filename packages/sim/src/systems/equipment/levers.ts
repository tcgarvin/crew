/**
 * §forced-faults-and-hazards, §thought-and-reveal-levers (D106): the narrator's `injectFault` and
 * `reveal`.
 *
 * - `injectFault`: one of the machine's own catalogued faults, now, through the one fault path
 *   (`applyFault`: `faultOccurred` and the symptom problem by the channel's rule). Refused on a
 *   machine that has or awaits it. It spends the fault budget, which is advice and may go below
 *   zero (§narrator-lever-budgets). The scenario's `scenarioInjectFault` stays the fixtures' own.
 * - `reveal`: an active, undiagnosed fault's symptom is noticed. Its symptom problem goes public
 *   (`revealSymptom`), the crew member aboard best at engineering (on their feet, crew not
 *   passengers, ties by id) learns the problem and the symptom as if they had seen it, and
 *   `faultObserved` (notable) gives the log its "Jax Okonkwo noticed a grinding noise from the
 *   pump" line. With nobody on their feet aboard, nobody is named and the problem is public still.
 */
import {
  type ApplyCtx,
  type CommandHandler,
  NO_TEMP_REFS,
  type ValidateCtx,
  causedBy,
  ok,
  reject,
  stepCtxOfApply,
} from "../../core/commands";
import type { Actor } from "../../core/types/actor";
import type { CommandOfKind, CommandRejection } from "../../core/types/commands";
import type { MachineDef } from "../../core/types/content";
import type { Machine } from "../../core/types/ship";
import type { Problem } from "../../core/types/work";
import { shipDeckId } from "../../core/world";
import { directSight, writeFact } from "../work/facts";
import { applyFault, revealSymptom } from "./equipment";

type FaultCommand = CommandOfKind<"injectFault"> | CommandOfKind<"reveal">;

interface Found {
  readonly machine: ValidateCtx["state"]["machines"][keyof ValidateCtx["state"]["machines"]];
  readonly faultDef: MachineDef["faults"][number];
}

/** The machine and the catalogued fault a command names, or why there is none. */
function machineFault(ctx: ValidateCtx, command: FaultCommand): Found | CommandRejection {
  const { machineId, faultKey } = command.payload;
  const machine = ctx.state.machines[machineId];
  if (machine === undefined) return { code: "unknownEntity", reason: `no machine "${machineId}"` };
  const faultDef = ctx.content.machines[machine.defId]?.faults.find((f) => f.key === faultKey);
  if (faultDef === undefined) {
    return { code: "invalidPayload", reason: `machine "${machineId}" has no fault "${faultKey}"` };
  }
  return { machine, faultDef };
}

const isRejection = (found: Found | CommandRejection): found is CommandRejection => "code" in found;

export const injectFault: CommandHandler<"injectFault", null> = {
  validate(ctx, command) {
    const found = machineFault(ctx, command);
    if (isRejection(found)) return reject(found.code, `injectFault: ${found.reason}`);
    const { machine } = found;
    const { faultKey } = command.payload;
    if (
      machine.faults.some((f) => f.faultKey === faultKey) ||
      machine.scheduledFaults.some((f) => f.faultKey === faultKey)
    ) {
      return reject(
        "preconditionFailed",
        `injectFault: ${machine.id} already has or awaits "${faultKey}"`,
      );
    }
    return ok(null);
  },
  apply(ctx, command) {
    const { machineId, faultKey } = command.payload;
    const machine = ctx.state.machines[machineId];
    const def = machine === undefined ? undefined : ctx.content.machines[machine.defId];
    if (machine === undefined || def === undefined) {
      throw new Error(`injectFault: validated machine ${machineId} vanished`);
    }
    applyFault(stepCtxOfApply(ctx), machine, def, faultKey, command.id);
    // §narrator-lever-budgets: advice, never a refusal; it may go below zero.
    ctx.state.narrator.budget.faultsRemaining -= 1;
    return NO_TEMP_REFS;
  },
};

/** The crew member on their feet aboard who is best at engineering, ties by id; or none. */
function bestEngineerAboard(ctx: ApplyCtx): Actor | undefined {
  const deckId = shipDeckId(ctx.state);
  const aboard = Object.values(ctx.state.actors).filter(
    (a) =>
      a.crew &&
      a.passenger !== true &&
      a.availability === "available" &&
      a.location.kind === "onDeck" &&
      a.location.deckId === deckId,
  );
  const skill = (a: Actor) => a.skills.engineering ?? 0;
  return aboard.sort((a, b) => skill(b) - skill(a) || a.id.localeCompare(b.id))[0];
}

/** Write `observer` the facts of having seen the symptom on `machine`. */
function notice(ctx: ApplyCtx, observer: Actor, machine: Machine, problem: Problem): void {
  const sight = directSight(observer, ctx.tick);
  writeFact(
    observer,
    problem.id,
    "problem",
    { problemId: problem.id, revision: problem.revision },
    sight,
  );
  if (problem.kind === "machineSymptom") {
    writeFact(
      observer,
      machine.id,
      "machineSymptom",
      { symptomKey: problem.payload.symptomKey },
      sight,
    );
  }
}

export const reveal: CommandHandler<"reveal", null> = {
  validate(ctx, command) {
    const found = machineFault(ctx, command);
    if (isRejection(found)) return reject(found.code, `reveal: ${found.reason}`);
    const { faultKey } = command.payload;
    const fault = found.machine.faults.find((f) => f.faultKey === faultKey);
    if (fault === undefined) {
      return reject(
        "preconditionFailed",
        `reveal: ${found.machine.id} does not have "${faultKey}" now`,
      );
    }
    if (fault.diagnosed) {
      return reject(
        "preconditionFailed",
        `reveal: "${faultKey}" on ${found.machine.id} is already diagnosed`,
      );
    }
    return ok(null);
  },
  apply(ctx, command) {
    const { machineId, faultKey } = command.payload;
    const machine = ctx.state.machines[machineId];
    const faultDef =
      machine === undefined
        ? undefined
        : ctx.content.machines[machine.defId]?.faults.find((f) => f.key === faultKey);
    if (machine === undefined || faultDef === undefined) {
      throw new Error(`reveal: validated machine ${machineId} or fault ${faultKey} vanished`);
    }
    const problem = revealSymptom(stepCtxOfApply(ctx), machine, faultDef);
    const observer = bestEngineerAboard(ctx);
    if (observer !== undefined) notice(ctx, observer, machine, problem);
    ctx.emit({
      ...causedBy(command),
      type: "faultObserved",
      subjectIds: observer === undefined ? [machineId] : [observer.id, machineId],
      locationRef: { kind: "machine", machineId },
      payload: { machineId, symptomKey: faultDef.symptom.key },
    });
    return NO_TEMP_REFS;
  },
};
