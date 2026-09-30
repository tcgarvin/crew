/**
 * Serialize / restore / migrate (SD §20.1, CONTRACTS rule 3). Only `state` is saved, plus the
 * effective config and the identities needed to refuse an incompatible restore.
 */
import { emptyCaches, rebuildCaches } from "./caches";
import { checkInvariants } from "./invariants";
import type { KernelRegistry } from "./registry";
import type { ContentBundle } from "./types/content";
import type { RestoredWorld, World } from "./types/kernel";
import { type MigrationRegistry, SIM_VERSION, type SaveEnvelope } from "./types/save";
import { SCHEMA_VERSION, type WorldState } from "./types/state";

/**
 * Migrations keyed by the schema version they upgrade *from*. Empty while `SCHEMA_VERSION` is 1:
 * there is no older schema (before the slice is playable, bumps wipe saves instead).
 * W2 decision: no identity entry at the current version, because by the contract's keying that
 * entry would claim to upgrade the current version to the next one.
 */
export const migrations: MigrationRegistry = {};

export class SaveCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaveCompatibilityError";
  }
}

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function serialize(world: World): SaveEnvelope {
  return {
    schemaVersion: world.state.schemaVersion,
    simVersion: SIM_VERSION,
    contentHash: world.content.hash,
    configHash: world.config.hash,
    savedAtTick: world.state.tick,
    config: deepCopy(world.config.values),
    state: deepCopy(world.state),
  };
}

/** Apply migrations from `fromVersion` up to `targetVersion`. Pure over untrusted JSON. */
export function migrateState(
  raw: unknown,
  fromVersion: number,
  registry: MigrationRegistry = migrations,
  targetVersion: number = SCHEMA_VERSION,
): unknown {
  if (!Number.isInteger(fromVersion) || fromVersion < 0) {
    throw new SaveCompatibilityError(`Save has an invalid schema version: ${String(fromVersion)}`);
  }
  if (fromVersion > targetVersion) {
    throw new SaveCompatibilityError(
      `Save schema version ${fromVersion} is newer than this build supports (${targetVersion}); update the game`,
    );
  }
  let state = raw;
  for (let version = fromVersion; version < targetVersion; version++) {
    const migration = registry[version];
    if (migration === undefined) {
      throw new SaveCompatibilityError(
        `No migration from schema version ${version} to ${version + 1}; this save cannot be loaded`,
      );
    }
    state = migration(state);
    if (typeof state === "object" && state !== null) {
      (state as { schemaVersion: number }).schemaVersion = version + 1;
    }
  }
  return state;
}

export interface RestoreOptions {
  readonly migrations?: MigrationRegistry;
}

/**
 * Migrate, validate and rebuild caches. Throws `SaveCompatibilityError` on an unsupported schema
 * version or a state that fails the invariants.
 *
 * Integration 2: a content hash mismatch is no longer fatal — content tuning between deploys
 * would otherwise wipe every save. The world is restored against the loaded content (the schema
 * version still guards structural compatibility, and the invariants check the result) and the
 * mismatch is reported in `warnings`.
 */
export function restore(
  envelope: SaveEnvelope,
  content: ContentBundle,
  registry: KernelRegistry,
  options: RestoreOptions = {},
): RestoredWorld {
  if (typeof envelope !== "object" || envelope === null || typeof envelope.state !== "object") {
    throw new SaveCompatibilityError("Not a save envelope");
  }
  const warnings: string[] = [];
  if (envelope.contentHash !== content.hash) {
    warnings.push(
      `Save was made with content ${envelope.contentHash}, but content ${content.hash} is loaded; restored against the loaded content`,
    );
  }
  const migrated = migrateState(
    deepCopy(envelope.state),
    envelope.schemaVersion,
    options.migrations ?? migrations,
  );
  if (typeof migrated !== "object" || migrated === null) {
    throw new SaveCompatibilityError("Migrated save state is not an object");
  }
  const state = migrated as WorldState;
  const violations = checkInvariants(state);
  if (violations.length > 0) {
    throw new SaveCompatibilityError(
      `Save state is invalid:\n  ${violations.slice(0, 20).join("\n  ")}`,
    );
  }
  const world: World = {
    state,
    caches: emptyCaches(),
    content,
    config: { values: deepCopy(envelope.config), hash: envelope.configHash },
  };
  rebuildCaches(world, registry);
  return { ...world, warnings };
}
