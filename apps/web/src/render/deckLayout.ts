/**
 * Static deck geometry for the canvas, derived once from the authored `DeckDef`
 * (`@crew/content`'s bundle) instead of the old hardcoded mock geometry (Integration 1, task item
 * 4). `DeckDef.tiles` is per-tile (a compact string grid), so the layout is per-tile too — simpler
 * and correct for non-rectangular compartments, at the cost of a few extra fill calls.
 */
import type {
  ContentBundle,
  DeckDef,
  LocalKey,
  MachineDefId,
  TileCoord,
  TileEdge,
} from "@crew/sim";
import { rotateOffset } from "@crew/sim";

export interface LayoutTile {
  readonly x: number;
  readonly y: number;
  /** `undefined` = void (non-navigable, not drawn as floor). */
  readonly compartmentKey: string | undefined;
}

export interface LayoutDoor {
  readonly placementKey: LocalKey;
  readonly kind: "interior" | "ramp";
  readonly cx: number;
  readonly cy: number;
  readonly orientation: "horizontal" | "vertical";
}

export interface LayoutMachine {
  readonly placementKey: LocalKey;
  readonly defId: MachineDefId;
  readonly name: string;
  readonly footprint: readonly TileCoord[];
  readonly center: { readonly x: number; readonly y: number };
}

export interface DeckLayout {
  readonly deckId: DeckDef["id"];
  readonly width: number;
  readonly height: number;
  readonly tiles: readonly LayoutTile[];
  readonly compartmentNames: Readonly<Record<string, string>>;
  readonly compartmentBounds: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  readonly doors: readonly LayoutDoor[];
  readonly machines: readonly LayoutMachine[];
}

function doorCentre(edge: TileEdge): {
  cx: number;
  cy: number;
  orientation: "horizontal" | "vertical";
} {
  switch (edge.side) {
    case "n":
      return { cx: edge.x + 0.5, cy: edge.y, orientation: "horizontal" };
    case "s":
      return { cx: edge.x + 0.5, cy: edge.y + 1, orientation: "horizontal" };
    case "w":
      return { cx: edge.x, cy: edge.y + 0.5, orientation: "vertical" };
    case "e":
      return { cx: edge.x + 1, cy: edge.y + 0.5, orientation: "vertical" };
  }
}

/** Builds the canvas layout for one deck. Pure; safe to call once and cache on the main thread. */
export function buildDeckLayout(deck: DeckDef, content: ContentBundle): DeckLayout {
  const symbolToKey = new Map(deck.compartments.map((c) => [c.symbol, c.key] as const));
  const compartmentNames: Record<string, string> = {};
  for (const c of deck.compartments) compartmentNames[c.key] = c.name;

  const tiles: LayoutTile[] = [];
  const compartmentBounds: Record<string, { x: number; y: number }> = {};
  for (let y = 0; y < deck.height; y++) {
    const row = deck.tiles[y] ?? "";
    for (let x = 0; x < deck.width; x++) {
      const symbol = row[x] ?? " ";
      const compartmentKey = symbol === " " ? undefined : symbolToKey.get(symbol);
      tiles.push({ x, y, compartmentKey });
      if (compartmentKey !== undefined) {
        const bound = compartmentBounds[compartmentKey];
        if (bound === undefined || y < bound.y || (y === bound.y && x < bound.x)) {
          compartmentBounds[compartmentKey] = { x, y };
        }
      }
    }
  }

  const doors: LayoutDoor[] = deck.doors.map((d) => {
    const { cx, cy, orientation } = doorCentre(d.edge);
    return { placementKey: d.key, kind: d.kind, cx, cy, orientation };
  });

  const machines: LayoutMachine[] = deck.machines.map((placement) => {
    const def = content.machines[placement.machineDefId];
    const footprintOffsets = def?.footprint ?? [{ x: 0, y: 0 }];
    const footprint = footprintOffsets.map((offset) => {
      const rotated = rotateOffset(offset, placement.rotation);
      return { x: placement.origin.x + rotated.x, y: placement.origin.y + rotated.y };
    });
    const cx = footprint.reduce((sum, t) => sum + t.x + 0.5, 0) / footprint.length;
    const cy = footprint.reduce((sum, t) => sum + t.y + 0.5, 0) / footprint.length;
    return {
      placementKey: placement.key,
      defId: placement.machineDefId,
      name: def?.name ?? placement.machineDefId,
      footprint,
      center: { x: cx, y: cy },
    };
  });

  return {
    deckId: deck.id,
    width: deck.width,
    height: deck.height,
    tiles,
    compartmentNames,
    compartmentBounds,
    doors,
    machines,
  };
}
