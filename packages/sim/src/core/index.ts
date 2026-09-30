/**
 * Core kernel (W2): world, clock, ids, rng, events, the tick pipeline, commands, caches,
 * invariants and serialize/restore/migrate. Contracts are in `./types`.
 */
export * from "./types";
export {
  actionLabel,
  describeEvent,
  getRenderFrame,
} from "./render";
export { configTicks, secondsToTicks, ticksToSeconds } from "./clock";
export {
  applyCommandNow,
  type AppliedCommand,
  type ApplyCtx,
  type CommandHandler,
  enqueueCommand,
  executeCommand,
  NO_TEMP_REFS,
  ok,
  reject,
  type ValidateCtx,
  type Validation,
  validateCommand,
} from "./commands";
export { createDefLookup, findCrewDef, findItemDef } from "./defs";
export { createEventBuffer, type EventBuffer, isNotableOrAbove } from "./events";
export {
  allocateId,
  asInstanceId,
  initialIdCounters,
  isInstanceIdOf,
  parseInstanceId,
  wasAllocated,
} from "./ids";
export { checkInvariants, jsonSafetyViolations } from "./invariants";
export { createKernel, kernel } from "./kernel";
export { dueActors, isStaggerDue, runStep } from "./pipeline";
export {
  type AgentViewBuilder,
  type CacheBuilder,
  createRegistry,
  defaultRegistry,
  type KernelRegistry,
  NotImplementedError,
  registerCacheBuilder,
  registerCommandHandler,
  registerPlanner,
  registerSystem,
  setAgentViewBuilder,
} from "./registry";
export { createRngApi, seedAllStreams, seedStream } from "./rng";
export { migrateState, migrations, restore, SaveCompatibilityError, serialize } from "./save";
export { createCompartmentLocator, emptyCaches, rebuildCaches } from "./caches";
export { advance, createWorld, haltReason } from "./world";
