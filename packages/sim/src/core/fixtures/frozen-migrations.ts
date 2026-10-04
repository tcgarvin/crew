/**
 * D74: every save older than schema 7 is refused (`migrations[6]` throws), so the frozen 1 → 6
 * migrations no longer run in play. Their tests still run them end to end, against states built
 * by today's world, by restoring with this registry: the same chain, with the refusal replaced by
 * a pass-through.
 */
import type { KernelRegistry } from "../registry";
import { migrations, restore } from "../save";
import type { ContentBundle } from "../types/content";
import type { RestoredWorld } from "../types/kernel";
import type { MigrationRegistry, SaveEnvelope } from "../types/save";

export const THROUGH_SCHEMA_6: MigrationRegistry = { ...migrations, 6: (raw) => raw };

/** `restore` through the frozen chain (see the module comment). */
export function restoreThroughSchema6(
  envelope: SaveEnvelope,
  content: ContentBundle,
  registry: KernelRegistry,
): RestoredWorld {
  return restore(envelope, content, registry, { migrations: THROUGH_SCHEMA_6 });
}
