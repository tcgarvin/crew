#!/usr/bin/env -S npx tsx
/**
 * One-off (ship life slice 1, §orientation-and-size): mirror a deck JSON in x so a bow-west deck
 * faces east, the hull contract's orientation. Rewrites the file in place.
 *
 *   npx tsx scripts/mirror-deck.mts packages/content/data/decks/freighter-mk1.json
 *
 * Every x becomes `width - 1 - x`: tile rows, door, opening and wall edges (sides `e` and `w`
 * swap), zone tiles, spawn tiles and transfer tiles, each list in its original order. Machines
 * are re-placed from their mirrored absolute footprint: a def whose footprint and interaction
 * offsets (at the placement's rotation) are symmetric in x keeps its rotation; any other turns
 * 180 degrees, which also flips its y offsets (content validation decides whether those land on
 * floor). Machine defs are read from `packages/content/data/machines/`. Throws, writing nothing,
 * if a machine cannot be re-placed onto exactly its mirrored footprint.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Side = "n" | "e" | "s" | "w";
type Rotation = 0 | 90 | 180 | 270;
interface Coord {
  x: number;
  y: number;
}
interface Edge extends Coord {
  side: Side;
}
interface MachineDefJson {
  id: string;
  footprint: Coord[];
  interactionPositions: { key: string; offset: Coord }[];
}
interface PlacementJson {
  key: string;
  machineDefId: string;
  origin: Coord;
  rotation: Rotation;
}
interface DeckJson {
  id: string;
  width: number;
  tiles: string[];
  doors: { key: string; edge: Edge }[];
  openings: Edge[];
  walls: Edge[];
  machines: PlacementJson[];
  zones: { key: string; tiles: Coord[] }[];
  docking: { cargoTransferTiles: Coord[]; personnelTransferTiles: Coord[] };
  spawnPoints: { key: string; tile: Coord }[];
}

const MIRRORED_SIDE: Readonly<Record<Side, Side>> = { n: "n", e: "w", s: "s", w: "e" };

/** Mirrors sim `rotateOffset` (`systems/spatial/geometry.ts`). */
function rotate(offset: Coord, rotation: Rotation): Coord {
  switch (rotation) {
    case 0:
      return { x: offset.x, y: offset.y };
    case 90:
      return { x: -offset.y + 0, y: offset.x + 0 };
    case 180:
      return { x: -offset.x + 0, y: -offset.y + 0 };
    case 270:
      return { x: offset.y + 0, y: -offset.x + 0 };
  }
}

const key = (c: Coord) => `${c.x},${c.y}`;

function sameSet(a: readonly Coord[], b: readonly Coord[]): boolean {
  const keys = new Set(a.map(key));
  return a.length === b.length && b.every((c) => keys.has(key(c)));
}

/** Footprint and interaction offsets at `rotation` map onto themselves under an x flip. */
function symmetricInX(def: MachineDefJson, rotation: Rotation): boolean {
  const footprint = def.footprint.map((o) => rotate(o, rotation));
  const xs = footprint.map((o) => o.x);
  const axis = Math.min(...xs) + Math.max(...xs);
  const flip = (o: Coord) => ({ x: axis - o.x, y: o.y });
  if (!sameSet(footprint, footprint.map(flip))) return false;
  return def.interactionPositions.every((p) => {
    const o = rotate(p.offset, rotation);
    return key(flip(o)) === key(o);
  });
}

function loadMachineDefs(dir: string): Map<string, MachineDefJson> {
  const defs = new Map<string, MachineDefJson>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const def = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as MachineDefJson;
    defs.set(def.id, def);
  }
  return defs;
}

function mirrorPlacement(
  placement: PlacementJson,
  def: MachineDefJson,
  mirrorX: (x: number) => number,
): PlacementJson {
  const absolute = def.footprint.map((o) => {
    const r = rotate(o, placement.rotation);
    return { x: placement.origin.x + r.x, y: placement.origin.y + r.y };
  });
  const target = absolute.map((c) => ({ x: mirrorX(c.x), y: c.y }));
  const rotation = symmetricInX(def, placement.rotation)
    ? placement.rotation
    : (((placement.rotation + 180) % 360) as Rotation);
  const offsets = def.footprint.map((o) => rotate(o, rotation));
  const minOf = (cs: readonly Coord[], axis: "x" | "y") => Math.min(...cs.map((c) => c[axis]));
  const origin = {
    x: minOf(target, "x") - minOf(offsets, "x"),
    y: minOf(target, "y") - minOf(offsets, "y"),
  };
  const placed = offsets.map((o) => ({ x: origin.x + o.x, y: origin.y + o.y }));
  if (!sameSet(placed, target)) {
    throw new Error(`Machine "${placement.key}" cannot be re-placed onto its mirrored footprint`);
  }
  return { ...placement, origin, rotation };
}

function mirrorDeck(deck: DeckJson, machineDefs: Map<string, MachineDefJson>): DeckJson {
  const mirrorX = (x: number) => deck.width - 1 - x;
  const tile = (c: Coord): Coord => ({ x: mirrorX(c.x), y: c.y });
  const edge = (e: Edge): Edge => ({ x: mirrorX(e.x), y: e.y, side: MIRRORED_SIDE[e.side] });
  return {
    ...deck,
    tiles: deck.tiles.map((row) => [...row].reverse().join("")),
    doors: deck.doors.map((door) => ({ ...door, edge: edge(door.edge) })),
    openings: deck.openings.map(edge),
    walls: deck.walls.map(edge),
    machines: deck.machines.map((placement) => {
      const def = machineDefs.get(placement.machineDefId);
      if (def === undefined) throw new Error(`Unknown machine def "${placement.machineDefId}"`);
      return mirrorPlacement(placement, def, mirrorX);
    }),
    zones: deck.zones.map((zone) => ({ ...zone, tiles: zone.tiles.map(tile) })),
    docking: {
      ...deck.docking,
      cargoTransferTiles: deck.docking.cargoTransferTiles.map(tile),
      personnelTransferTiles: deck.docking.personnelTransferTiles.map(tile),
    },
    spawnPoints: deck.spawnPoints.map((spawn) => ({ ...spawn, tile: tile(spawn.tile) })),
  };
}

const [file] = process.argv.slice(2);
if (file === undefined) throw new Error("usage: mirror-deck.mts <deck.json>");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const machineDefs = loadMachineDefs(path.join(root, "packages/content/data/machines"));
const deck = JSON.parse(readFileSync(file, "utf8")) as DeckJson;
writeFileSync(file, `${JSON.stringify(mirrorDeck(deck, machineDefs), null, 2)}\n`);
console.log(`mirrored ${deck.id} (${deck.machines.length} machines) in ${file}`);
