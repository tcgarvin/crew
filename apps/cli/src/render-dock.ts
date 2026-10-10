/**
 * ASCII rendering for a `DockDef` with every deck in the bundle composited in its berth box, one
 * map per deck, each where `berthPlacement` puts it (§ship-placement; used by `crew content
 * render-dock`, which writes it into the README next to each dock file under
 * `packages/content/data/docks/`).
 */
import { dockRampLandings } from "@crew/content";
import {
  type DeckDef,
  type DockDef,
  type DockRect,
  HULL_SIZE_BOX,
  type PortDef,
  type TileCoord,
  berthPlacement,
} from "@crew/sim";

const BASE_CHAR: Readonly<Record<string, string>> = {
  floor: ".",
  wall: "#",
  void: " ",
};

/** A berth box tile no ship floor covers. */
const BERTH_CHAR = "=";

const AREA_CHAR: Readonly<Record<DockDef["areas"][number]["kind"], string>> = {
  freightStaging: "s",
  deliveryBay: "d",
};

const POST_CHARS = "123456789abcefghijklmnopqrtuwyz";

function rectTiles(rect: DockRect): TileCoord[] {
  const tiles: TileCoord[] = [];
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) tiles.push({ x, y });
  }
  return tiles;
}

function rectText(rect: DockRect): string {
  return `(${rect.x},${rect.y}) ${rect.w} x ${rect.h}`;
}

function berthRect(dock: DockDef): DockRect {
  const box = HULL_SIZE_BOX[dock.berth.sizeClass];
  return { x: dock.berth.origin.x, y: dock.berth.origin.y, w: box.w, h: box.h };
}

/** The map grid with the ship, areas, props, landings and posts drawn in, plus rulers. */
function compositeMap(dock: DockDef, deck: DeckDef): string[] {
  const grid = dock.rows.map((row) =>
    [...row].map((ch) => BASE_CHAR[dock.legend[ch] ?? ""] ?? "?"),
  );
  const put = (t: TileCoord, ch: string) => {
    const row = grid[t.y];
    if (row !== undefined && t.x >= 0 && t.x < row.length) row[t.x] = ch;
  };
  for (const t of rectTiles(berthRect(dock))) put(t, BERTH_CHAR);
  const shipAt = berthPlacement(dock, deck);
  deck.tiles.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch !== " ") put({ x: x + shipAt.x, y: y + shipAt.y }, ch);
    });
  });
  for (const area of dock.areas) {
    for (const t of rectTiles(area.rect)) put(t, AREA_CHAR[area.kind]);
  }
  for (const prop of dock.props) {
    for (const t of rectTiles(prop.rect)) put(t, prop.blocking ? "%" : ":");
  }
  for (const landing of dockRampLandings(dock, deck)) put(landing.tile, "v");
  dock.posts.forEach((post, i) => put(post.tile, POST_CHARS[i] ?? "*"));

  const xs = [...Array(dock.width).keys()];
  const tens = xs.map((x) => (x % 10 === 0 ? String(Math.floor(x / 10) % 10) : " ")).join("");
  const units = xs.map((x) => String(x % 10)).join("");
  return [
    `   ${tens}`.trimEnd(),
    `   ${units}`,
    ...grid.map((row, y) => `${String(y).padStart(2, " ")} ${row.join("")}`.trimEnd()),
  ];
}

/**
 * Renders the dock map with each deck docked in its berth box (one map per deck), and every
 * post, area, prop and landing listed.
 */
export function renderDock(dock: DockDef, decks: readonly DeckDef[], port: PortDef): string {
  const lines: string[] = [];
  const box = berthRect(dock);
  lines.push(`${dock.name} (${dock.id})`);
  lines.push(`${port.setting} dock for ${port.name} (${port.id})`);
  lines.push(
    `${dock.width} x ${dock.height} tiles; ${dock.berth.sizeClass} berth box ${box.w} x ${box.h} at (${box.x},${box.y})`,
  );
  for (const deck of decks) {
    const shipAt = berthPlacement(dock, deck);
    lines.push("");
    lines.push(`${deck.name} (${deck.id}) docked at (${shipAt.x},${shipAt.y})`);
    lines.push("");
    lines.push(...compositeMap(dock, deck));
  }
  lines.push("");
  lines.push("Key:");
  lines.push("  .  floor     #  wall     (blank)  void     A-Z  the ship (deck symbols)");
  lines.push("  =  berth box tile no ship floor covers");
  lines.push("  v  ramp landing     s  freight staging     d  delivery bay");
  lines.push("  %  blocking prop    :  prop you can walk past    1-9  posts (below)");
  lines.push("");
  lines.push(`Posts (${dock.posts.length}):`);
  dock.posts.forEach((post, i) => {
    const regulars = port.castSeed.filter((seed) => seed.post === post.key).map((s) => s.name);
    const who = regulars.length > 0 ? `; regular: ${regulars.join(", ")}` : "";
    lines.push(
      `  ${POST_CHARS[i] ?? "*"}  ${post.key}: ${post.kind}, ${post.name}, at (${post.tile.x},${post.tile.y}) facing ${post.facing}${who}`,
    );
  });
  for (const deck of decks) {
    lines.push("");
    lines.push(`Ramp landings (${deck.id}):`);
    for (const landing of dockRampLandings(dock, deck)) {
      lines.push(`  ${landing.key}: (${landing.tile.x},${landing.tile.y})`);
    }
  }
  lines.push("");
  lines.push(`Areas (${dock.areas.length}):`);
  for (const area of dock.areas) {
    lines.push(`  ${area.key}: ${area.kind} ${rectText(area.rect)}`);
  }
  lines.push("");
  lines.push(`Props (${dock.props.length}):`);
  for (const prop of dock.props) {
    const blocking = prop.blocking ? ", blocking" : "";
    lines.push(`  ${prop.key}: ${prop.kind} ${rectText(prop.rect)} rot=${prop.rot}${blocking}`);
  }
  lines.push("");
  lines.push(`Foreground (${dock.foreground.length}):`);
  for (const fg of dock.foreground) lines.push(`  ${fg.kind} ${rectText(fg.rect)}`);
  lines.push("");
  const p = dock.palette;
  const sky = p.sky !== undefined ? `, sky ${p.sky}` : "";
  lines.push(`Palette: floor ${p.floor}, wall ${p.wall}, accent ${p.accent}${sky}`);
  return lines.join("\n");
}

/** The README written next to the dock's JSON file. */
export function renderDockReadme(
  dock: DockDef,
  decks: readonly DeckDef[],
  port: PortDef,
  fileName: string,
): string {
  return [
    `# ${dock.name}: dock map`,
    "",
    `Generated by \`crew content render-dock ${dock.id}\` from \`${fileName}\`; do not edit by hand.`,
    "Regenerate after any change to the map or a deck (a CLI test fails while this is stale).",
    "East (high x) is fore. The ship's ramps open on its south flank onto the quay; each deck lies in the berth box flush to its south edge and centred.",
    "",
    `> ${dock.ambience}`,
    "",
    "```",
    renderDock(dock, decks, port),
    "```",
    "",
  ].join("\n");
}
