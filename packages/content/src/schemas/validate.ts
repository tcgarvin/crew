/**
 * One validation path for authored and generated content (review §E.2, D13).
 *
 * - **L1 structural**: Zod, implemented here.
 * - **L2 referential**: every definition ID resolves across the bundle; record keys equal their
 *   value's `id`; no ID collisions; `gen.` namespace only for generated content (checked by the
 *   loader before defs are keyed; see `loader.ts`); each namespace matches its table; local keys
 *   unique within their def; scenario placement/fault keys exist; `unique` items have
 *   `maxStack: 1`; port routes symmetric; price bands `min <= max`; config numbers finite.
 * - **L3 semantic/physical**: tile rows match width/height and use declared symbols; doors and
 *   openings sit on compartment boundaries, ramps on hull edges; footprints in bounds, on floor and
 *   non-overlapping (and don't cover doors); interaction positions walkable and adjacent to
 *   footprints; deck connected; zones on floor; spawn points on floor; recipe tools satisfiable by
 *   some item def, and carried from the start by every scenario whose deck has the machine
 *   (D71). Dock maps (`validate-dock.ts`): rows against the legend, the berth against
 *   each deck's footprint, ramp landings on floor, posts and areas on floor and reachable from
 *   both landings, the size cap.
 * - L4 (simulation smoke) lives in `apps/cli`, not here.
 */
import type {
  ContentBundle,
  CrewDef,
  DeckDef,
  ItemDef,
  MachineDef,
  MachinePlacementDef,
  PortDef,
  ScenarioDef,
  TileCoord,
  TileEdge,
  TraitDef,
} from "@crew/sim";
import { contentBundleSchema } from "./bundle";
import {
  type Path,
  type ValidationIssue,
  type ValidationLevel,
  checkDuplicateLocalKeys,
  issue,
} from "./issues";
import { checkCastSeedPosts, checkDockPhysical, checkDockReferences } from "./validate-dock";

export type { ValidationIssue, ValidationLevel };

export type ValidationResult =
  | { readonly ok: true; readonly bundle: ContentBundle }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/** Thrown by validation levels that are not built yet. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet`);
    this.name = "NotImplementedError";
  }
}

/** L1: shape, types, enums, bounds. */
export function validateStructure(input: unknown): ValidationResult {
  const parsed = contentBundleSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, bundle: parsed.data };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      level: "structural" as const,
      path: issue.path.map((segment) => (typeof segment === "symbol" ? String(segment) : segment)),
      message: issue.message,
    })),
  };
}

/** Namespace prefix each table's def IDs must use (or `gen.` for generated content). */
const NAMESPACE_BY_TABLE: Record<string, string> = {
  decks: "deck",
  machines: "machine",
  items: "item",
  crew: "crew",
  traits: "trait",
  ports: "port",
  scenarios: "scenario",
  docks: "dock",
};

function checkNamespaces(bundle: ContentBundle, issues: ValidationIssue[]): void {
  for (const [table, namespace] of Object.entries(NAMESPACE_BY_TABLE)) {
    const defs = (bundle as unknown as Record<string, Record<string, { id: string }>>)[table] ?? {};
    for (const [key, def] of Object.entries(defs)) {
      if (key !== def.id) {
        issues.push(
          issue(
            "referential",
            [table, key, "id"],
            `record key "${key}" does not match id "${def.id}"`,
          ),
        );
      }
      if (!def.id.startsWith(`${namespace}.`) && !def.id.startsWith("gen.")) {
        issues.push(
          issue(
            "referential",
            [table, key, "id"],
            `id "${def.id}" must start with "${namespace}." or "gen."`,
          ),
        );
      }
    }
  }
}

function checkFiniteNumbers(value: unknown, path: Path, issues: ValidationIssue[]): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      issues.push(issue("referential", path, `expected a finite number, got ${value}`));
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => checkFiniteNumbers(v, [...path, i], issues));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      checkFiniteNumbers(v, [...path, k], issues);
    }
  }
}

