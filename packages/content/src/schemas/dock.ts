/**
 * `DockDef` schema (Dockside §3.1; sim `core/types/content.ts`). Shape only: the map's geometry
 * (rows against the legend, the berth box and every deck placed in it, landings, reachability,
 * size) is checked at L3 in `validate-dock.ts`.
 */
import type {
  DockAreaKind,
  DockDef,
  DockForegroundKind,
  DockKind,
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
  positive,
  positiveInt,
  rotationSchema,
  tileCoordSchema,
  unitInterval,
} from "./primitives";
import { siteCastEntrySchema } from "./site";

export const dockTileKindSchema = z.enum(["floor", "wall", "void", "cover"]);
export const dockPostKindSchema = z.enum([
  "gate",
  "warehouseDoor",
  "marketStall",
  "kiosk",
  "loungeDoor",
  "bench",
  "target",
  "guard",
  "loot",
  "exit",
  "flank",
  "bystander",
]);
/** Expeditions A1 (§4): a port's dock or a landing site's map (absent = dock). */
export const dockKindSchema = z.enum(["dock", "site"]);
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
    /** Required when the port is a planet, absent for a station (L2; §dock-map-content). */
    sky: hexColour.exactOptional(),
  }),
  width: positiveInt,
  height: positiveInt,
  rows: z.array(z.string()).min(1),
  legend: z.record(z.string().length(1), dockTileKindSchema),
  /**
   * §berth-boxes: the box a docked ship lies in; the box and the ship's place are checked at L3.
   */
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
  /**
   * §footfall-and-boots: how much the floor loads boots, and whether the air settles on the deck
   * (L3: a station's is 0).
   */
  grime: unitInterval,
  airborneDust: unitInterval,
  /** Expeditions A1 (§4): `site` for a landing site's map; absent is a port's dock. */
  kind: dockKindSchema.exactOptional(),
  /** Expeditions A1 (§4): tiles at which the cast notice a party; required on a site (L2). */
  noticeRadius: positive.exactOptional(),
  /** §the-arrival-card: what holding the ramp comes to here (site only, at L2). */
  holdWhy: z.string().min(1).exactOptional(),
  /**
   * Expeditions A1 (§5.3): the cast placed when nobody stages the site (site only; caps and posts
   * at L2 and L3).
   */
  defaultCast: z.array(siteCastEntrySchema).exactOptional(),
}) satisfies z.ZodType<DockDef>;

// Drift guards against the sim vocabularies: each must resolve to `true`.
export const DOCK_VOCABULARY_IN_SYNC: [
  AssertEqual<z.infer<typeof dockTileKindSchema>, DockTileKind>,
  AssertEqual<z.infer<typeof dockPostKindSchema>, DockPostKind>,
  AssertEqual<z.infer<typeof dockAreaKindSchema>, DockAreaKind>,
  AssertEqual<z.infer<typeof dockPropKindSchema>, DockPropKind>,
  AssertEqual<z.infer<typeof dockForegroundKindSchema>, DockForegroundKind>,
  AssertEqual<z.infer<typeof dockKindSchema>, DockKind>,
] = [true, true, true, true, true, true];
