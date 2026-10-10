/**
 * Dock map validation (Dockside §3.1). L2: the port exists and has one dock, keys are unique, the
 * map has the posts and areas physical port work needs, a planet has a sky, and castSeed posts
 * name real posts. L3: the map's geometry against every deck in the bundle: the berth box
 * (§berth-boxes) lies on the map and is all void; the quay row under it is walkable floor across
 * its width (`checkQuayRow`); for each deck whose class fits the box, its ramps (the deck placed in
 * the box, `shipAtInBerth`) land on walkable floor outside the areas and reach every post and area;
 * posts and areas are walkable; the map fits the size cap. A scenario's ship fits every dock's box
 * (`checkScenarioBerths`). The deck's side of the contract is `validate-hull.ts`.
 *
 * Walkable dock floor is a `floor` tile under no blocking prop. The sim's nav graft applies the
 * same rule (`dockFloorMask` in `@crew/sim`, which this package may only import as types); a CLI
 * test checks the two agree on every authored dock, and `crew content validate` grafts each dock
 * with the sim's own builder.
 */
import type {
  ContentBundle,
  DeckDef,
  DockDef,
  DockPostKind,
  DockRect,
  PortDef,
  ScenarioDef,
  SiteCastEntryDef,
  TileCoord,
} from "@crew/sim";
import {
  HULL_CLASS_BOX,
  SIDE_OFFSET,
  at,
  berthBox,
  hullFitsBerth,
  rectContains,
  rectTiles,
  shipAtInBerth,
  tileKey,
} from "./geometry";
import { type Path, type ValidationIssue, checkLocalKeyLists, checkRef, issue } from "./issues";
import { SITE_CAST_LIMITS } from "./site";

/** Dockside §3.1: ship plus dock stays legible in the docked camera on a phone. */
const DOCK_MAX_WIDTH = 48;
const DOCK_MAX_HEIGHT = 36;

const NEIGHBOURS: readonly TileCoord[] = Object.values(SIDE_OFFSET);

function dockPath(dock: DockDef): Path {
  return ["docks", dock.id];
}

function inMap(dock: DockDef, t: TileCoord): boolean {
  return t.x >= 0 && t.y >= 0 && t.x < dock.width && t.y < dock.height;
}

/** Row-major index of an on-map tile in a dock-sized mask. */
function cell(dock: DockDef, t: TileCoord): number {
  return t.y * dock.width + t.x;
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
      if (tileKind(dock, { x, y }) === "floor") mask[cell(dock, { x, y })] = 1;
    }
  }
  for (const prop of dock.props) {
    if (!prop.blocking) continue;
    for (const t of rectTiles(prop.rect)) {
      if (inMap(dock, t)) mask[cell(dock, t)] = 0;
    }
  }
  return mask;
}

function walkable(dock: DockDef, mask: Uint8Array, t: TileCoord): boolean {
  return inMap(dock, t) && mask[cell(dock, t)] === 1;
}

