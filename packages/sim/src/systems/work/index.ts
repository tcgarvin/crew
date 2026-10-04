/**
 * Work (W4a): task derivation, claims, action execution, minimal perception, ambient chat.
 *
 * `registerWork(registry)` installs, in order: the execution system (phase 3; register after
 * `registerSpatial` so it runs after movement), minimal perception and ambient chat (phase 6),
 * derivation + claim expiry (phase 7; register before `registerPlannerDefaults` so tasks exist
 * before planning), and the AgentView builder.
 */
import type { KernelRegistry } from "../../core/registry";
import type { TaskDerivationTable } from "../../core/types/work";
import { registerAgentView } from "../../view/index";
import { ambientChatSystem } from "./ambient";
import {
  type TaskDerivationRegistry,
  createTaskDerivationRegistry,
  defaultTaskDerivations,
} from "./derivation";
import { perceptionSystem } from "./perception";
import { type StageExecutor, equipmentStages } from "./steps";
import { createDerivationSystem, createExecutionSystem } from "./work";

export { AMBIENT_FALLBACK, ambientChatSystem } from "./ambient";
export { activityRef } from "./backoff";
export { abortActivity } from "./execute";
export { equipmentStages, type StageExecutor, type WorkDeps } from "./steps";
export {
  createTaskDerivationRegistry,
  defaultTaskDerivations,
  PROBLEM_KINDS,
  registerTaskDerivation,
  runDerivation,
  type TaskDerivationRegistry,
} from "./derivation";
export { labelFor } from "./labels";
export { observe, perceptionSystem } from "./perception";
export { currentHold, currentStep, isAsleep } from "./activity";

export interface RegisterWorkOptions {
  /**
   * Derivation rules: a registry, or a `Partial<TaskDerivationTable>` (e.g. the spread of
   * `equipmentTaskDerivation`, `travelTaskDerivations`, `commerceTaskDerivations`). Default: the
   * module-level `defaultTaskDerivations` that `registerTaskDerivation` writes to.
   */
  readonly derivations?: TaskDerivationRegistry | Partial<TaskDerivationTable>;
  /** Recipe stage driver. Default: equipment's `advanceStage` (W5). */
  readonly stages?: StageExecutor;
}

export interface WorkRegistration {
  readonly derivations: TaskDerivationRegistry;
  unregister(): void;
}

function isRegistry(value: RegisterWorkOptions["derivations"]): value is TaskDerivationRegistry {
  return value !== undefined && typeof (value as TaskDerivationRegistry).register === "function";
}

export function registerWork(
  registry: KernelRegistry,
  options: RegisterWorkOptions = {},
): WorkRegistration {
  const derivations = isRegistry(options.derivations)
    ? options.derivations
    : options.derivations === undefined
      ? defaultTaskDerivations
      : createTaskDerivationRegistry(options.derivations);
  const undo = [
    registry.registerSystem(createExecutionSystem({ stages: options.stages ?? equipmentStages })),
    registry.registerSystem(perceptionSystem),
    registry.registerSystem(ambientChatSystem),
    registry.registerSystem(createDerivationSystem(derivations)),
    registerAgentView(registry),
  ];
  return {
    derivations,
    unregister() {
      for (const off of undo.reverse()) off();
    },
  };
}
