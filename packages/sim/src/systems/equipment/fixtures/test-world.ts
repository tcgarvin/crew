import { tinyConfig } from "../../../core/fixtures/tiny-content";
import { createKernel } from "../../../core/kernel";
import { createRegistry } from "../../../core/registry";
import type { ConfigDef } from "../../../core/types/content";
import type { Kernel, World } from "../../../core/types/kernel";
import { registerEquipmentSystems } from "../register";
import { W5, type W5Overrides, w5Content, w5EffectiveConfig } from "./w5-content";

export interface W5TestWorld {
  readonly kernel: Kernel;
  readonly world: World;
}

/** A world over `w5-content.ts`, with `registerEquipmentSystems` (power + equipment) installed. */
export function w5TestWorld(
  options: { config?: ConfigDef; overrides?: W5Overrides; seed?: number } = {},
): W5TestWorld {
  const registry = createRegistry();
  registerEquipmentSystems(registry);
  const kernel = createKernel(registry);
  const config = options.config ?? tinyConfig();
  const world = kernel.createWorld(
    W5.scenario,
    options.seed ?? 7,
    w5Content(config, options.overrides),
    w5EffectiveConfig(config),
  );
  return { kernel, world };
}
