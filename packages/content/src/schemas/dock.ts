/**
 * `DockDef` schema (Dockside §3.1; sim `core/types/content.ts`). Shape only: the map's geometry
 * (rows against the legend, the berth box and every deck placed in it, landings, reachability,
 * size) is checked at L3 in `validate-dock.ts`.
 */
import type {
  DockAreaKind,
  DockDef,
  DockForegroundKind,
  DockPostKind,
  DockPropKind,
  DockTileKind,
} from "@crew/sim";
import { z } from "zod";
import {
  type AssertEqual,
  dockDefIdSchema,
  edgeSideSchema,
  hullSizeClassSchema,
  localKeySchema,
  portDefIdSchema,
  positiveInt,
  rotationSchema,
  tileCoordSchema,
  unitInterval,
} from "./primitives";

export const dockTileKindSchema = z.enum(["floor", "wall", "void"]);
export const dockPostKindSchema = z.enum([
  "gate",
  "warehouseDoor",
  "marketStall",
  "kiosk",
  "loungeDoor",
  "bench",
]);
export const dockAreaKindSchema = z.enum(["freightStaging", "deliveryBay"]);
export const dockPropKindSchema = z.enum([
  "crates",
  "container",
  "crane",
  "hullSection",
  "planter",
  "conveyor",
  "bollard",
  "lamp",
  "barrels",
  "rock",
]);
export const dockForegroundKindSchema = z.enum([
  "bayWall",
  "gantry",
  "terminalEdge",
  "awning",
  "rockWall",
]);

const hexColour = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected a #rrggbb colour");

export const dockRectSchema = z.strictObject({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: positiveInt,
  h: positiveInt,
});

export const dockDefSchema = z.strictObject({
  id: dockDefIdSchema,
  portId: portDefIdSchema,
  name: z.string().min(1),
  palette: z.strictObject({
    floor: hexColour,
    wall: hexColour,
    accent: hexColour,
    /** Required when the port is a planet, absent for a station (L2; D61). */
    sky: hexColour.exactOptional(),
  }),
  width: positiveInt,
  height: positiveInt,
  rows: z.array(z.string()).min(1),
  legend: z.record(z.string().length(1), dockTileKindSchema),
  /** D72: the box a docked ship lies in; the box and the ship's place are checked at L3. */
  berth: z.strictObject({
    origin: z.strictObject({ x: z.number().int().min(0), y: z.number().int().min(0) }),
    sizeClass: hullSizeClassSchema,
  }),
  posts: z.array(
    z.strictObject({
      key: localKeySchema,
      kind: dockPostKindSchema,
      name: z.string().min(1),
      tile: tileCoordSchema,
      facing: edgeSideSchema,
    }),
  ),
  areas: z.array(
    z.strictObject({
      key: localKeySchema,
      kind: dockAreaKindSchema,
      rect: dockRectSchema,
    }),
  ),
  props: z.array(
    z.strictObject({
      key: localKeySchema,
      kind: dockPropKindSchema,
      rect: dockRectSchema,
      rot: rotationSchema,
      blocking: z.boolean(),
    }),
  ),
  foreground: z.array(
    z.strictObject({
      kind: dockForegroundKindSchema,
      rect: dockRectSchema,
    }),
  ),
  ambience: z.string().min(1),
  /** D82: how much the floor loads boots, and whether the air settles on the deck (L3: a station's is 0). */
  grime: unitInterval,
  airborneDust: unitInterval,
}) satisfies z.ZodType<DockDef>;

// Drift guards against the sim vocabularies: each must resolve to `true`.
export const DOCK_VOCABULARY_IN_SYNC: [
  AssertEqual<z.infer<typeof dockTileKindSchema>, DockTileKind>,
  AssertEqual<z.infer<typeof dockPostKindSchema>, DockPostKind>,
  AssertEqual<z.infer<typeof dockAreaKindSchema>, DockAreaKind>,
  AssertEqual<z.infer<typeof dockPropKindSchema>, DockPropKind>,
  AssertEqual<z.infer<typeof dockForegroundKindSchema>, DockForegroundKind>,
] = [true, true, true, true, true];
