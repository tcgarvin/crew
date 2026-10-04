/** `DeckDef` schema (sim `core/types/content.ts`). Geometry consistency is L3, not here. */
import type { DeckDef } from "@crew/sim";
import { z } from "zod";
import {
  deckDefIdSchema,
  hullSizeClassSchema,
  localKeySchema,
  machineDefIdSchema,
  positiveInt,
  rotationSchema,
  tileCoordSchema,
  tileEdgeSchema,
} from "./primitives";

export const compartmentDefSchema = z.strictObject({
  key: localKeySchema,
  symbol: z.string().length(1).regex(/^\S$/),
  name: z.string().min(1),
  tags: z.array(z.string()),
});

export const doorPlacementDefSchema = z.strictObject({
  key: localKeySchema,
  edge: tileEdgeSchema,
  kind: z.enum(["interior", "ramp"]),
  powerDomain: localKeySchema.exactOptional(),
  manualOperationSupported: z.boolean(),
  initialState: z.enum(["open", "closed"]),
});

export const machinePlacementDefSchema = z.strictObject({
  key: localKeySchema,
  machineDefId: machineDefIdSchema,
  origin: tileCoordSchema,
  rotation: rotationSchema,
  powerDomain: localKeySchema.exactOptional(),
});

export const deckDefSchema = z.strictObject({
  id: deckDefIdSchema,
  name: z.string().min(1),
  width: positiveInt,
  height: positiveInt,
  tiles: z.array(z.string()).min(1),
  compartments: z.array(compartmentDefSchema).min(1),
  doors: z.array(doorPlacementDefSchema),
  openings: z.array(tileEdgeSchema),
  walls: z.array(tileEdgeSchema),
  machines: z.array(machinePlacementDefSchema),
  powerDomains: z.array(z.strictObject({ key: localKeySchema, name: z.string().min(1) })),
  zones: z.array(
    z.strictObject({
      key: localKeySchema,
      name: z.string().min(1),
      tags: z.array(z.string()),
      tiles: z.array(tileCoordSchema).min(1),
      /** The machine placement this zone serves (a `locker` names its bed); checked at L2. */
      machineKey: localKeySchema.exactOptional(),
    }),
  ),
  docking: z.strictObject({
    cargoRampDoorKey: localKeySchema,
    personnelRampDoorKey: localKeySchema,
    cargoTransferTiles: z.array(tileCoordSchema).min(1),
    personnelTransferTiles: z.array(tileCoordSchema).min(1),
  }),
  spawnPoints: z.array(
    z.strictObject({
      key: localKeySchema,
      tile: tileCoordSchema,
      tags: z.array(z.enum(["crew", "passenger", "cargo"])),
    }),
  ),
  /** D72: bow east and ramps south are invariants, not fields; the hull contract checks them. */
  hull: z.strictObject({
    class: z.string().min(1),
    sizeClass: hullSizeClassSchema,
  }),
}) satisfies z.ZodType<DeckDef>;
