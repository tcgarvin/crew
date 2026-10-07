/**
 * Kernel public API (SD §19.1). Implemented by W2 in `core/`; hosts (the web worker, the CLI,
 * tests) depend only on this interface.
 */
import type { Command, EnqueueResult } from "./commands";
import type { ConfigDef, ContentBundle } from "./content";
import type { SimEvent } from "./events";
import type { ActorId, ScenarioDefId } from "./ids";
import type { DerivedCaches } from "./pipeline";
import type { SaveEnvelope } from "./save";
import type { WorldState } from "./state";
import type { AgentView, DirtFrame, RenderFrame } from "./view";

/**
 * Config plus the hash computed at content build time. W0 decision: the kernel has no hashing
 * dependency, so the config hash travels with the config instead of being computed in `sim`.
 */
export interface EffectiveConfig {
  readonly values: ConfigDef;
  readonly hash: string;
}

/**
 * The live runtime. Only `state` is authoritative and serialized; `caches` are rebuilt on
 * restore; `content` is the static bundle (by hash); `config` is the effective config.
 */
export interface World {
  readonly state: WorldState;
  readonly caches: DerivedCaches;
  readonly content: ContentBundle;
  readonly config: EffectiveConfig;
}

/**
 * What `restore` returns: the world plus non-fatal compatibility notes (Integration 2 addition;
 * e.g. the save was made with different content). A `RestoredWorld` is a `World`.
 */
export interface RestoredWorld extends World {
  readonly warnings: readonly string[];
}

/** Why `advance()` stopped before running every requested tick. */
export type AdvanceHalt =
  | { readonly kind: "completed" }
  /** A narrator hook is pending (D5); host must call the narrator then `acknowledgeHook`. */
  | { readonly kind: "hook" }
  /** A decision is pending; host pauses until `resolveDecision`. */
  | { readonly kind: "decision" }
  /** D93: the hull gave way (`hull.lostAtTick`); the world never steps again. */
  | { readonly kind: "lost" };

/**
 * W0 decision: `advance` returns a result object rather than a bare event array, so the host
 * learns why it stopped early (hook or decision) without re-inspecting state.
 */
export interface AdvanceResult {
  readonly events: readonly SimEvent[];
  readonly ticksAdvanced: number;
  readonly halt: AdvanceHalt;
}

export interface Kernel {
  /**
   * Build a fresh world from a scenario in `content`. W0 decision: the scenario is passed by ID and
   * `config` separately, so tuning sweeps can override `content.config` without a new bundle.
   */
  createWorld(
    scenarioId: ScenarioDefId,
    seed: number,
    content: ContentBundle,
    config: EffectiveConfig,
  ): World;
  /**
   * Run up to `ticks` steps. Stops early (after completing the tick) when a hook is raised or a
   * decision becomes pending; returns immediately while either is already pending.
   */
  advance(world: World, ticks: number): AdvanceResult;
  /** Validate and queue. No state change on rejection. */
  enqueueCommand(world: World, command: Command): EnqueueResult;
  /** Planner-boundary view for one actor, e.g. for tests and the inspector. */
  getAgentView(world: World, actorId: ActorId): AgentView;
  getRenderFrame(world: World): RenderFrame;
  /** D82: the ship deck's dirt grid for the grime tint; posted by the host at its own cadence. */
  getDirtFrame(world: World): DirtFrame;
  serialize(world: World): SaveEnvelope;
  /**
   * Migrate, validate and rebuild caches. Throws on an unsupported schema version or invalid
   * state; a content hash mismatch restores anyway and is reported in `warnings`.
   */
  restore(envelope: SaveEnvelope, content: ContentBundle): RestoredWorld;
}
