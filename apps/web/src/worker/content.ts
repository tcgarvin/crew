import { loadBundle } from "@crew/content";
/**
 * Loads and validates the authored `@crew/content` bundle once per worker instance, and derives
 * the `EffectiveConfig` the kernel needs. Integration 1: replaces the mock content constants.
 */
import type { ContentBundle, EffectiveConfig, ScenarioDefId } from "@crew/sim";

export interface LoadedContent {
  readonly bundle: ContentBundle;
  readonly config: EffectiveConfig;
  readonly scenarioId: ScenarioDefId;
}

let cached: LoadedContent | undefined;

/**
 * Validates and returns the authored bundle. Throws if `@crew/content`'s L1-L3 validation
 * fails — a broken bundle should not silently produce a broken world.
 */
export function loadWebContent(): LoadedContent {
  if (cached) return cached;
  const result = loadBundle();
  if (!result.ok) {
    const detail = result.issues
      .map((issue) => `[${issue.level}] ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`@crew/content bundle failed validation:\n${detail}`);
  }
  const bundle = result.bundle;
  const scenarioIds = Object.keys(bundle.scenarios) as ScenarioDefId[];
  const scenarioId = scenarioIds[0];
  if (scenarioId === undefined) {
    throw new Error("@crew/content bundle has no scenarios");
  }
  cached = {
    bundle,
    // W0 decision (Integration 1): the bundle hash stands in for a dedicated config hash — the
    // config lives inside the bundle and there is exactly one authored config in V1.
    config: { values: bundle.config, hash: bundle.hash },
    scenarioId,
  };
  return cached;
}
