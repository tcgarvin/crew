/**
 * §scheduling-a-field: the narrator's `scheduleField` (slice 5 calls 2, 19, 20). Validation is
 * complete here (the kernel revalidates at apply, so every rule holds at both moments); apply
 * places the field on the leg, `scheduled`, with its start sampled in the window on the `failures`
 * stream exactly as `scheduleHazard` samples its fire tick, and never sooner than
 * `field.warningSeconds` away, so the helm's check (that long before the start) is never already
 * past.
 *
 * The rules: a known severity and detection; a window as `scheduleHazard`'s; at most
 * `field.maxScripted` scripted impacts, each inside the severity's length, aimed at a machine,
 * compartment or footprint tile of the ship's deck (never a person until bodies, slice 6); one
 * field per leg (`state.field` absent); a course planned or the ship under way with transit
 * ahead; the ship not lost; and the guard: the scripted impacts alone, an unsized rock priced
 * `large`, must leave the hull above zero.
 *
 * Owner: W1 of ship life slice 5.
 */
import { configTicks } from "../../core/clock";
import {
  type CommandHandler,
  NO_TEMP_REFS,
  type ValidateCtx,
  causedBy,
  ok,
  reject,
} from "../../core/commands";
import { inHullFootprint } from "../../core/hull";
import { allocateId } from "../../core/ids";
import type { CommandOfKind, CommandRejection } from "../../core/types/commands";
import {
  FIELD_DETECTIONS,
  FIELD_SEVERITIES,
  MACHINE_EFFECTS,
  ROCK_SIZES,
} from "../../core/types/content";
import type { ScriptedImpactDraft } from "../../core/types/state";
import { shipDeckId } from "../../core/world";

type Payload = CommandOfKind<"scheduleField">["payload"];

const includes = (list: readonly string[], value: unknown): boolean =>
  typeof value === "string" && list.includes(value);

const fail = (code: CommandRejection["code"], reason: string) =>
  reject(code, `scheduleField: ${reason}`);

/** Why the window is unusable, or undefined. Same bounds as `scheduleHazard`. */
function windowProblem(ctx: ValidateCtx, windowTicks: Payload["windowTicks"]) {
  if (!Array.isArray(windowTicks) || windowTicks.length !== 2) {
    return fail("invalidPayload", "windowTicks must be [earliest, latest]");
  }
  const [earliest, latest] = windowTicks;
  if (
    !Number.isInteger(earliest) ||
    !Number.isInteger(latest) ||
    earliest < 0 ||
    latest < earliest
  ) {
    return fail(
      "invalidPayload",
      "windowTicks must be [earliest, latest] with 0 <= earliest <= latest",
    );
  }
  const maxWindow = configTicks(ctx.config, ctx.config.narrator.maxFaultWindowSeconds);
  if (latest - earliest > maxWindow) {
    return fail("outOfBounds", `window ${latest - earliest} ticks exceeds max ${maxWindow}`);
  }
  return undefined;
}

/** Why one scripted impact is unusable, or undefined. */
function scriptedProblem(
  ctx: ValidateCtx,
  impact: ScriptedImpactDraft,
  index: number,
  lengthSeconds: number,
) {
  const where = `scripted[${index}]`;
  if (
    typeof impact.atSeconds !== "number" ||
    !Number.isFinite(impact.atSeconds) ||
    impact.atSeconds < 0 ||
    impact.atSeconds >= lengthSeconds
  ) {
    return fail(
      "outOfBounds",
      `${where}.atSeconds must be in [0, ${lengthSeconds}) (the field's length), got ${impact.atSeconds}`,
    );
  }
  if (impact.rock !== undefined && !includes(ROCK_SIZES, impact.rock)) {
    return fail("invalidPayload", `${where}: unknown rock "${impact.rock}"`);
  }
  if (impact.effect !== undefined && !includes(MACHINE_EFFECTS, impact.effect)) {
    return fail("invalidPayload", `${where}: unknown effect "${impact.effect}"`);
  }
  const deckId = shipDeckId(ctx.state);
  const target = impact.target;
  switch (target?.kind) {
    case "machine": {
      const machine = ctx.state.machines[target.machineId];
      if (machine === undefined || machine.deckId !== deckId) {
        return fail("unknownEntity", `${where}: no machine ${target.machineId} aboard`);
      }
      return undefined;
    }
    case "compartment": {
      const compartment = ctx.state.compartments[target.compartmentId];
      if (compartment === undefined || compartment.deckId !== deckId) {
        return fail("unknownEntity", `${where}: no compartment ${target.compartmentId} aboard`);
      }
      return undefined;
    }
    case "tile": {
      const deck = ctx.content.decks[deckId];
      if (deck === undefined || !inHullFootprint(deck, target.x, target.y)) {
        return fail("outOfBounds", `${where}: (${target.x}, ${target.y}) is not on the hull`);
      }
      return undefined;
    }
    case "actor":
      return fail(
        "invalidPayload",
        `${where}: people are not targets until bodies (slice 6); aim at a machine or a room`,
      );
    default:
      return fail("invalidPayload", `${where}: target must be a machine, compartment or tile`);
  }
}