function checkDeck(deck: DeckDef, bundle: ContentBundle, issues: ValidationIssue[]): void {
  const path: Path = ["decks", deck.id];
  const doorKeys = new Set(deck.doors.map((d) => d.key));
  const powerDomainKeys = new Set(deck.powerDomains.map((p) => p.key));

  checkDuplicateLocalKeys(
    deck.compartments.map((c) => c.key),
    [...path, "compartments"],
    "compartment",
    issues,
  );
  checkDuplicateLocalKeys(
    deck.doors.map((d) => d.key),
    [...path, "doors"],
    "door",
    issues,
  );
  checkDuplicateLocalKeys(
    deck.machines.map((m) => m.key),
    [...path, "machines"],
    "machine placement",
    issues,
  );
  checkDuplicateLocalKeys(
    deck.zones.map((z) => z.key),
    [...path, "zones"],
    "zone",
    issues,
  );
  checkDuplicateLocalKeys(
    deck.spawnPoints.map((s) => s.key),
    [...path, "spawnPoints"],
    "spawn point",
    issues,
  );
  checkDuplicateLocalKeys(
    deck.powerDomains.map((p) => p.key),
    [...path, "powerDomains"],
    "power domain",
    issues,
  );

  deck.doors.forEach((door, i) => {
    if (door.powerDomain !== undefined && !powerDomainKeys.has(door.powerDomain)) {
      issues.push(
        issue(
          "referential",
          [...path, "doors", i, "powerDomain"],
          `unknown power domain "${door.powerDomain}"`,
        ),
      );
    }
  });

  deck.machines.forEach((placement, i) => {
    if (!(placement.machineDefId in bundle.machines)) {
      issues.push(
        issue(
          "referential",
          [...path, "machines", i, "machineDefId"],
          `unknown machine def "${placement.machineDefId}"`,
        ),
      );
    }
    if (placement.powerDomain !== undefined && !powerDomainKeys.has(placement.powerDomain)) {
      issues.push(
        issue(
          "referential",
          [...path, "machines", i, "powerDomain"],
          `unknown power domain "${placement.powerDomain}"`,
        ),
      );
    }
  });

  if (!doorKeys.has(deck.docking.cargoRampDoorKey)) {
    issues.push(
      issue(
        "referential",
        [...path, "docking", "cargoRampDoorKey"],
        `unknown door key "${deck.docking.cargoRampDoorKey}"`,
      ),
    );
  }
  if (!doorKeys.has(deck.docking.personnelRampDoorKey)) {
    issues.push(
      issue(
        "referential",
        [...path, "docking", "personnelRampDoorKey"],
        `unknown door key "${deck.docking.personnelRampDoorKey}"`,
      ),
    );
  }
}

function checkMachine(machine: MachineDef, bundle: ContentBundle, issues: ValidationIssue[]): void {
  const path: Path = ["machines", machine.id];
  checkDuplicateLocalKeys(
    machine.interactionPositions.map((p) => p.key),
    [...path, "interactionPositions"],
    "interaction position",
    issues,
  );
  checkDuplicateLocalKeys(
    machine.faults.map((f) => f.key),
    [...path, "faults"],
    "fault",
    issues,
  );
  checkDuplicateLocalKeys(
    machine.components.map((c) => c.slot),
    [...path, "components"],
    "component slot",
    issues,
  );

  machine.components.forEach((c, i) => {
    if (!(c.itemDefId in bundle.items)) {
      issues.push(
        issue(
          "referential",
          [...path, "components", i, "itemDefId"],
          `unknown item "${c.itemDefId}"`,
        ),
      );
    }
  });

  const checkStep = (stepPath: Path, step: { consumes: readonly { itemDefId: string }[] }) => {
    step.consumes.forEach((c, i) => {
      if (!(c.itemDefId in bundle.items)) {
        issues.push(
          issue(
            "referential",
            [...stepPath, "consumes", i, "itemDefId"],
            `unknown item "${c.itemDefId}"`,
          ),
        );
      }
    });
  };

  machine.faults.forEach((fault, fi) => {
    checkDuplicateLocalKeys(
      fault.repair.steps.map((s) => s.key),
      [...path, "faults", fi, "repair", "steps"],
      "recipe step",
      issues,
    );
    fault.repair.steps.forEach((step, si) =>
      checkStep([...path, "faults", fi, "repair", "steps", si], step),
    );
  });

  if (machine.maintenance !== undefined) {
    checkStep([...path, "maintenance", "inspect"], machine.maintenance.inspect);
  }
}

