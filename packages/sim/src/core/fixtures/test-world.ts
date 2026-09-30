/** Test helpers: an isolated registry + kernel over the tiny content bundle. */
import { createKernel } from "../kernel";
import { type KernelRegistry, createRegistry } from "../registry";
import type { Command } from "../types/commands";
import type { CommandId } from "../types/ids";
import type { Kernel, World } from "../types/kernel";
import { TINY, tinyConfig, tinyContent, tinyEffectiveConfig } from "./tiny-content";

export interface TestWorld {
  readonly registry: KernelRegistry;
  readonly kernel: Kernel;
  readonly world: World;
}

export function tinyTestWorld(
  options: { quietTooLongSeconds?: number; seed?: number; registry?: KernelRegistry } = {},
): TestWorld {
  const registry = options.registry ?? createRegistry();
  const kernel = createKernel(registry);
  const config = tinyConfig(
    options.quietTooLongSeconds === undefined
      ? {}
      : { quietTooLongSeconds: options.quietTooLongSeconds },
  );
  const world = kernel.createWorld(
    TINY.scenario,
    options.seed ?? 42,
    tinyContent(config),
    tinyEffectiveConfig(config),
  );
  return { registry, kernel, world };
}

let commandCounter = 0;

/** A command with a fresh unique ID. */
export function cmd<C extends Omit<Command, "id">>(command: C): C & { id: CommandId } {
  commandCounter += 1;
  return { ...command, id: `cmd:test:${commandCounter}` as CommandId };
}
