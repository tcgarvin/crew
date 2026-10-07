/**
 * Steps of damage work (D93, D94): `runMend` (integrity up at `1 / repairSecondsPerIntegrity` a
 * second, `machineMended` at whole), `runPatch` (a kit consumed, `patchRecovers` of the scar back,
 * `hullPatched`), `runPlate` (a plate consumed, the scar cleared, `hullPlated`), `runCheck` (a
 * look round), and the bridge hold's end (`bridgeHoldDone`: the alert has cleared).
 *
 * Gate stubs: the plans that reach these are blocked, so a runner is never entered; each throws
 * if it is.
 *
 * Owner: W2 of ship life slice 5.
 */
import { NotImplementedError } from "../../core/registry";
import type { Actor } from "../../core/types/actor";
import type { StepCtx } from "../../core/types/pipeline";
import type { ActivityStep } from "../../core/types/work";
import type { StepResult } from "../work/steps";

type WorkStep = Extract<ActivityStep, { kind: "work" }>;
type HoldStep = Extract<ActivityStep, { kind: "hold" }>;

export function runMend(_ctx: StepCtx, _actor: Actor, _step: WorkStep): StepResult {
  throw new NotImplementedError("damage: runMend");
}

export function runPatch(_ctx: StepCtx, _actor: Actor, _step: WorkStep): StepResult {
  throw new NotImplementedError("damage: runPatch");
}

export function runPlate(_ctx: StepCtx, _actor: Actor, _step: WorkStep): StepResult {
  throw new NotImplementedError("damage: runPlate");
}

export function runCheck(_ctx: StepCtx, _actor: Actor, _step: WorkStep): StepResult {
  throw new NotImplementedError("damage: runCheck");
}

/** The officer of the watch's bridge hold ends when the alert has cleared. */
export function bridgeHoldDone(ctx: StepCtx, _actor: Actor, _step: HoldStep): boolean {
  return ctx.state.alert === undefined;
}
