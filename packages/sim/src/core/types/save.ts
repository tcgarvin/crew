/**
 * Save envelope and migrations (SD §20.1, PLAN §3 "Saves").
 */
import type { Tick } from "./common";
import type { ConfigDef, ContentBundle } from "./content";
import type { WorldState } from "./state";

/**
 * What `serialize()` produces and `restore()` accepts. The host gzips and stores it (IndexedDB
 * locally, Neon remotely). Saves happen only at committed tick boundaries.
 *
 * W0 decision: the envelope embeds the full effective `config` (SD §20.1 requires the values, not
 * just the hash); content is referenced by `contentHash` only, plus `state.defs.dynamic`.
 */
export interface SaveEnvelope {
  /** `WorldState.schemaVersion` at save time; drives migrations. */
  readonly schemaVersion: number;
  /** Kernel build identifier (`SIM_VERSION`); informational, for bug reports. */
  readonly simVersion: string;
  readonly contentHash: string;
  readonly configHash: string;
  readonly savedAtTick: Tick;
  readonly config: ConfigDef;
  readonly state: WorldState;
}

/** Kernel build identifier. Bump when pipeline order or system semantics change. */
export const SIM_VERSION = "0.1.0";

/**
 * What a migration may read besides the save: the content it is being restored against (D61:
 * which dock map belongs to the port a save is docked at; D65: which item is the hand truck;
 * D77: the scenario's watch bill), and the config the restored world will run with (the save's
 * own, missing keys filled from that content: `fillConfig`), for D77's watch arithmetic and
 * D78's hazard budget. D83: `warn` reports a note the restored world's owner should see (an old
 * save given stores it never had); `restore` collects them into `RestoredWorld.warnings`. A
 * caller with nobody to tell (the narrator's snapshot upgrade, the narrator-log rebuild) omits it
 * and the notes are dropped.
 */
export interface MigrationContext {
  readonly content: Pick<ContentBundle, "decks" | "docks" | "items" | "scenarios" | "crew">;
  readonly config: ConfigDef;
  readonly warn?: (message: string) => void;
}

/**
 * Upgrades raw state from schema version N to N+1. Pure over its inputs; the state is untrusted
 * JSON.
 */
export type Migration = (state: unknown, context: MigrationContext) => unknown;

/**
 * Keyed by the version a migration upgrades *from*. `restore()` applies them in sequence up to
 * `SCHEMA_VERSION` and throws a clear error on a save newer than the kernel or with a gap.
 */
export type MigrationRegistry = Readonly<Record<number, Migration>>;