function checkItem(item: ItemDef, issues: ValidationIssue[]): void {
  if (item.stacking === "unique" && item.maxStack !== 1) {
    issues.push(
      issue(
        "referential",
        ["items", item.id, "maxStack"],
        `unique item "${item.id}" must have maxStack 1`,
      ),
    );
  }
  // D65: a hand truck is one unique thing with a load it can carry, and only a hand truck has one.
  const truck = item.toolKinds.includes("handTruck");
  const path: Path = ["items", item.id, "capacityUnits"];
  if (truck && (item.capacityUnits === undefined || item.capacityUnits < 2)) {
    issues.push(
      issue("physical", path, `hand truck "${item.id}" needs capacityUnits of at least 2`),
    );
  }
  if (truck && item.stacking !== "unique") {
    issues.push(
      issue("physical", ["items", item.id, "stacking"], `hand truck "${item.id}" must be unique`),
    );
  }
  if (!truck && item.capacityUnits !== undefined) {
    issues.push(
      issue("referential", path, `only a handTruck tool has capacityUnits ("${item.id}")`),
    );
  }
}

function checkCrew(crew: CrewDef, bundle: ContentBundle, issues: ValidationIssue[]): void {
  const path: Path = ["crew", crew.id];
  (crew.traits ?? []).forEach((traitId, i) => {
    if (!(traitId in bundle.traits)) {
      issues.push(issue("referential", [...path, "traits", i], `unknown trait "${traitId}"`));
    }
  });
  crew.startingInventory.forEach((ic, i) => {
    if (!(ic.itemDefId in bundle.items)) {
      issues.push(
        issue(
          "referential",
          [...path, "startingInventory", i, "itemDefId"],
          `unknown item "${ic.itemDefId}"`,
        ),
      );
    }
  });
  if (!bundle.config.shifts.shifts.some((s) => s.key === crew.shift)) {
    issues.push(issue("referential", [...path, "shift"], `unknown shift "${crew.shift}"`));
  }
}

function checkTrait(trait: TraitDef, bundle: ContentBundle, issues: ValidationIssue[]): void {
  trait.excludes.forEach((traitId, i) => {
    if (!(traitId in bundle.traits)) {
      issues.push(
        issue("referential", ["traits", trait.id, "excludes", i], `unknown trait "${traitId}"`),
      );
    }
  });
}

function checkPort(port: PortDef, bundle: ContentBundle, issues: ValidationIssue[]): void {
  const path: Path = ["ports", port.id];
  checkDuplicateLocalKeys(
    port.externalStores.map((s) => s.key),
    [...path, "externalStores"],
    "external store",
    issues,
  );
  checkDuplicateLocalKeys(
    port.jobTemplates.map((j) => j.key),
    [...path, "jobTemplates"],
    "job template",
    issues,
  );

  // D47: a market line names a real item, once per port.
  const marketItems = new Set<string>();
  port.market.forEach((line, i) => {
    if (!(line.itemDefId in bundle.items)) {
      issues.push(
        issue(
          "referential",
          [...path, "market", i, "itemDefId"],
          `unknown item "${line.itemDefId}"`,
        ),
      );
    }
    if (marketItems.has(line.itemDefId)) {
      issues.push(
        issue("referential", [...path, "market", i], `duplicate market item "${line.itemDefId}"`),
      );
    }
    marketItems.add(line.itemDefId);
  });

  port.jobTemplates.forEach((job, i) => {
    if (!(job.toPortId in bundle.ports)) {
      issues.push(
        issue(
          "referential",
          [...path, "jobTemplates", i, "toPortId"],
          `unknown port "${job.toPortId}"`,
        ),
      );
    }
    job.cargo.forEach((c, ci) => {
      if (!(c.itemDefId in bundle.items)) {
        issues.push(
          issue(
            "referential",
            [...path, "jobTemplates", i, "cargo", ci, "itemDefId"],
            `unknown item "${c.itemDefId}"`,
          ),
        );
      }
      if (c.countMin > c.countMax) {
        issues.push(
          issue(
            "referential",
            [...path, "jobTemplates", i, "cargo", ci],
            `countMin (${c.countMin}) exceeds countMax (${c.countMax})`,
          ),
        );
      }
    });
  });

  port.routes.forEach((route, i) => {
    if (!(route.toPortId in bundle.ports)) {
      issues.push(
        issue(
          "referential",
          [...path, "routes", i, "toPortId"],
          `unknown port "${route.toPortId}"`,
        ),
      );
      return;
    }
    const back = bundle.ports[route.toPortId]?.routes.find((r) => r.toPortId === port.id);
    if (back === undefined) {
      issues.push(
        issue(
          "referential",
          [...path, "routes", i],
          `route to "${route.toPortId}" has no return route from it`,
        ),
      );
    } else if (back.distance !== route.distance) {
      issues.push(
        issue(
          "referential",
          [...path, "routes", i, "distance"],
          `route distance ${route.distance} does not match return distance ${back.distance}`,
        ),
      );
    }
  });
}

