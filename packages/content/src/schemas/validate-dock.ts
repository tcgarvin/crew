/**
 * Dock map validation (Dockside §3.1). L2: the port exists and has one dock, keys are unique, the
 * map has the posts and areas physical port work needs, a planet has a sky, and castSeed posts
 * name real posts. L3: the map's geometry against every deck in the bundle (one ship class
 * today): the berth is exactly the ship's floor at `shipAt`, each ramp lands on walkable floor,
 * posts and areas are walkable and reachable from every landing, and the map fits the size cap.
 *
 * Walkable dock floor is a `floor` tile under no blocking prop. The sim's nav graft applies the
 * same rule (`dockFloorMask` in `@crew/sim`, which this package may only import as types); a CLI
 * test checks the two agree on every authored dock, and `crew content validate` grafts each dock
 * with the sim's own builder.
 */
import type { ContentBundle, DeckDef, DockDef, DockRect, PortDef, TileCoord } from "@crew/sim";
import { type Path, type ValidationIssue, checkDuplicateLocalKeys, issue } from "./issues";

/** Dockside §3.1: ship plus dock stays legible in the docked camera on a phone. */
export const DOCK_MAX_WIDTH = 48;
export const DOCK_MAX_HEIGHT = 36;

const NEIGHBOURS: readonly TileCoord[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

const SIDE_DELTA: Readonly<Record<"n" | "e" | "s" | "w", TileCoord>> = {
  n: { x: 0, y: -1 },
  e: { x: 1, y: 0 },
  s: { x: 0, y: 1 },
  w: { x: -1, y: 0 },
};

function dockPath(dock: DockDef): Path {
  return ["docks", dock.id];
}

function at(t: TileCoord): string {
  return `(${t.x},${t.y})`;
}

function rectTiles(rect: DockRect): TileCoord[] {
  const tiles: TileCoord[] = [];
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) tiles.push({ x, y });
  }
  return tiles;
}

function inMap(dock: DockDef, t: TileCoord): boolean {
  return t.x >= 0 && t.y >= 0 && t.x < dock.width && t.y < dock.height;
}

function rectInMap(dock: DockDef, rect: DockRect): boolean {
  return rect.x + rect.w <= dock.width && rect.y + rect.h <= dock.height;
}

/** The legend kind of a dock tile, or undefined off the map or for an undeclared character. */
function tileKind(dock: DockDef, t: TileCoord): string | undefined {
  if (!inMap(dock, t)) return undefined;
  const ch = dock.rows[t.y]?.[t.x];
  return ch === undefined ? undefined : dock.legend[ch];
}

/**
 * Walkable dock floor, row-major in the dock's frame: a `floor` tile under no blocking prop.
 * Tolerant of malformed maps (an undeclared character or an off-map prop is reported by L3, and
 * simply not floor here), so validation can run every check in one pass.
 */
export function dockWalkableMask(dock: DockDef): Uint8Array {
  const mask = new Uint8Array(dock.width * dock.height);
  for (let y = 0; y < dock.height; y++) {
    for (let x = 0; x < dock.width; x++) {
      if (tileKind(dock, { x, y }) === "floor") mask[y * dock.width + x] = 1;
    }
  }
  for (const prop of dock.props) {
    if (!prop.blocking) continue;
    for (const t of rectTiles(prop.rect)) {
      if (inMap(dock, t)) mask[t.y * dock.width + t.x] = 0;
    }
  }
  return mask;
}

function walkable(dock: DockDef, mask: Uint8Array, t: TileCoord): boolean {
  return inMap(dock, t) && mask[t.y * dock.width + t.x] === 1;
}

/** Why a tile is not walkable, for messages: "wall", "off the map", "under blocking prop …". */
function describeTile(dock: DockDef, t: TileCoord): string {
  if (!inMap(dock, t)) return "off the map";
  const blocker = dock.props.find(
    (p) => p.blocking && rectTiles(p.rect).some((r) => r.x === t.x && r.y === t.y),
  );
  if (blocker !== undefined) return `under blocking prop "${blocker.key}"`;
  return tileKind(dock, t) ?? "an undeclared character";
}

// ---------------------------------------------------------------------------------------------
// L2
// ---------------------------------------------------------------------------------------------

function countOf<T extends { kind: string }>(items: readonly T[], kind: T["kind"]): number {
  return items.filter((item) => item.kind === kind).length;
}

