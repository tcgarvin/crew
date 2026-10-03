/**
 * Dockside §2.7 (phase 2): what the camera frames. In flight, the ship with a margin for scenery;
 * docked, the ship plus the dock map; in between, an ease driven by `Scene.cameraT`, which
 * `sceneAt` derives from stage progress during `docking` and `undocking`, so the framing is a pure
 * function of the frame like the rest of the port-bound scenery.
 */
import type { DockDef } from "@crew/sim";
import { dockRectOnDeck } from "./dock";
import type { Bounds, HullGeometry } from "./hull";

/** Margin around the hull in flight, tiles: room for scenery to show past the ship (D58). */
export const FLIGHT_MARGIN_TILES = 1;
/** Margin around ship plus dock when docked: the map's own edges frame it. */
export const DOCKED_MARGIN_TILES = 0.25;

function grow(b: Bounds, by: number): Bounds {
  return { minX: b.minX - by, minY: b.minY - by, maxX: b.maxX + by, maxY: b.maxY + by };
}

function union(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/** Dockside §2.7: in flight the camera frames the whole hull, nose to bells, with a margin. */
export function flightBounds(hull: Pick<HullGeometry, "bounds">): Bounds {
  return grow(hull.bounds, FLIGHT_MARGIN_TILES);
}

/** Dockside §2.7: docked, it fits the ship and the dock map. Without a map, the flight framing. */
export function dockedBounds(
  hull: Pick<HullGeometry, "bounds">,
  dock: Pick<DockDef, "shipAt" | "width" | "height"> | undefined,
): Bounds {
  if (dock === undefined) return flightBounds(hull);
  return grow(union(hull.bounds, dockRectOnDeck(dock)), DOCKED_MARGIN_TILES);
}

/**
 * What the camera frames at `cameraT` (0 flight, 1 docked; `sceneAt` eases it with stage progress
 * during `docking` and `undocking`). Each edge is interpolated, so the picture zooms smoothly
 * and is a pure function of the frame, like the rest of the port-bound scenery.
 */
export function cameraBounds(
  hull: Pick<HullGeometry, "bounds">,
  dock: Pick<DockDef, "shipAt" | "width" | "height"> | undefined,
  cameraT: number,
): Bounds {
  const from = flightBounds(hull);
  const to = dockedBounds(hull, dock);
  const t = Math.min(1, Math.max(0, cameraT));
  const at = (a: number, b: number) => a + (b - a) * t;
  return {
    minX: at(from.minX, to.minX),
    minY: at(from.minY, to.minY),
    maxX: at(from.maxX, to.maxX),
    maxY: at(from.maxY, to.maxY),
  };
}