function checkScenario(
  scenario: ScenarioDef,
  bundle: ContentBundle,
  issues: ValidationIssue[],
): void {
  const path: Path = ["scenarios", scenario.id];
  const deck = bundle.decks[scenario.deckId];
  if (deck === undefined) {
    issues.push(issue("referential", [...path, "deckId"], `unknown deck "${scenario.deckId}"`));
  }
  if (!(scenario.startPortId in bundle.ports)) {
    issues.push(
      issue("referential", [...path, "startPortId"], `unknown port "${scenario.startPortId}"`),
    );
  }
  scenario.crew.forEach((crewId, i) => {
    if (!(crewId in bundle.crew)) {
      issues.push(issue("referential", [...path, "crew", i], `unknown crew "${crewId}"`));
    }
  });

  const zoneKeys = new Set((deck?.zones ?? []).map((z) => z.key));
  scenario.startingItems.forEach((si, i) => {
    if (!(si.itemDefId in bundle.items)) {
      issues.push(
        issue(
          "referential",
          [...path, "startingItems", i, "itemDefId"],
          `unknown item "${si.itemDefId}"`,
        ),
      );
    }
    if (deck !== undefined && !zoneKeys.has(si.zoneKey)) {
      issues.push(
        issue(
          "referential",
          [...path, "startingItems", i, "zoneKey"],
          `unknown zone "${si.zoneKey}"`,
        ),
      );
    }
  });

  const placementByKey = new Map((deck?.machines ?? []).map((m) => [m.key, m]));
  scenario.initialFaults.forEach((fault, i) => {
    const placement = placementByKey.get(fault.placementKey);
    if (placement === undefined) {
      issues.push(
        issue(
          "referential",
          [...path, "initialFaults", i, "placementKey"],
          `unknown machine placement "${fault.placementKey}"`,
        ),
      );
      return;
    }
    const machine = bundle.machines[placement.machineDefId];
    if (machine !== undefined && !machine.faults.some((f) => f.key === fault.faultKey)) {
      issues.push(
        issue(
          "referential",
          [...path, "initialFaults", i, "faultKey"],
          `machine "${machine.id}" has no fault "${fault.faultKey}"`,
        ),
      );
    }
  });
}

function checkPriceBands(bundle: ContentBundle, issues: ValidationIssue[]): void {
  for (const [cls, band] of Object.entries(bundle.config.commerce.priceBands)) {
    if (band.min > band.max) {
      issues.push(
        issue(
          "referential",
          ["config", "commerce", "priceBands", cls],
          `min (${band.min}) exceeds max (${band.max})`,
        ),
      );
    }
  }
}