/** Why the leg cannot take a field now, or undefined (call 19, `scheduleHazard`'s rules). */
function legProblem(ctx: ValidateCtx) {
  if (ctx.state.hull.lostAtTick !== undefined)
    return fail("preconditionFailed", "the ship is lost");
  if (ctx.state.field !== undefined) {
    return fail("preconditionFailed", "this leg already has its field (one per leg)");
  }
  const travel = ctx.state.travel;
  if (travel.stage === "docked" && travel.plannedDestinationId === undefined) {
    return fail("preconditionFailed", "docked with no course planned; a field needs a leg");
  }
  if (travel.stage === "approaching" || travel.stage === "docking") {
    return fail("preconditionFailed", `the leg's transit is over (${travel.stage})`);
  }
  return undefined;
}

/**
 * The guard (call 20): hull points the scripted impacts would cost, an unsized rock priced
 * `large`. Must stay below the hull's integrity.
 */
export function scriptedHullDamage(
  config: ValidateCtx["config"],
  scripted: readonly ScriptedImpactDraft[],
): number {
  return scripted.reduce((sum, impact) => sum + config.field.hullDamage[impact.rock ?? "large"], 0);
}

export const scheduleField: CommandHandler<"scheduleField", null> = {
  validate(ctx, command) {
    const { severity, detection, windowTicks, scripted } = command.payload;
    if (!includes(FIELD_SEVERITIES, severity)) {
      return fail("invalidPayload", `unknown severity "${severity}"`);
    }
    if (!includes(FIELD_DETECTIONS, detection)) {
      return fail("invalidPayload", `unknown detection "${detection}"`);
    }
    const window = windowProblem(ctx, windowTicks);
    if (window !== undefined) return window;
    if (!Array.isArray(scripted)) return fail("invalidPayload", "scripted must be a list");
    const maxScripted = ctx.config.field.maxScripted;
    if (scripted.length > maxScripted) {
      return fail("outOfBounds", `at most ${maxScripted} scripted impacts, got ${scripted.length}`);
    }
    const lengthSeconds = ctx.config.field.severities[severity].lengthSeconds;
    for (const [index, impact] of scripted.entries()) {
      const problem = scriptedProblem(ctx, impact, index, lengthSeconds);
      if (problem !== undefined) return problem;
    }
    const leg = legProblem(ctx);
    if (leg !== undefined) return leg;
    const scriptedDamage = scriptedHullDamage(ctx.config, scripted);
    if (scriptedDamage >= ctx.state.hull.integrity) {
      return fail(
        "preconditionFailed",
        `scripted impacts alone would sink the ship (${scriptedDamage} hull points against ${ctx.state.hull.integrity} left)`,
      );
    }
    return ok(null);
  },
  apply(ctx, command) {
    const { severity, detection, windowTicks, scripted } = command.payload;
    const [earliest, latest] = windowTicks;
    const sampled = ctx.rng.int("failures", ctx.tick + earliest, ctx.tick + latest);
    // The helm's check falls `field.warningSeconds` before the start and must not be in the past
    // (`field.ts`): a start sampled inside the warning moves out to its end.
    const warningTicks = configTicks(ctx.config, ctx.config.field.warningSeconds);
    const startsAtTick = Math.max(sampled, ctx.tick + warningTicks);
    const id = allocateId(ctx.state, "field");
    ctx.state.field = {
      id,
      severity,
      detection,
      startsAtTick,
      phase: { kind: "scheduled" },
      impacts: 0,
      stuckImpacts: 0,
      hullLost: 0,
      scripted: [...scripted]
        .map((impact) => ({ ...impact, target: { ...impact.target } }))
        .sort((a, b) => a.atSeconds - b.atSeconds),
      causeCommandId: command.id,
    };
    ctx.emit({
      ...causedBy(command),
      type: "fieldScheduled",
      subjectIds: [id],
      payload: { fieldId: id, severity, detection, scripted: scripted.length },
    });
    return NO_TEMP_REFS;
  },
};