function checkComposition(dock: DockDef, issues: ValidationIssue[]): void {
  const path = dockPath(dock);
  const exactlyOne = (count: number, what: string, where: "posts" | "areas") => {
    if (count !== 1) {
      issues.push(
        issue("referential", [...path, where], `needs exactly one ${what}, found ${count}`),
      );
    }
  };
  exactlyOne(countOf(dock.posts, "gate"), "gate post", "posts");
  exactlyOne(countOf(dock.posts, "warehouseDoor"), "warehouseDoor post", "posts");
  exactlyOne(countOf(dock.areas, "freightStaging"), "freightStaging area", "areas");
  exactlyOne(countOf(dock.areas, "deliveryBay"), "deliveryBay area", "areas");
  const stalls = countOf(dock.posts, "marketStall");
  if (stalls > 1) {
    issues.push(
      issue("referential", [...path, "posts"], `has ${stalls} marketStall posts; at most one`),
    );
  }
}

/** L2 for every dock: port, one dock per port, unique keys, composition, sky (by the port's setting). */
export function checkDockReferences(bundle: ContentBundle, issues: ValidationIssue[]): void {
  const dockByPort = new Map<string, string>();
  for (const dock of Object.values(bundle.docks ?? {})) {
    const path = dockPath(dock);
    if (!(dock.portId in bundle.ports)) {
      issues.push(issue("referential", [...path, "portId"], `unknown port "${dock.portId}"`));
    }
    const other = dockByPort.get(dock.portId);
    if (other !== undefined) {
      issues.push(
        issue("referential", [...path, "portId"], `port "${dock.portId}" already has "${other}"`),
      );
    }
    dockByPort.set(dock.portId, dock.id);
    checkDuplicateLocalKeys(
      dock.posts.map((p) => p.key),
      [...path, "posts"],
      "post",
      issues,
    );
    checkDuplicateLocalKeys(
      dock.areas.map((a) => a.key),
      [...path, "areas"],
      "area",
      issues,
    );
    checkDuplicateLocalKeys(
      dock.props.map((p) => p.key),
      [...path, "props"],
      "prop",
      issues,
    );
    checkComposition(dock, issues);
    // D61: the dock takes its setting from its port rather than repeating it.
    const setting = bundle.ports[dock.portId]?.setting;
    if (setting === "planet" && dock.palette.sky === undefined) {
      issues.push(issue("referential", [...path, "palette"], "a planet dock needs palette.sky"));
    }
    if (setting === "station" && dock.palette.sky !== undefined) {
      issues.push(
        issue("referential", [...path, "palette", "sky"], "a station dock has no sky colour"),
      );
    }
  }
}

/** The dock map for a port, if it has one. */
export function dockOfPort(bundle: ContentBundle, portId: string): DockDef | undefined {
  return Object.values(bundle.docks ?? {}).find((d) => d.portId === portId);
}

/** L2: a castSeed `post` names a post on that port's dock map (Dockside §5.2). */
export function checkCastSeedPosts(
  port: PortDef,
  bundle: ContentBundle,
  issues: ValidationIssue[],
): void {
  port.castSeed.forEach((seed, i) => {
    if (seed.post === undefined) return;
    const path: Path = ["ports", port.id, "castSeed", i, "post"];
    const dock = dockOfPort(bundle, port.id);
    if (dock === undefined) {
      issues.push(
        issue(
          "referential",
          path,
          `"${seed.name}" has post "${seed.post}" but the port has no dock`,
        ),
      );
    } else if (!dock.posts.some((p) => p.key === seed.post)) {
      const keys = dock.posts.map((p) => p.key).join(", ");
      issues.push(
        issue(
          "referential",
          path,
          `"${seed.name}" has post "${seed.post}", which "${dock.id}" lacks (posts: ${keys})`,
        ),
      );
    }
  });
}

// ---------------------------------------------------------------------------------------------
// L3
// ---------------------------------------------------------------------------------------------

/** Rows match width/height and use legend characters. False if the grid itself is unusable. */
function checkGrid(dock: DockDef, issues: ValidationIssue[]): boolean {
  const path = dockPath(dock);
  let usable = true;
  if (dock.rows.length !== dock.height) {
    issues.push(
      issue(
        "physical",
        [...path, "rows"],
        `${dock.rows.length} rows, expected height ${dock.height}`,
      ),
    );
    usable = false;
  }
  dock.rows.forEach((row, y) => {
    if (row.length !== dock.width) {
      issues.push(
        issue(
          "physical",
          [...path, "rows", y],
          `row ${y} is ${row.length} wide, expected width ${dock.width}`,
        ),
      );
      usable = false;
    }
    const unknown = new Set([...row].filter((ch) => dock.legend[ch] === undefined));
    for (const ch of unknown) {
      issues.push(
        issue(
          "physical",
          [...path, "rows", y],
          `row ${y} uses "${ch}", which is not in the legend`,
        ),
      );
    }
  });
  if (dock.width > DOCK_MAX_WIDTH || dock.height > DOCK_MAX_HEIGHT) {
    issues.push(
      issue(
        "physical",
        path,
        `${dock.width} x ${dock.height} exceeds the ${DOCK_MAX_WIDTH} x ${DOCK_MAX_HEIGHT} cap (ship included)`,
      ),
    );
  }
  return usable;
}