/** D25: every port with job templates has people to offer them, and every entry is a port. */
function checkPeople(bundle: ContentBundle, issues: ValidationIssue[]): void {
  const people = bundle.people;
  if (people === undefined) return;
  for (const portId of Object.keys(people.ports)) {
    if (!(portId in bundle.ports)) {
      issues.push(issue("referential", ["people", "ports", portId], `unknown port "${portId}"`));
    }
  }
  for (const port of Object.values(bundle.ports)) {
    if (port.jobTemplates.length > 0 && people.ports[port.id] === undefined) {
      issues.push(
        issue(
          "referential",
          ["people", "ports"],
          `port "${port.id}" has job templates but no people entry`,
        ),
      );
    }
  }
}

/** L2: cross-references, uniqueness and closed-namespace rules. */
export function validateReferences(bundle: ContentBundle): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  checkNamespaces(bundle, issues);
  for (const deck of Object.values(bundle.decks)) checkDeck(deck, bundle, issues);
  for (const machine of Object.values(bundle.machines)) checkMachine(machine, bundle, issues);
  for (const item of Object.values(bundle.items)) checkItem(item, issues);
  for (const crew of Object.values(bundle.crew)) checkCrew(crew, bundle, issues);
  for (const trait of Object.values(bundle.traits)) checkTrait(trait, bundle, issues);
  for (const port of Object.values(bundle.ports)) {
    checkPort(port, bundle, issues);
    checkCastSeedPosts(port, bundle, issues);
  }
  checkDockReferences(bundle, issues);
  for (const scenario of Object.values(bundle.scenarios)) checkScenario(scenario, bundle, issues);
  checkPriceBands(bundle, issues);
  checkPeople(bundle, issues);
  checkFiniteNumbers(bundle.config, ["config"], issues);

  return issues;
}

// -------------------------------------------------------------------------------------------
// L3: physical / geometric plausibility
// -------------------------------------------------------------------------------------------

const NEIGHBOR_OFFSET: Record<TileEdge["side"], TileCoord> = {
  n: { x: 0, y: -1 },
  s: { x: 0, y: 1 },
  e: { x: 1, y: 0 },
  w: { x: -1, y: 0 },
};

function neighborTile(edge: TileEdge): TileCoord {
  const d = NEIGHBOR_OFFSET[edge.side];
  return { x: edge.x + d.x, y: edge.y + d.y };
}

function tileKey(t: TileCoord): string {
  return `${t.x},${t.y}`;
}

/** Rotates an offset clockwise (y grows south) by 0/90/180/270 degrees. */
function rotateOffset(offset: TileCoord, rotation: 0 | 90 | 180 | 270): TileCoord {
  switch (rotation) {
    case 0:
      return offset;
    case 90:
      return { x: -offset.y, y: offset.x };
    case 180:
      return { x: -offset.x, y: -offset.y };
    case 270:
      return { x: offset.y, y: -offset.x };
  }
}

function absoluteFootprint(placement: MachinePlacementDef, machine: MachineDef): TileCoord[] {
  return machine.footprint.map((tile) => {
    const rotated = rotateOffset(tile, placement.rotation);
    return { x: placement.origin.x + rotated.x, y: placement.origin.y + rotated.y };
  });
}

function absoluteInteractionTiles(
  placement: MachinePlacementDef,
  machine: MachineDef,
): { key: string; tile: TileCoord }[] {
  return machine.interactionPositions.map((pos) => {
    const rotated = rotateOffset(pos.offset, placement.rotation);
    return {
      key: pos.key,
      tile: { x: placement.origin.x + rotated.x, y: placement.origin.y + rotated.y },
    };
  });
}

function isAdjacent(a: TileCoord, b: TileCoord): boolean {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  return (dx === 1 && dy === 0) || (dx === 0 && dy === 1);
}

/** Deck geometry index: per-tile compartment symbol, bounds and helpers. Rebuilt once per deck. */
function buildDeckIndex(deck: DeckDef) {
  const symbolToCompartment = new Map(deck.compartments.map((c) => [c.symbol, c]));
  const rows = deck.tiles;

  function symbolAt(t: TileCoord): string | undefined {
    if (t.y < 0 || t.y >= deck.height || t.x < 0 || t.x >= deck.width) {
      return undefined;
    }
    const row = rows[t.y];
    const ch = row?.[t.x];
    return ch === " " || ch === undefined ? undefined : ch;
  }

  function compartmentAt(t: TileCoord) {
    const sym = symbolAt(t);
    return sym === undefined ? undefined : symbolToCompartment.get(sym);
  }

  function isFloor(t: TileCoord): boolean {
    return compartmentAt(t) !== undefined;
  }

  return { symbolToCompartment, symbolAt, compartmentAt, isFloor };
}

