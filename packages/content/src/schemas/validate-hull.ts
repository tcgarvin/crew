/**
 * The hull contract (D72; ship life §10): what every deck must offer for the sim, the dock maps
 * and the crew's routines to take it, checked at L3 with one issue per failure.
 *
 * - **Shape**: the deck fits its `hull.sizeClass` box; the `bridge` compartment touches the east
 *   hull edge (the bow is east); both ramp doors open south from the bottom row (the quay is
 *   south); each transfer tile is its ramp door's tile or next to it.
 * - **Rooms**: compartments tagged `bridge`, `quarters` (or at least one `cabin`), `mess`,
 *   `galley`, `engineering`, `cargoHold` and `airlock`.
 * - **Machines**: exactly one `pilotStation` and one `navStation`; at least one `engine`,
 *   `messTable` and `stove`.
 * - **Zones and spawns**: a `cargoStowage` zone; a `crew` and a `passenger` spawn point; every
 *   `locker` zone serves a bed (`machineKey`) and no bed has two lockers.
 * - **Per scenario**: enough `crew` spawn points for the crew, and beds (`bed`, never `medBed`)
 *   for the crew plus one.
 *
 * Unknown machine defs, door keys and placement keys are L2's to report; these checks skip them.
 */
import type { DeckDef, MachineDef, MachineTag, ScenarioDef, TileCoord } from "@crew/sim";
import { HULL_CLASS_BOX, at } from "./geometry";
import { type Path, type ValidationIssue, issue } from "./issues";

/** The machine defs a deck's placements name; only their tags matter here. */
export type MachineTagTable = Readonly<Record<string, Pick<MachineDef, "tags">>>;

/** Each entry is satisfied by a compartment carrying any one of its tags. */
const REQUIRED_COMPARTMENT_TAGS: readonly (readonly string[])[] = [
  ["bridge"],
  ["quarters", "cabin"],
  ["mess"],
  ["galley"],
  ["engineering"],
  ["cargoHold"],
  ["airlock"],
];

/** Stations are singular so the watch knows where to stand; the rest need at least one. */
const REQUIRED_MACHINES: readonly { readonly tag: MachineTag; readonly exactlyOne: boolean }[] = [
  { tag: "pilotStation", exactlyOne: true },
  { tag: "navStation", exactlyOne: true },
  { tag: "engine", exactlyOne: false },
  { tag: "messTable", exactlyOne: false },
  { tag: "stove", exactlyOne: false },
];

const REQUIRED_SPAWN_TAGS = ["crew", "passenger"] as const;

function deckPath(deck: DeckDef): Path {
  return ["decks", deck.id];
}

function sameTile(a: TileCoord, b: TileCoord): boolean {
  return a.x === b.x && a.y === b.y;
}

function isAdjacent(a: TileCoord, b: TileCoord): boolean {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
}

/** Placement keys of the deck whose machine def carries `tag`, in deck order. */
function placementsTagged(deck: DeckDef, machines: MachineTagTable, tag: MachineTag): string[] {
  return deck.machines
    .filter((p) => machines[p.machineDefId]?.tags.includes(tag) === true)
    .map((p) => p.key);
}

/** Beds people sleep in: `bed`-tagged, and never the infirmary's `medBed` (ship life §7). */
export function bedPlacementKeys(deck: DeckDef, machines: MachineTagTable): string[] {
  return deck.machines
    .filter((p) => {
      const tags = machines[p.machineDefId]?.tags ?? [];
      return tags.includes("bed") && !tags.includes("medBed");
    })
    .map((p) => p.key);
}

function checkSize(deck: DeckDef, issues: ValidationIssue[]): void {
  const { sizeClass } = deck.hull;
  const box = HULL_CLASS_BOX[sizeClass];
  if (deck.width > box.w || deck.height > box.h) {
    issues.push(
      issue(
        "physical",
        [...deckPath(deck), "hull", "sizeClass"],
        `${deck.width} x ${deck.height} exceeds the ${sizeClass} box (${box.w} x ${box.h})`,
      ),
    );
  }
}

/** The bow is east: some `bridge` tile lies in the last column. Without a bridge, the tag rule reports. */
function checkBowEast(deck: DeckDef, issues: ValidationIssue[]): void {
  const bridgeSymbols = new Set(
    deck.compartments.filter((c) => c.tags.includes("bridge")).map((c) => c.symbol),
  );
  if (bridgeSymbols.size === 0) return;
  const east = deck.width - 1;
  if (deck.tiles.some((row) => bridgeSymbols.has(row[east] ?? " "))) return;
  issues.push(
    issue(
      "physical",
      [...deckPath(deck), "compartments"],
      `the bridge does not reach the east hull edge (x = ${east}); the bow is east`,
    ),
  );
}

const RAMPS = [
  { field: "cargoRampDoorKey", tiles: "cargoTransferTiles", label: "cargo" },
  { field: "personnelRampDoorKey", tiles: "personnelTransferTiles", label: "personnel" },
] as const;