/** Props, areas and foreground rects lie on the map; props sit on floor and do not overlap. */
function checkPlacements(dock: DockDef, issues: ValidationIssue[]): void {
  const path = dockPath(dock);
  const propAt = new Map<string, string>();
  dock.props.forEach((prop, i) => {
    if (!rectInMap(dock, prop.rect)) {
      issues.push(
        issue("physical", [...path, "props", i], `prop "${prop.key}" reaches off the map`),
      );
      return;
    }
    for (const t of rectTiles(prop.rect)) {
      const kind = tileKind(dock, t);
      if (kind !== "floor") {
        issues.push(
          issue(
            "physical",
            [...path, "props", i],
            `prop "${prop.key}" covers ${at(t)}, which is ${kind ?? "undeclared"}, not floor`,
          ),
        );
        return;
      }
      const other = propAt.get(`${t.x},${t.y}`);
      if (other !== undefined) {
        issues.push(
          issue(
            "physical",
            [...path, "props", i],
            `prop "${prop.key}" overlaps "${other}" at ${at(t)}`,
          ),
        );
        return;
      }
      propAt.set(`${t.x},${t.y}`, prop.key);
    }
  });
  dock.areas.forEach((area, i) => {
    if (!rectInMap(dock, area.rect)) {
      issues.push(
        issue("physical", [...path, "areas", i], `area "${area.key}" reaches off the map`),
      );
    }
  });
  dock.foreground.forEach((fg, i) => {
    if (!rectInMap(dock, fg.rect)) {
      issues.push(issue("physical", [...path, "foreground", i], `${fg.kind} reaches off the map`));
    }
  });
}

/** Posts and areas are on walkable floor, apart from each other. */
function checkPostsAndAreas(dock: DockDef, mask: Uint8Array, issues: ValidationIssue[]): void {
  const path = dockPath(dock);
  const areaAt = new Map<string, string>();
  dock.areas.forEach((area, i) => {
    for (const t of rectTiles(area.rect)) {
      if (!walkable(dock, mask, t)) {
        issues.push(
          issue(
            "physical",
            [...path, "areas", i],
            `area "${area.key}" tile ${at(t)} is ${describeTile(dock, t)}, not walkable floor`,
          ),
        );
        return;
      }
      const other = areaAt.get(`${t.x},${t.y}`);
      if (other !== undefined) {
        issues.push(
          issue(
            "physical",
            [...path, "areas", i],
            `area "${area.key}" overlaps "${other}" at ${at(t)}`,
          ),
        );
        return;
      }
      areaAt.set(`${t.x},${t.y}`, area.key);
    }
  });
  dock.posts.forEach((post, i) => {
    if (!walkable(dock, mask, post.tile)) {
      issues.push(
        issue(
          "physical",
          [...path, "posts", i, "tile"],
          `post "${post.key}" at ${at(post.tile)} is ${describeTile(dock, post.tile)}, not walkable floor`,
        ),
      );
    }
    const area = areaAt.get(`${post.tile.x},${post.tile.y}`);
    if (area !== undefined) {
      issues.push(
        issue(
          "physical",
          [...path, "posts", i, "tile"],
          `post "${post.key}" at ${at(post.tile)} stands inside area "${area}"`,
        ),
      );
    }
  });
}

/** Deck floor tiles (deck frame). */
function shipFloor(deck: DeckDef): TileCoord[] {
  const tiles: TileCoord[] = [];
  deck.tiles.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] !== " ") tiles.push({ x, y });
  });
  return tiles;
}

