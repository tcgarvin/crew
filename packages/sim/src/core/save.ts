/**
 * Serialize / restore / migrate (SD §20.1, CONTRACTS rule 3). Only `state` is saved, plus the
 * effective config and the identities needed to refuse an incompatible restore.
 */
import { emptyCaches, rebuildCaches } from "./caches";
import { checkInvariants } from "./invariants";
import { migrations } from "./migrations";
import type { KernelRegistry } from "./registry";
import { SaveCompatibilityError } from "./save-error";
import type { ConfigDef, ContentBundle } from "./types/content";
import type { RestoredWorld, World } from "./types/kernel";
import {
  type MigrationContext,
  type MigrationRegistry,
  SIM_VERSION,
  type SaveEnvelope,
} from "./types/save";
import { SCHEMA_VERSION, type WorldState } from "./types/state";

/**
 * Migrations keyed by the schema version they upgrade *from* (`./migrations`).
 * W2 decision: no identity entry at the current version, because by the contract's keying that
 * entry would claim to upgrade the current version to the next one.
 */
export { migrations } from "./migrations";

export { SaveCompatibilityError } from "./save-error";

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
  context: MigrationContext,
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
    state = migration(state, context);
    if (typeof state === "object" && state !== null) {
      (state as { schemaVersion: number }).schemaVersion = version + 1;
    }
  }
  return state;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The saved config with every key it lacks taken from `defaults` (the loaded content's config),
 * recursing into objects; `filled` collects the paths taken. A save keeps the config it was made
 * with (SD §20.1), but a key added since (D58's `doors.rampOpenSeconds`, D61's
 * `travel.recallAboardSeconds`) would otherwise read as `undefined` and turn timers into NaN.
 * Values the save does have always win. A key renamed since (D76's day units:
 * `needs.mealSeconds` → `needs.mealDays`) is a missing key here, so the new name takes the loaded
 * value and the stale one is carried along unread.
 */
function withMissingConfig<T>(saved: T, defaults: T, path: string, filled: string[]): T {
  if (!isPlainObject(saved) || !isPlainObject(defaults)) return saved;
  const out: Record<string, unknown> = { ...saved };
  for (const [key, value] of Object.entries(defaults)) {
    const here = `${path}.${key}`;
    if (!(key in out)) {
      out[key] = deepCopy(value);
      filled.push(here);
    } else {
      out[key] = withMissingConfig(out[key], value, here, filled);
    }
  }
  return out as T;
}

/**
 * A saved config (a save envelope's, or a narrator snapshot's) with every key it lacks filled
 * from `defaults`, the loaded content's config, and the dotted paths that were filled.
 */
export function fillConfig(
  saved: ConfigDef,
  defaults: ConfigDef,
): { readonly values: ConfigDef; readonly filled: readonly string[] } {
  const filled: string[] = [];
  const values = withMissingConfig(deepCopy(saved), defaults, "config", filled);
  return { values, filled };
}

interface RestoreOptions {
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
  const { values, filled } = fillConfig(envelope.config, content.config);
  const migrated = migrateState(
    deepCopy(envelope.state),
    envelope.schemaVersion,
    { content, config: values },
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
  if (filled.length > 0) {
    warnings.push(
      `Save's config predates ${filled.join(", ")}; restored with the loaded content's values`,
    );
  }
  const world: World = {
    state,
    caches: emptyCaches(),
    content,
    config: { values, hash: envelope.configHash },
  };
  rebuildCaches(world, registry);
  return { ...world, warnings };
}