/** Both ramp doors open south from the bottom row; each transfer tile is at or beside its door. */
function checkRamps(deck: DeckDef, issues: ValidationIssue[]): void {
  const path = deckPath(deck);
  for (const ramp of RAMPS) {
    const key = deck.docking[ramp.field];
    const doorIndex = deck.doors.findIndex((d) => d.key === key);
    const door = deck.doors[doorIndex];
    if (door === undefined) continue; // L2 reports an unknown door key
    const doorPath: Path = [...path, "doors", doorIndex, "edge"];
    const bottom = deck.height - 1;
    if (door.edge.side !== "s") {
      issues.push(
        issue(
          "physical",
          doorPath,
          `ramp door "${key}" faces ${door.edge.side}; ramps face the quay, side s`,
        ),
      );
    } else if (door.edge.y !== bottom) {
      issues.push(
        issue(
          "physical",
          doorPath,
          `ramp door "${key}" is on row ${door.edge.y}, not the bottom row ${bottom}`,
        ),
      );
    }
    const doorTile = { x: door.edge.x, y: door.edge.y };
    deck.docking[ramp.tiles].forEach((tile, i) => {
      if (sameTile(tile, doorTile) || isAdjacent(tile, doorTile)) return;
      issues.push(
        issue(
          "physical",
          [...path, "docking", ramp.tiles, i],
          `${ramp.label} transfer tile ${at(tile)} is not at or beside ramp door "${key}" ${at(doorTile)}`,
        ),
      );
    });
  }
}

function checkCompartmentTags(deck: DeckDef, issues: ValidationIssue[]): void {
  for (const anyOf of REQUIRED_COMPARTMENT_TAGS) {
    if (deck.compartments.some((c) => anyOf.some((tag) => c.tags.includes(tag)))) continue;
    const names = anyOf.map((tag) => `"${tag}"`).join(" or ");
    issues.push(
      issue("physical", [...deckPath(deck), "compartments"], `no compartment tagged ${names}`),
    );
  }
}

function checkMachineTags(
  deck: DeckDef,
  machines: MachineTagTable,
  issues: ValidationIssue[],
): void {
  for (const { tag, exactlyOne } of REQUIRED_MACHINES) {
    const count = placementsTagged(deck, machines, tag).length;
    const problem =
      exactlyOne && count !== 1
        ? `needs exactly one ${tag} machine, found ${count}`
        : !exactlyOne && count === 0
          ? `needs at least one ${tag} machine, found none`
          : undefined;
    if (problem !== undefined) {
      issues.push(issue("physical", [...deckPath(deck), "machines"], problem));
    }
  }
}

function checkZonesAndSpawns(deck: DeckDef, issues: ValidationIssue[]): void {
  const path = deckPath(deck);
  if (!deck.zones.some((z) => z.tags.includes("cargoStowage"))) {
    issues.push(issue("physical", [...path, "zones"], `no zone tagged "cargoStowage"`));
  }
  for (const tag of REQUIRED_SPAWN_TAGS) {
    if (!deck.spawnPoints.some((s) => s.tags.includes(tag))) {
      issues.push(issue("physical", [...path, "spawnPoints"], `no spawn point tagged "${tag}"`));
    }
  }
}

/** Every `locker` zone serves one bed by `machineKey`, and no bed has two (ship life plan call 8). */
function checkLockers(deck: DeckDef, machines: MachineTagTable, issues: ValidationIssue[]): void {
  const placements = new Map(deck.machines.map((p) => [p.key, p]));
  const beds = new Set(bedPlacementKeys(deck, machines));
  const lockerByBed = new Map<string, string>();
  deck.zones.forEach((zone, i) => {
    if (!zone.tags.includes("locker")) return;
    const path: Path = [...deckPath(deck), "zones", i, "machineKey"];
    const bedKey = zone.machineKey;
    if (bedKey === undefined) {
      issues.push(issue("physical", path, `locker "${zone.key}" names no bed (machineKey)`));
      return;
    }
    const placement = placements.get(bedKey);
    if (placement === undefined || machines[placement.machineDefId] === undefined) return; // L2
    if (!beds.has(bedKey)) {
      issues.push(
        issue("physical", path, `locker "${zone.key}" serves "${bedKey}", which is not a bed`),
      );
      return;
    }
    const other = lockerByBed.get(bedKey);
    if (other !== undefined) {
      issues.push(
        issue("physical", path, `lockers "${other}" and "${zone.key}" both serve bed "${bedKey}"`),
      );
      return;
    }
    lockerByBed.set(bedKey, zone.key);
  });
}

/** L3 for one deck: the whole hull contract, every failure its own issue. */
export function checkHullContract(
  deck: DeckDef,
  machines: MachineTagTable,
  issues: ValidationIssue[],
): void {
  checkSize(deck, issues);
  checkBowEast(deck, issues);
  checkRamps(deck, issues);
  checkCompartmentTags(deck, issues);
  checkMachineTags(deck, machines, issues);
  checkZonesAndSpawns(deck, issues);
  checkLockers(deck, machines, issues);
}

/**
 * L3: each crew member starts on their own `crew` spawn point. With fewer points the sim wraps and
 * stacks two people on one tile.
 */
export function checkScenarioCrewSpawns(
  scenario: ScenarioDef,
  deck: DeckDef,
  issues: ValidationIssue[],
): void {
  const points = deck.spawnPoints.filter((s) => s.tags.includes("crew")).length;
  if (points >= scenario.crew.length) return;
  issues.push(
    issue(
      "physical",
      ["scenarios", scenario.id, "crew"],
      `${scenario.crew.length} crew but "${deck.id}" has ${points} crew spawn points`,
    ),
  );
}

/**
 * L3: the scenario's deck sleeps the crew plus one (a passenger or a new hand), counting `bed`
 * placements and never the infirmary's `medBed` (ship life §7, §10).
 */
export function checkScenarioBeds(
  scenario: ScenarioDef,
  deck: DeckDef,
  machines: MachineTagTable,
  issues: ValidationIssue[],
): void {
  const beds = bedPlacementKeys(deck, machines).length;
  const needed = scenario.crew.length + 1;
  if (beds >= needed) return;
  issues.push(
    issue(
      "physical",
      ["scenarios", scenario.id, "crew"],
      `${scenario.crew.length} crew need ${needed} beds (crew + 1) but "${deck.id}" has ${beds}`,
    ),
  );
}