/** The ship lies on the map, and the berth tiles are exactly its floor. */
function checkBerth(dock: DockDef, deck: DeckDef, issues: ValidationIssue[]): boolean {
  const path: Path = [...dockPath(dock), "shipAt"];
  const { x: sx, y: sy } = dock.shipAt;
  if (sx < 0 || sy < 0 || sx + deck.width > dock.width || sy + deck.height > dock.height) {
    issues.push(
      issue(
        "physical",
        path,
        `"${deck.id}" (${deck.width} x ${deck.height}) at ${at(dock.shipAt)} does not fit on the ${dock.width} x ${dock.height} map`,
      ),
    );
    return false;
  }
  const under = new Set(shipFloor(deck).map((t) => `${t.x + sx},${t.y + sy}`));
  for (let y = 0; y < dock.height; y++) {
    for (let x = 0; x < dock.width; x++) {
      const berth = tileKind(dock, { x, y }) === "berth";
      if (berth !== under.has(`${x},${y}`)) {
        const message = berth
          ? `berth at ${at({ x, y })} is not under "${deck.id}" docked at ${at(dock.shipAt)}`
          : `${at({ x, y })} is under "${deck.id}" docked at ${at(dock.shipAt)} but is not berth`;
        issues.push(issue("physical", path, message));
        return false;
      }
    }
  }
  return true;
}

interface Landing {
  readonly rampKey: string;
  readonly tile: TileCoord;
}

/** Dock-frame tile just outside each ramp door of the deck. */
function landingsOf(dock: DockDef, deck: DeckDef): Landing[] {
  return deck.doors
    .filter((door) => door.kind === "ramp")
    .map((door) => {
      const d = SIDE_DELTA[door.edge.side];
      return {
        rampKey: door.key,
        tile: { x: door.edge.x + d.x + dock.shipAt.x, y: door.edge.y + d.y + dock.shipAt.y },
      };
    });
}

function reachableFrom(dock: DockDef, mask: Uint8Array, start: TileCoord): Uint8Array {
  const seen = new Uint8Array(dock.width * dock.height);
  if (!walkable(dock, mask, start)) return seen;
  seen[start.y * dock.width + start.x] = 1;
  const queue: TileCoord[] = [start];
  for (let head = 0; head < queue.length; head++) {
    const t = queue[head] as TileCoord;
    for (const d of NEIGHBOURS) {
      const n = { x: t.x + d.x, y: t.y + d.y };
      if (!walkable(dock, mask, n) || seen[n.y * dock.width + n.x] === 1) continue;
      seen[n.y * dock.width + n.x] = 1;
      queue.push(n);
    }
  }
  return seen;
}

/** Each ramp lands on walkable floor, outside the areas, and reaches every post and area tile. */
function checkLandings(
  dock: DockDef,
  deck: DeckDef,
  mask: Uint8Array,
  issues: ValidationIssue[],
): void {
  const path = dockPath(dock);
  for (const landing of landingsOf(dock, deck)) {
    const where = `ramp "${landing.rampKey}" of "${deck.id}" lands at ${at(landing.tile)}`;
    if (!walkable(dock, mask, landing.tile)) {
      issues.push(
        issue(
          "physical",
          [...path, "shipAt"],
          `${where}, which is ${describeTile(dock, landing.tile)}`,
        ),
      );
      continue;
    }
    const inArea = dock.areas.find((a) =>
      rectTiles(a.rect).some((t) => t.x === landing.tile.x && t.y === landing.tile.y),
    );
    if (inArea !== undefined) {
      issues.push(issue("physical", [...path, "areas"], `${where}, inside area "${inArea.key}"`));
    }
    const seen = reachableFrom(dock, mask, landing.tile);
    const reached = (t: TileCoord) => inMap(dock, t) && seen[t.y * dock.width + t.x] === 1;
    dock.posts.forEach((post, i) => {
      if (walkable(dock, mask, post.tile) && !reached(post.tile)) {
        issues.push(
          issue(
            "physical",
            [...path, "posts", i],
            `post "${post.key}" at ${at(post.tile)} cannot be reached from ${where}`,
          ),
        );
      }
    });
    dock.areas.forEach((area, i) => {
      const cut = rectTiles(area.rect).find((t) => walkable(dock, mask, t) && !reached(t));
      if (cut !== undefined) {
        issues.push(
          issue(
            "physical",
            [...path, "areas", i],
            `area "${area.key}" tile ${at(cut)} cannot be reached from ${where}`,
          ),
        );
      }
    });
  }
}

/** L3 for one dock, against every deck in the bundle. */
export function checkDockPhysical(
  dock: DockDef,
  bundle: ContentBundle,
  issues: ValidationIssue[],
): void {
  if (!checkGrid(dock, issues)) return;
  checkPlacements(dock, issues);
  const mask = dockWalkableMask(dock);
  checkPostsAndAreas(dock, mask, issues);
  for (const deck of Object.values(bundle.decks)) {
    if (checkBerth(dock, deck, issues)) checkLandings(dock, deck, mask, issues);
  }
}
