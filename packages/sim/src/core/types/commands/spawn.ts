/**
 * Boundary spawns (review §D.3). Creation only at the edge of observation: port external stores
 * and inbound job manifests before boarding. There is no command that creates anything on deck.
 */
import type { CrewDef, ItemDef } from "../content";
import type { CrewDefId, ItemDefId, JobId, LocalKey, PortDefId, TempRef } from "../ids";

/** New per-game definitions to add to `state.defs.dynamic` (IDs must be in the `gen.` namespace). */
export interface DynamicDefsDraft {
  readonly items: readonly ItemDef[];
  readonly crew: readonly CrewDef[];
}

export type BoundarySpawn =
  | {
      readonly kind: "item";
      readonly tempRef: TempRef;
      readonly itemDefId: ItemDefId;
      readonly count: number;
    }
  | { readonly kind: "npc"; readonly tempRef: TempRef; readonly crewDefId: CrewDefId };

export type BoundaryLocation =
  | { readonly kind: "portStore"; readonly portId: PortDefId; readonly storeKey: LocalKey }
  /** Add to an accepted job's freight while it is still in the origin port warehouse. */
  | { readonly kind: "jobManifest"; readonly jobId: JobId };

export interface SpawnCommandPayloads {
  spawnAtBoundary: {
    readonly defs: DynamicDefsDraft;
    readonly spawns: readonly BoundarySpawn[];
    readonly location: BoundaryLocation;
  };
}