function checkDeckTiles(deck: DeckDef, issues: ValidationIssue[]): void {
  const path: Path = ["decks", deck.id];
  if (deck.tiles.length !== deck.height) {
    issues.push(
      issue(
        "physical",
        [...path, "tiles"],
        `tiles has ${deck.tiles.length} rows, expected height ${deck.height}`,
      ),
    );
  }
  const validSymbols = new Set(deck.compartments.map((c) => c.symbol));
  deck.tiles.forEach((row, y) => {
    if (row.length !== deck.width) {
      issues.push(
        issue(
          "physical",
          [...path, "tiles", y],
          `row ${y} has length ${row.length}, expected width ${deck.width}`,
        ),
      );
    }
    for (let x = 0; x < row.length; x += 1) {
      const ch = row[x];
      if (ch !== " " && ch !== undefined && !validSymbols.has(ch)) {
        issues.push(
          issue(
            "physical",
            [...path, "tiles", y, x],
            `tile "${ch}" at (${x},${y}) is not a declared compartment symbol`,
          ),
        );
      }
    }
  });
}

function checkDeckEdges(
  deck: DeckDef,
  index: ReturnType<typeof buildDeckIndex>,
  issues: ValidationIssue[],
): void {
  const path: Path = ["decks", deck.id];

  function checkBoundary(edgePath: Path, edge: TileEdge, expectHull: boolean, label: string): void {
    const here = { x: edge.x, y: edge.y };
    const there = neighborTile(edge);
    const hereComp = index.compartmentAt(here);
    const thereComp = index.compartmentAt(there);
    if (hereComp === undefined) {
      issues.push(
        issue("physical", edgePath, `${label} edge tile (${here.x},${here.y}) is not floor`),
      );
      return;
    }
    const isHull = thereComp === undefined;
    if (expectHull && !isHull) {
      issues.push(
        issue(
          "physical",
          edgePath,
          `${label} must be on a hull edge (adjacent to void), found compartment "${thereComp?.key}"`,
        ),
      );
    }
    if (!expectHull) {
      if (isHull) {
        issues.push(
          issue("physical", edgePath, `${label} must be between two compartments, found hull`),
        );
      } else if (thereComp !== undefined && thereComp.key === hereComp.key) {
        issues.push(
          issue(
            "physical",
            edgePath,
            `${label} must be on a boundary between two different compartments`,
          ),
        );
      }
    }
  }

  deck.doors.forEach((door, i) => {
    checkBoundary(
      [...path, "doors", i, "edge"],
      door.edge,
      door.kind === "ramp",
      `door "${door.key}"`,
    );
  });
  deck.openings.forEach((edge, i) => {
    checkBoundary([...path, "openings", i], edge, false, `opening ${i}`);
  });
}

