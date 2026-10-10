#!/usr/bin/env -S npx tsx
/**
 * One-off (ship life slice 1, §orientation-and-size): convert a dock map from drawn `berth` tiles
 * and `shipAt` to an M-class `berth` box. Rewrites the file in place.
 *
 *   npx tsx scripts/convert-dock-berth.mts packages/content/data/docks/crossroads-hub.json
 *
 * The box (36 x 20) is placed so that `berthPlacement` puts the 32 x 18 Freighter Mk1 where
 * `shipAt` had it: origin = shipAt - (2, 2), clamped to the map's width (Tern's Rest keeps its
 * width, so its ship moves one tile east). The two box rows above the ship must not take an
 * existing row with a wall in it (a bay wall stays a wall): void rows are inserted just above the
 * ship until they need not, and every post, area, prop and foreground rect at or below the
 * insertion shifts down (or grows, if it straddles it). Then every tile inside the box becomes
 * void, the `berth` legend entry goes, and a prop inside the box is dropped with a log line.
 */
import { readFileSync, writeFileSync } from "node:fs";

interface Coord {
  x: number;
  y: number;
}
interface Rect extends Coord {
  w: number;
  h: number;
}
interface DockJson {
  id: string;
  width: number;
  height: number;
  rows: string[];
  legend: Record<string, string>;
  shipAt?: Coord;
  posts: { key: string; tile: Coord }[];
  areas: { key: string; rect: Rect }[];
  props: { key: string; rect: Rect }[];
  foreground: { kind: string; rect: Rect }[];
  [field: string]: unknown;
}

/** Mirrors `HULL_SIZE_BOX.M`; the Mk1 footprint is 32 x 18, so the margins are 2 and 2. */
const BOX = { w: 36, h: 20 } as const;
const MARGIN = { x: 2, y: 2 } as const;

function charFor(legend: Record<string, string>, kind: string): string {
  const entry = Object.entries(legend).find(([, k]) => k === kind);
  if (entry === undefined) throw new Error(`legend has no "${kind}" character`);
  return entry[0];
}

/** How many void rows to insert above the ship so the box's top rows hold no wall. */
function rowsToInsert(dock: DockJson, shipAt: Coord, boxX: number): number {
  const wall = charFor(dock.legend, "wall");
  let usable = 0;
  for (let y = shipAt.y - 1; y >= 0 && usable < MARGIN.y; y--) {
    const span = (dock.rows[y] ?? "").slice(boxX, boxX + BOX.w);
    if (span.includes(wall)) break;
    usable += 1;
  }
  return MARGIN.y - usable;
}

function shiftRect(rect: Rect, at: number, by: number): Rect {
  if (rect.y >= at) return { ...rect, y: rect.y + by };
  if (rect.y + rect.h > at) return { ...rect, h: rect.h + by };
  return rect;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function convert(dock: DockJson): DockJson {
  const { shipAt } = dock;
  if (shipAt === undefined) throw new Error(`${dock.id} has no shipAt (already converted?)`);
  if (dock.width < BOX.w) throw new Error(`${dock.id} is narrower than the M box`);
  const boxX = Math.min(Math.max(0, shipAt.x - MARGIN.x), dock.width - BOX.w);
  const insert = rowsToInsert(dock, shipAt, boxX);
  const voidChar = charFor(dock.legend, "void");
  const berthChars = new Set(
    Object.entries(dock.legend)
      .filter(([, kind]) => kind === "berth")
      .map(([ch]) => ch),
  );
  const rows = [
    ...dock.rows.slice(0, shipAt.y),
    ...Array.from({ length: insert }, () => voidChar.repeat(dock.width)),
    ...dock.rows.slice(shipAt.y),
  ];
  const box: Rect = { x: boxX, y: shipAt.y + insert - MARGIN.y, w: BOX.w, h: BOX.h };
  const converted = rows.map((row, y) =>
    [...row]
      .map((ch, x) => {
        const inBox = x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
        return inBox || berthChars.has(ch) ? voidChar : ch;
      })
      .join(""),
  );
  const props = dock.props
    .map((prop) => ({ ...prop, rect: shiftRect(prop.rect, shipAt.y, insert) }))
    .filter((prop) => {
      const inside = overlaps(prop.rect, box);
      if (inside) console.log(`${dock.id}: dropped prop "${prop.key}" inside the berth box`);
      return !inside;
    });
  const legend = Object.fromEntries(
    Object.entries(dock.legend).filter(([ch]) => !berthChars.has(ch)),
  );
  const out: DockJson = { ...dock };
  const ordered: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(out)) {
    if (field === "shipAt") {
      ordered.berth = { origin: { x: box.x, y: box.y }, sizeClass: "M" };
      continue;
    }
    ordered[field] = value;
  }
  return {
    ...(ordered as DockJson),
    height: dock.height + insert,
    rows: converted,
    legend,
    posts: dock.posts.map((post) => ({
      ...post,
      tile: post.tile.y >= shipAt.y ? { ...post.tile, y: post.tile.y + insert } : post.tile,
    })),
    areas: dock.areas.map((area) => ({ ...area, rect: shiftRect(area.rect, shipAt.y, insert) })),
    props,
    foreground: dock.foreground.map((fg) => ({
      ...fg,
      rect: shiftRect(fg.rect, shipAt.y, insert),
    })),
  };
}

const [file] = process.argv.slice(2);
if (file === undefined) throw new Error("usage: convert-dock-berth.mts <dock.json>");
const dock = JSON.parse(readFileSync(file, "utf8")) as DockJson;
const result = convert(dock);
writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
const berth = result.berth as { origin: Coord };
console.log(
  `${dock.id}: berth M at (${berth.origin.x},${berth.origin.y}), ${result.height - dock.height} row(s) inserted`,
);
