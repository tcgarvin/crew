/**
 * The `Kernel` (types/kernel.ts) bound to a registry. `kernel` uses `defaultRegistry`.
 */
import { enqueueCommand } from "./commands";
import { type KernelRegistry, createRegistry, defaultRegistry } from "./registry";
import { getDirtFrame, getRenderFrame } from "./render";
import { restore, serialize } from "./save";
import type { Kernel } from "./types/kernel";
import { advance, createWorld } from "./world";

export function createKernel(registry: KernelRegistry = createRegistry()): Kernel {
  return {
    createWorld: (scenarioId, seed, content, config) =>
      createWorld(registry, scenarioId, seed, content, config),
    advance: (world, ticks) => advance(world, registry, ticks),
    enqueueCommand: (world, command) => enqueueCommand(world, registry, command),
    getAgentView: (world, actorId) => registry.buildAgentView(world, actorId),
    getRenderFrame,
    getDirtFrame,
    serialize,
    restore: (envelope, content) => restore(envelope, content, registry),
  };
}

export const kernel: Kernel = createKernel(defaultRegistry);