function checkDeckMachines(
  deck: DeckDef,
  bundle: ContentBundle,
  index: ReturnType<typeof buildDeckIndex>,
  issues: ValidationIssue[],
): void {
  const path: Path = ["decks", deck.id];
  const occupied = new Map<string, string>();
  // A door is "covered" only when a single footprint spans both tiles it connects (blocking the
  // aperture itself); merely sitting on one side of a doorway is ordinary floor use.
  const doorSpans: [string, string][] = deck.doors.map((door) => [
    tileKey({ x: door.edge.x, y: door.edge.y }),
    tileKey(neighborTile(door.edge)),
  ]);

  deck.machines.forEach((placement, i) => {
    const machine = bundle.machines[placement.machineDefId];
    if (machine === undefined) {
      return; // reported by L2
    }
    const footprint = absoluteFootprint(placement, machine);
    const footprintKeys = new Set(footprint.map(tileKey));
    for (const tile of footprint) {
      if (!index.isFloor(tile)) {
        issues.push(
          issue(
            "physical",
            [...path, "machines", i],
            `machine "${placement.key}" footprint tile (${tile.x},${tile.y}) is not floor`,
          ),
        );
        continue;
      }
      const key = tileKey(tile);
      const existing = occupied.get(key);
      if (existing !== undefined) {
        issues.push(
          issue(
            "physical",
            [...path, "machines", i],
            `machine "${placement.key}" footprint tile (${tile.x},${tile.y}) overlaps "${existing}"`,
          ),
        );
      } else {
        occupied.set(key, placement.key);
      }
    }
    for (const [a, b] of doorSpans) {
      if (footprintKeys.has(a) && footprintKeys.has(b)) {
        issues.push(
          issue(
            "physical",
            [...path, "machines", i],
            `machine "${placement.key}" footprint spans and covers a door`,
          ),
        );
      }
    }

    const interactions = absoluteInteractionTiles(placement, machine);
    for (const { key: posKey, tile } of interactions) {
      if (!index.isFloor(tile)) {
        issues.push(
          issue(
            "physical",
            [...path, "machines", i],
            `machine "${placement.key}" interaction position "${posKey}" at (${tile.x},${tile.y}) is not walkable`,
          ),
        );
        continue;
      }
      if (!footprint.some((f) => isAdjacent(f, tile))) {
        issues.push(
          issue(
            "physical",
            [...path, "machines", i],
            `machine "${placement.key}" interaction position "${posKey}" is not adjacent to its footprint`,
          ),
        );
      }
    }
  });
}

/** BFS over the compartment graph induced by doors and openings; every compartment must be reachable. */
function checkDeckConnectivity(
  deck: DeckDef,
  index: ReturnType<typeof buildDeckIndex>,
  issues: ValidationIssue[],
): void {
  const path: Path = ["decks", deck.id];
  const adjacency = new Map<string, Set<string>>();
  for (const c of deck.compartments) {
    adjacency.set(c.key, new Set());
  }
  const link = (edge: TileEdge) => {
    const a = index.compartmentAt({ x: edge.x, y: edge.y });
    const b = index.compartmentAt(neighborTile(edge));
    if (a !== undefined && b !== undefined && a.key !== b.key) {
      adjacency.get(a.key)?.add(b.key);
      adjacency.get(b.key)?.add(a.key);
    }
  };
  for (const door of deck.doors) {
    if (door.kind === "interior") {
      link(door.edge);
    }
  }
  for (const opening of deck.openings) {
    link(opening);
  }

  const keys = [...adjacency.keys()];
  if (keys.length === 0) {
    return;
  }
  const start = keys[0] as string;
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const next of adjacency.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  for (const key of keys) {
    if (!seen.has(key)) {
      issues.push(
        issue(
          "physical",
          [...path, "compartments"],
          `compartment "${key}" is not reachable from "${start}" via doors/openings`,
        ),
      );
    }
  }
}

function checkDeckZonesAndSpawns(
  deck: DeckDef,
  index: ReturnType<typeof buildDeckIndex>,
  issues: ValidationIssue[],
): void {
  const path: Path = ["decks", deck.id];
  deck.zones.forEach((zone, zi) => {
    zone.tiles.forEach((tile, ti) => {
      if (!index.isFloor(tile)) {
        issues.push(
          issue(
            "physical",
            [...path, "zones", zi, "tiles", ti],
            `zone "${zone.key}" tile (${tile.x},${tile.y}) is not floor`,
          ),
        );
      }
    });
  });
  deck.spawnPoints.forEach((sp, i) => {
    if (!index.isFloor(sp.tile)) {
      issues.push(
        issue(
          "physical",
          [...path, "spawnPoints", i],
          `spawn point "${sp.key}" tile (${sp.tile.x},${sp.tile.y}) is not floor`,
        ),
      );
    }
  });
  const cargoTiles = [...deck.docking.cargoTransferTiles, ...deck.docking.personnelTransferTiles];
  cargoTiles.forEach((tile, i) => {
    if (!index.isFloor(tile)) {
      issues.push(
        issue(
          "physical",
          [...path, "docking"],
          `transfer tile ${i} at (${tile.x},${tile.y}) is not floor`,
        ),
      );
    }
  });
}

