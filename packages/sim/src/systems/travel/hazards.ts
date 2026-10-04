/**
 * Navigation hazards (D78): the narrator's `scheduleHazard` places one on the leg, and it fires
 * at the first `transit` tick at or after its `fireAtTick`, rolled against whoever has the helm.
 *
 * Owner: W3 of ship life slice 2. Gate B: the command is complete (validation, apply, budget);
 * `hazardsSystem` (phase `equipment`, after travel's state machine) is a no-op until W3 fires
 * them.
 */
import { configTicks } from "../../core/clock";
import { type CommandHandler, NO_TEMP_REFS, causedBy, ok, reject } from "../../core/commands";
import { allocateId } from "../../core/ids";
import { HAZARD_KINDS } from "../../core/types/content";
import type { System } from "../../core/types/pipeline";

/** The piloting-check difficulty range a hazard may have. */
const DIFFICULTY_MIN = 1;
const DIFFICULTY_MAX = 10;

export const scheduleHazard: CommandHandler<"scheduleHazard", null> = {
  validate(ctx, command) {
    const { kind, difficulty, windowTicks } = command.payload;
    if (!(HAZARD_KINDS as readonly string[]).includes(kind)) {
      return reject("invalidPayload", `scheduleHazard: unknown hazard kind "${kind}"`);
    }
    if (
      !Number.isInteger(difficulty) ||
      difficulty < DIFFICULTY_MIN ||
      difficulty > DIFFICULTY_MAX
    ) {
      return reject(
        "invalidPayload",
        `scheduleHazard: difficulty must be an integer in [${DIFFICULTY_MIN}, ${DIFFICULTY_MAX}], got ${difficulty}`,
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
    if (ctx.state.narrator.budget.hazardsRemaining <= 0) {
      return reject("budgetExhausted", "scheduleHazard: narrator hazard budget exhausted");
    }
    const travel = ctx.state.travel;
    if (travel.stage === "docked" && travel.plannedDestinationId === undefined) {
      return reject(
        "preconditionFailed",
        "scheduleHazard: docked with no course planned; a hazard needs a leg to lie on",
      );
    }
    return ok(null);
  },
  apply(ctx, command) {
    const { kind, difficulty, windowTicks } = command.payload;
    const [earliest, latest] = windowTicks;
    const fireAtTick = ctx.rng.int("failures", ctx.tick + earliest, ctx.tick + latest);
    const id = allocateId(ctx.state, "hazard");
    ctx.state.hazards.push({ id, kind, difficulty, fireAtTick, causeCommandId: command.id });
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

/** Fires due hazards in transit. Stub: nothing fires (W3). */
export const hazardsSystem: System = {
  name: "travel.hazards",
  phase: "equipment",
  run() {},
};