/** Why a tile is not walkable, for messages: "wall", "off the map", "under blocking prop …". */
function describeTile(dock: DockDef, t: TileCoord): string {
  if (!inMap(dock, t)) return "off the map";
  const blocker = dock.props.find((p) => p.blocking && rectContains(p.rect, t));
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
  // Expeditions A1 (§4, call 10): a site needs no gate, warehouse door, stall or areas; its own
  // composition is `checkSiteComposition`'s.
  if (dock.kind === "site") return;
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
    checkRef(bundle.ports, dock.portId, "port", [...path, "portId"], issues);
    const other = dockByPort.get(dock.portId);
    if (other !== undefined) {
      issues.push(
        issue("referential", [...path, "portId"], `port "${dock.portId}" already has "${other}"`),
      );
    }
    dockByPort.set(dock.portId, dock.id);
    checkLocalKeyLists(
      path,
      [
        ["posts", "post", dock.posts.map((p) => p.key)],
        ["areas", "area", dock.areas.map((a) => a.key)],
        ["props", "prop", dock.props.map((p) => p.key)],
      ],
      issues,
    );
    checkComposition(dock, issues);
    checkSiteReferences(dock, bundle, issues);
    // §dock-map-content: the dock takes its setting from its port rather than repeating it.
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

/** Expeditions A1 (§5.2): which post kinds each cast part may stand at. */
const POSTS_FOR_PART: Readonly<Record<SiteCastEntryDef["part"], readonly DockPostKind[]>> = {
  target: ["target"],
  guard: ["guard"],
  bystander: ["bystander"],
  ally: ["guard", "bystander"],
};

/**
 * L2, expeditions A1 (§3.1, §4, §5.3): a site map belongs to a site port and a dock map to a port;
 * only a site has a `noticeRadius` (and must) and a `defaultCast`; the cast is within the caps
 * (`SITE_CAST_LIMITS`) and each entry stands at a post of its part's kind.
 */
function checkSiteReferences(
  dock: DockDef,
  bundle: ContentBundle,
  issues: ValidationIssue[],
): void {
  const path = dockPath(dock);
  const site = dock.kind === "site";
  const portIsSite = bundle.ports[dock.portId]?.kind === "site";
  if (bundle.ports[dock.portId] !== undefined && site !== portIsSite) {
    issues.push(
      issue(
        "referential",
        [...path, "kind"],
        site
          ? `a site map belongs to a site, not port "${dock.portId}"`
          : `site "${dock.portId}" needs a map of kind "site"`,
      ),
    );
  }
  if (!site) {
    if (dock.noticeRadius !== undefined || dock.defaultCast !== undefined) {
      issues.push(issue("referential", path, "only a site map has noticeRadius and defaultCast"));
    }
    return;
  }
  if (dock.noticeRadius === undefined) {
    issues.push(issue("referential", [...path, "noticeRadius"], "a site map needs a noticeRadius"));
  }
  const cast = dock.defaultCast ?? [];
  const count = (pred: (e: SiteCastEntryDef) => boolean) => cast.filter(pred).length;
  for (const [n, max, what] of [
    [cast.length, SITE_CAST_LIMITS.people, "people"],
    [count((e) => e.arms !== "none"), SITE_CAST_LIMITS.armed, "armed"],
    [count((e) => e.part === "target"), SITE_CAST_LIMITS.targets, "targets"],
    [count((e) => e.part === "ally"), SITE_CAST_LIMITS.allies, "allies"],
  ] as const) {
    if (n > max) {
      issues.push(issue("referential", [...path, "defaultCast"], `${n} ${what}; at most ${max}`));
    }
  }
  cast.forEach((entry, i) => {
    const post = dock.posts.find((p) => p.key === entry.post);
    const allowed = POSTS_FOR_PART[entry.part];
    if (post === undefined) {
      issues.push(
        issue("referential", [...path, "defaultCast", i, "post"], `no post "${entry.post}"`),
      );
    } else if (!allowed.includes(post.kind)) {
      issues.push(
        issue(
          "referential",
          [...path, "defaultCast", i, "post"],
          `${entry.name} is a ${entry.part}, at a ${allowed.join(" or ")} post, not "${post.key}" (${post.kind})`,
        ),
      );
    }
  });
}

/**
 * L3, expeditions A1 (§4, call 10): a site's own composition: one `target`, one `exit`, at least
 * one `guard`; `noticeRadius` under the map's width; and each `flank` post a real second way in
 * (`checkFlankRoutes`). Reachability of every post from the landings is `checkLandings`'.
 */
export function checkSiteComposition(
  dock: DockDef,
  bundle: ContentBundle,
  issues: ValidationIssue[],
): void {
  const path = dockPath(dock);
  for (const [kind, min, max] of [
    ["target", 1, 1],
    ["exit", 1, 1],
    ["guard", 1, Number.POSITIVE_INFINITY],
  ] as const) {
    const n = countOf(dock.posts, kind);
    if (n < min || n > max) {
      const want = max === min ? `exactly ${min}` : `at least ${min}`;
      issues.push(
        issue("physical", [...path, "posts"], `a site needs ${want} ${kind} post, found ${n}`),
      );
    }
  }
  if (dock.noticeRadius !== undefined && dock.noticeRadius >= dock.width) {
    issues.push(
      issue(
        "physical",
        [...path, "noticeRadius"],
        `noticeRadius ${dock.noticeRadius} is not under the map's width ${dock.width}`,
      ),
    );
  }
  checkFlankRoutes(dock, bundle, issues);
}

/**
 * The first row of a site's buildings: the first row south of the quay row with a wall in it. The
 * rows between (the quay row included) are the apron, open ground every route crosses. A map with
 * no wall south of the quay is all buildings below the quay row.
 */
function siteRowsFrom(dock: DockDef): number {
  const quayRow = berthBox(dock).y + berthBox(dock).h;
  for (let y = quayRow + 1; y < dock.height; y++) {
    if ([...(dock.rows[y] ?? "")].some((ch) => dock.legend[ch] === "wall")) return y;
  }
  return quayRow + 1;
}

/** One shortest walk from `from` to `to` over `mask` (both ends included), or undefined. */
function shortestRoute(
  dock: DockDef,
  mask: Uint8Array,
  from: TileCoord,
  to: TileCoord,
): TileCoord[] | undefined {
  if (!walkable(dock, mask, from) || !walkable(dock, mask, to)) return undefined;
  const parent = new Map<number, TileCoord>();
  const seen = new Uint8Array(dock.width * dock.height);
  seen[cell(dock, from)] = 1;
  const queue: TileCoord[] = [from];
  for (let head = 0; head < queue.length; head++) {
    const t = queue[head] as TileCoord;
    if (t.x === to.x && t.y === to.y) {
      const route = [t];
      for (let p = parent.get(cell(dock, t)); p !== undefined; p = parent.get(cell(dock, p))) {
        route.push(p);
      }
      return route.reverse();
    }
    for (const d of NEIGHBOURS) {
      const n = { x: t.x + d.x, y: t.y + d.y };
      if (!walkable(dock, mask, n) || seen[cell(dock, n)] === 1) continue;
      seen[cell(dock, n)] = 1;
      parent.set(cell(dock, n), t);
      queue.push(n);
    }
  }
  return undefined;
}

/**
 * Call 10: a `flank` post is a second way in, not the front door by another name. For each ramp
 * landing of each deck that berths here, the direct route (one shortest walk from the landing to
 * the target) is masked off south of the apron (`siteRowsFrom`), except the target's own
 * neighbours where both routes must end; the target must still be reachable from each flank post.
 * Masking one route rather than comparing two shortest ones keeps the rule indifferent to how
 * either walk breaks ties. A target the landing cannot reach is `checkLandings`' to report.
 */
function checkFlankRoutes(dock: DockDef, bundle: ContentBundle, issues: ValidationIssue[]): void {
  const target = dock.posts.find((p) => p.kind === "target");
  const flanks = dock.posts.filter((p) => p.kind === "flank");
  if (target === undefined || flanks.length === 0) return;
  const mask = dockWalkableMask(dock);
  const fromRow = siteRowsFrom(dock);
  const nearTarget = new Set(
    NEIGHBOURS.map((d) => tileKey({ x: target.tile.x + d.x, y: target.tile.y + d.y })),
  );
  for (const deck of Object.values(bundle.decks)) {
    if (!deckBerthsAt(dock, deck)) continue;
    for (const landing of dockRampLandings(dock, deck)) {
      const direct = shortestRoute(dock, mask, landing.tile, target.tile);
      if (direct === undefined) continue;
      const masked = mask.slice();
      const shut = direct.filter(
        (t) => t.y >= fromRow && !nearTarget.has(tileKey(t)) && !samePlace(t, target.tile),
      );
      for (const t of shut) masked[cell(dock, t)] = 0;
      for (const flank of flanks) {
        const i = dock.posts.indexOf(flank);
        if (!walkable(dock, mask, flank.tile)) continue; // `checkPostsAndAreas` reports it
        if (reachableFrom(dock, masked, flank.tile)[cell(dock, target.tile)] === 1) continue;
        issues.push(
          issue(
            "physical",
            [...dockPath(dock), "posts", i],
            `flank post "${flank.key}" at ${at(flank.tile)} reaches the target only along the direct route from ramp "${landing.key}" of "${deck.id}"; a flank needs its own way in south of row ${fromRow}`,
          ),
        );
      }
    }
  }
}

function samePlace(a: TileCoord, b: TileCoord): boolean {
  return a.x === b.x && a.y === b.y;
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
    const dock = Object.values(bundle.docks ?? {}).find((d) => d.portId === port.id);
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

/**
 * Claims each tile of `rect` for `key` in `owners`, in order, stopping at the first tile that
 * `problemAt` rejects or that another key already holds. Returns that problem, if any.
 */
function claimRect(
  rect: DockRect,
  key: string,
  label: string,
  owners: Map<string, string>,
  problemAt: (t: TileCoord) => string | undefined,
): string | undefined {
  for (const t of rectTiles(rect)) {
    const problem = problemAt(t);
    if (problem !== undefined) return problem;
    const other = owners.get(tileKey(t));
    if (other !== undefined) return `${label} "${key}" overlaps "${other}" at ${at(t)}`;
    owners.set(tileKey(t), key);
  }
  return undefined;
}

/** Props, areas and foreground rects lie on the map; props sit on floor and do not overlap. */
function checkPlacements(dock: DockDef, issues: ValidationIssue[]): void {
  const path = dockPath(dock);
  const propAt = new Map<string, string>();
  dock.props.forEach((prop, i) => {
    const problem = rectInMap(dock, prop.rect)
      ? claimRect(prop.rect, prop.key, "prop", propAt, (t) => {
          const kind = tileKind(dock, t);
          return kind === "floor"
            ? undefined
            : `prop "${prop.key}" covers ${at(t)}, which is ${kind ?? "undeclared"}, not floor`;
        })
      : `prop "${prop.key}" reaches off the map`;
    if (problem !== undefined) issues.push(issue("physical", [...path, "props", i], problem));
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
    const problem = claimRect(area.rect, area.key, "area", areaAt, (t) =>
      walkable(dock, mask, t)
        ? undefined
        : `area "${area.key}" tile ${at(t)} is ${describeTile(dock, t)}, not walkable floor`,
    );
    if (problem !== undefined) issues.push(issue("physical", [...path, "areas", i], problem));
  });
  dock.posts.forEach((post, i) => {
    const postPath: Path = [...path, "posts", i, "tile"];
    const where = `post "${post.key}" at ${at(post.tile)}`;
    if (!walkable(dock, mask, post.tile)) {
      issues.push(
        issue(
          "physical",
          postPath,
          `${where} is ${describeTile(dock, post.tile)}, not walkable floor`,
        ),
      );
    }
    const area = areaAt.get(tileKey(post.tile));
    if (area !== undefined) {
      issues.push(issue("physical", postPath, `${where} stands inside area "${area}"`));
    }
  });
}

/** §berth-boxes: the berth box lies on the map and every tile of it is authored `void`. */
function checkBerthBox(dock: DockDef, issues: ValidationIssue[]): boolean {
  const path: Path = [...dockPath(dock), "berth", "origin"];
  const { origin, sizeClass } = dock.berth;
  const rect = berthBox(dock);
  if (!rectInMap(dock, rect)) {
    issues.push(
      issue(
        "physical",
        path,
        `the ${sizeClass} berth box (${rect.w} x ${rect.h}) at ${at(origin)} does not fit on the ${dock.width} x ${dock.height} map`,
      ),
    );
    return false;
  }
  const solid = rectTiles(rect).find((t) => tileKind(dock, t) !== "void");
  if (solid !== undefined) {
    const kind = tileKind(dock, solid) ?? "undeclared";
    issues.push(issue("physical", path, `berth box tile ${at(solid)} is ${kind}, not void`));
    return false;
  }
  return true;
}

/**
 * L3 (§berth-boxes): the quay row, just south of the berth box, is walkable floor across the box's
 * whole width, so a ramp anywhere along a hull of the box's class lands on the quay. Expects a
 * usable grid and a box on the map (`checkDockPhysical` checks both first); a quay row off the map
 * is reported as off the map.
 */
export function checkQuayRow(dock: DockDef, issues: ValidationIssue[]): void {
  const mask = dockWalkableMask(dock);
  const rect = berthBox(dock);
  const y = rect.y + rect.h;
  const gaps = rectTiles({ x: rect.x, y, w: rect.w, h: 1 }).filter((t) => !walkable(dock, mask, t));
  const [first] = gaps;
  if (first === undefined) return;
  const more = gaps.length > 1 ? ` (and ${gaps.length - 1} more)` : "";
  issues.push(
    issue(
      "physical",
      [...dockPath(dock), "berth", "origin"],
      `quay row ${y} under the berth box: ${at(first)} is ${describeTile(dock, first)}, not walkable floor${more}`,
    ),
  );
}

/**
 * Whether `deck` can lie in `dock`'s box. A deck over its own class box is the hull contract's to
 * report; a class bigger than the box cannot berth here, which `checkScenarioBerths` makes an error
 * for any scenario's ship.
 */
function deckBerthsAt(dock: DockDef, deck: DeckDef): boolean {
  const own = HULL_CLASS_BOX[deck.hull.sizeClass];
  const withinOwnClass = deck.width <= own.w && deck.height <= own.h;
  return withinOwnClass && hullFitsBerth(deck.hull.sizeClass, dock.berth.sizeClass);
}

/** Dock-frame tile just outside each ramp door of the deck, lying in the dock's berth box. */
export function dockRampLandings(
  dock: DockDef,
  deck: DeckDef,
): { readonly key: string; readonly tile: TileCoord }[] {
  const shipAt = shipAtInBerth(dock, deck);
  return deck.doors
    .filter((door) => door.kind === "ramp")
    .map((door) => {
      const d = SIDE_OFFSET[door.edge.side];
      return {
        key: door.key,
        tile: { x: door.edge.x + d.x + shipAt.x, y: door.edge.y + d.y + shipAt.y },
      };
    });
}

function reachableFrom(dock: DockDef, mask: Uint8Array, start: TileCoord): Uint8Array {
  const seen = new Uint8Array(dock.width * dock.height);
  if (!walkable(dock, mask, start)) return seen;
  seen[cell(dock, start)] = 1;
  const queue: TileCoord[] = [start];
  for (let head = 0; head < queue.length; head++) {
    const t = queue[head] as TileCoord;
    for (const d of NEIGHBOURS) {
      const n = { x: t.x + d.x, y: t.y + d.y };
      if (!walkable(dock, mask, n) || seen[cell(dock, n)] === 1) continue;
      seen[cell(dock, n)] = 1;
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
  for (const landing of dockRampLandings(dock, deck)) {
    const where = `ramp "${landing.key}" of "${deck.id}" lands at ${at(landing.tile)}`;
    if (!walkable(dock, mask, landing.tile)) {
      issues.push(
        issue(
          "physical",
          [...path, "berth"],
          `${where}, which is ${describeTile(dock, landing.tile)}`,
        ),
      );
      continue;
    }
    const inArea = dock.areas.find((a) => rectContains(a.rect, landing.tile));
    if (inArea !== undefined) {
      issues.push(issue("physical", [...path, "areas"], `${where}, inside area "${inArea.key}"`));
    }
    const seen = reachableFrom(dock, mask, landing.tile);
    const unreached = (t: TileCoord) => walkable(dock, mask, t) && seen[cell(dock, t)] !== 1;
    dock.posts.forEach((post, i) => {
      if (unreached(post.tile)) {
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
      const cut = rectTiles(area.rect).find(unreached);
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

/**
 * §dock-map-content, §dirt-deposits: a station has no sky, so a dock whose port is a `station`
 * carries no airborne dust. Grime and dust in [0, 1] are L1's (`dockDefSchema`).
 */
function checkStationDust(dock: DockDef, bundle: ContentBundle, issues: ValidationIssue[]): void {
  const port = bundle.ports[dock.portId];
  if (port?.setting !== "station" || dock.airborneDust === 0) return;
  issues.push(
    issue(
      "physical",
      [...dockPath(dock), "airborneDust"],
      `"${dock.id}" is a station dock but has airborneDust ${dock.airborneDust}; a station has no sky (§dock-map-content)`,
    ),
  );
}

/** L3 for one dock, against every deck in the bundle. */
export function checkDockPhysical(
  dock: DockDef,
  bundle: ContentBundle,
  issues: ValidationIssue[],
): void {
  checkStationDust(dock, bundle, issues);
  if (!checkGrid(dock, issues)) return;
  checkPlacements(dock, issues);
  const mask = dockWalkableMask(dock);
  checkPostsAndAreas(dock, mask, issues);
  if (!checkBerthBox(dock, issues)) return;
  checkQuayRow(dock, issues);
  for (const deck of Object.values(bundle.decks)) {
    if (deckBerthsAt(dock, deck)) checkLandings(dock, deck, mask, issues);
  }
  if (dock.kind === "site") checkSiteComposition(dock, bundle, issues);
}

/**
 * L3 (§orientation-and-size): a scenario's ship can berth at every dock, its class fitting each
 * berth box.
 */
export function checkScenarioBerths(
  scenario: ScenarioDef,
  bundle: ContentBundle,
  issues: ValidationIssue[],
): void {
  const deck = bundle.decks[scenario.deckId];
  if (deck === undefined) return; // L2 reports an unknown deck
  for (const dock of Object.values(bundle.docks ?? {})) {
    if (hullFitsBerth(deck.hull.sizeClass, dock.berth.sizeClass)) continue;
    issues.push(
      issue(
        "physical",
        ["scenarios", scenario.id, "deckId"],
        `"${deck.id}" (class ${deck.hull.sizeClass}) cannot berth at "${dock.id}" (an ${dock.berth.sizeClass} box)`,
      ),
    );
  }
}