function checkRecipeToolsSatisfiable(bundle: ContentBundle, issues: ValidationIssue[]): void {
  const availableToolKinds = new Set<string>();
  for (const item of Object.values(bundle.items)) {
    for (const kind of item.toolKinds) {
      availableToolKinds.add(kind);
    }
  }
  const checkSteps = (path: Path, steps: readonly { key: string; tools: readonly string[] }[]) => {
    steps.forEach((step, i) => {
      for (const tool of step.tools) {
        if (!availableToolKinds.has(tool)) {
          issues.push(
            issue(
              "physical",
              [...path, i, "tools"],
              `no item def provides tool kind "${tool}" (step "${step.key}")`,
            ),
          );
        }
      }
    });
  };
  for (const machine of Object.values(bundle.machines)) {
    for (const fault of machine.faults) {
      checkSteps(
        ["machines", machine.id, "faults", fault.key, "repair", "steps"],
        fault.repair.steps,
      );
    }
    if (machine.maintenance !== undefined) {
      checkSteps(["machines", machine.id, "maintenance"], [machine.maintenance.inspect]);
    }
  }
}

/**
 * D71: a scenario's ship starts able to do every repair and inspection its own machines' recipes
 * describe: each tool kind a recipe on the scenario's deck names is provided by one of its starting
 * items. A tool only a far port sells left every fault that needs it unrepairable everywhere else
 * (the welder, D69). Markets may still sell tools, as replacements.
 */
function checkScenarioCarriesRecipeTools(bundle: ContentBundle, issues: ValidationIssue[]): void {
  for (const scenario of Object.values(bundle.scenarios)) {
    const deck = bundle.decks[scenario.deckId];
    if (deck === undefined) continue;
    const carried = new Set<string>();
    for (const line of scenario.startingItems) {
      for (const kind of bundle.items[line.itemDefId]?.toolKinds ?? []) carried.add(kind);
    }
    const reported = new Set<string>();
    for (const machineDefId of new Set(deck.machines.map((m) => m.machineDefId))) {
      const machine = bundle.machines[machineDefId];
      if (machine === undefined) continue;
      const steps = [
        ...machine.faults.flatMap((fault) => fault.repair.steps),
        ...(machine.maintenance === undefined ? [] : [machine.maintenance.inspect]),
      ];
      for (const step of steps) {
        for (const tool of step.tools) {
          const key = `${machine.id}:${tool}`;
          if (carried.has(tool) || reported.has(key)) continue;
          reported.add(key);
          issues.push(
            issue(
              "physical",
              ["scenarios", scenario.id, "startingItems"],
              `no starting item provides tool kind "${tool}", which "${machine.id}" needs (step "${step.key}")`,
            ),
          );
        }
      }
    }
  }
}

/** L3: geometry and physical plausibility. */
export function validatePhysical(bundle: ContentBundle): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const deck of Object.values(bundle.decks)) {
    checkDeckTiles(deck, issues);
    const index = buildDeckIndex(deck);
    checkDeckEdges(deck, index, issues);
    checkDeckMachines(deck, bundle, index, issues);
    checkDeckConnectivity(deck, index, issues);
    checkDeckZonesAndSpawns(deck, index, issues);
  }
  for (const dock of Object.values(bundle.docks ?? {})) checkDockPhysical(dock, bundle, issues);
  checkRecipeToolsSatisfiable(bundle, issues);
  checkScenarioCarriesRecipeTools(bundle, issues);

  return issues;
}

/**
 * Full validation, L1 → L3, stopping at the first level with issues.
 */
export function validateBundle(input: unknown): ValidationResult {
  const structural = validateStructure(input);
  if (!structural.ok) {
    return structural;
  }
  for (const level of [validateReferences, validatePhysical]) {
    const issues = level(structural.bundle);
    if (issues.length > 0) {
      return { ok: false, issues };
    }
  }
  return structural;
}
