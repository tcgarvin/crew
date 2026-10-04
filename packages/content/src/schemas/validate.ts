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
import { neighborTile, tileKey } from "./geometry";
import {
  type Path,
  type ValidationIssue,
  type ValidationLevel,
  checkDuplicateLocalKeys,
  checkLocalKeyLists,
  checkRef,
  issue,
} from "./issues";
import { checkCastSeedPosts, checkDockPhysical, checkDockReferences } from "./validate-dock";

export type { ValidationIssue, ValidationLevel };

export type ValidationResult =
  | { readonly ok: true; readonly bundle: ContentBundle }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

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
      const path: Path = [table, key, "id"];
      if (key !== def.id) {
        issues.push(
          issue("referential", path, `record key "${key}" does not match id "${def.id}"`),
        );
      }
      if (!def.id.startsWith(`${namespace}.`) && !def.id.startsWith("gen.")) {
        issues.push(
          issue("referential", path, `id "${def.id}" must start with "${namespace}." or "gen."`),
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
  checkLocalKeyLists(
    path,
    [
      ["compartments", "compartment", deck.compartments.map((c) => c.key)],
      ["doors", "door", deck.doors.map((d) => d.key)],
      ["machines", "machine placement", deck.machines.map((m) => m.key)],
      ["zones", "zone", deck.zones.map((z) => z.key)],
      ["spawnPoints", "spawn point", deck.spawnPoints.map((s) => s.key)],
      ["powerDomains", "power domain", deck.powerDomains.map((p) => p.key)],
    ],
    issues,
  );

  const powerDomainKeys = new Set(deck.powerDomains.map((p) => p.key));
  const checkPowerDomain = (domain: string | undefined, domainPath: Path) => {
    if (domain !== undefined && !powerDomainKeys.has(domain)) {
      issues.push(issue("referential", domainPath, `unknown power domain "${domain}"`));
    }
  };
  deck.doors.forEach((door, i) => {
    checkPowerDomain(door.powerDomain, [...path, "doors", i, "powerDomain"]);
  });
  deck.machines.forEach((placement, i) => {
    const placementPath: Path = [...path, "machines", i];
    checkRef(
      bundle.machines,
      placement.machineDefId,
      "machine def",
      [...placementPath, "machineDefId"],
      issues,
    );
    checkPowerDomain(placement.powerDomain, [...placementPath, "powerDomain"]);
  });

  const doorKeys = new Set(deck.doors.map((d) => d.key));
  for (const field of ["cargoRampDoorKey", "personnelRampDoorKey"] as const) {
    const doorKey = deck.docking[field];
    if (!doorKeys.has(doorKey)) {
      issues.push(
        issue("referential", [...path, "docking", field], `unknown door key "${doorKey}"`),
      );
    }
  }
}

function checkMachine(machine: MachineDef, bundle: ContentBundle, issues: ValidationIssue[]): void {
  const path: Path = ["machines", machine.id];
  checkLocalKeyLists(
    path,
    [
      [
        "interactionPositions",
        "interaction position",
        machine.interactionPositions.map((p) => p.key),
      ],
      ["faults", "fault", machine.faults.map((f) => f.key)],
      ["components", "component slot", machine.components.map((c) => c.slot)],
    ],
    issues,
  );

  machine.components.forEach((c, i) => {
    checkRef(bundle.items, c.itemDefId, "item", [...path, "components", i, "itemDefId"], issues);
  });

  const checkStep = (stepPath: Path, step: { consumes: readonly { itemDefId: string }[] }) => {
    step.consumes.forEach((c, i) => {
      checkRef(
        bundle.items,
        c.itemDefId,
        "item",
        [...stepPath, "consumes", i, "itemDefId"],
        issues,
      );
    });
  };

  machine.faults.forEach((fault, fi) => {
    const stepsPath: Path = [...path, "faults", fi, "repair", "steps"];
    checkDuplicateLocalKeys(
      fault.repair.steps.map((s) => s.key),
      stepsPath,
      "recipe step",
      issues,
    );
    fault.repair.steps.forEach((step, si) => checkStep([...stepsPath, si], step));
  });

  if (machine.maintenance !== undefined) {
    checkStep([...path, "maintenance", "inspect"], machine.maintenance.inspect);
  }
}

function checkItem(item: ItemDef, issues: ValidationIssue[]): void {
  const path: Path = ["items", item.id];
  if (item.stacking === "unique" && item.maxStack !== 1) {
    issues.push(
      issue("referential", [...path, "maxStack"], `unique item "${item.id}" must have maxStack 1`),
    );
  }
  // D65: a hand truck is one unique thing with a load it can carry, and only a hand truck has one.
  const truck = item.toolKinds.includes("handTruck");
  const capacityPath: Path = [...path, "capacityUnits"];
  if (truck && (item.capacityUnits === undefined || item.capacityUnits < 2)) {
    issues.push(
      issue("physical", capacityPath, `hand truck "${item.id}" needs capacityUnits of at least 2`),
    );
  }
  if (truck && item.stacking !== "unique") {
    issues.push(issue("physical", [...path, "stacking"], `hand truck "${item.id}" must be unique`));
  }
  if (!truck && item.capacityUnits !== undefined) {
    issues.push(
      issue("referential", capacityPath, `only a handTruck tool has capacityUnits ("${item.id}")`),
    );
  }
}

function checkCrew(crew: CrewDef, bundle: ContentBundle, issues: ValidationIssue[]): void {
  const path: Path = ["crew", crew.id];
  (crew.traits ?? []).forEach((traitId, i) => {
    checkRef(bundle.traits, traitId, "trait", [...path, "traits", i], issues);
  });
  crew.startingInventory.forEach((ic, i) => {
    checkRef(
      bundle.items,
      ic.itemDefId,
      "item",
      [...path, "startingInventory", i, "itemDefId"],
      issues,
    );
  });
  if (!bundle.config.shifts.shifts.some((s) => s.key === crew.shift)) {
    issues.push(issue("referential", [...path, "shift"], `unknown shift "${crew.shift}"`));
  }
}

function checkTrait(trait: TraitDef, bundle: ContentBundle, issues: ValidationIssue[]): void {
  trait.excludes.forEach((traitId, i) => {
    checkRef(bundle.traits, traitId, "trait", ["traits", trait.id, "excludes", i], issues);
  });
}

function checkPort(port: PortDef, bundle: ContentBundle, issues: ValidationIssue[]): void {
  const path: Path = ["ports", port.id];
  checkLocalKeyLists(
    path,
    [
      ["externalStores", "external store", port.externalStores.map((s) => s.key)],
      ["jobTemplates", "job template", port.jobTemplates.map((j) => j.key)],
    ],
    issues,
  );

  // D47: a market line names a real item, once per port.
  const marketItems = new Set<string>();
  port.market.forEach((line, i) => {
    checkRef(bundle.items, line.itemDefId, "item", [...path, "market", i, "itemDefId"], issues);
    if (marketItems.has(line.itemDefId)) {
      issues.push(
        issue("referential", [...path, "market", i], `duplicate market item "${line.itemDefId}"`),
      );
    }
    marketItems.add(line.itemDefId);
  });

  port.jobTemplates.forEach((job, i) => {
    const jobPath: Path = [...path, "jobTemplates", i];
    checkRef(bundle.ports, job.toPortId, "port", [...jobPath, "toPortId"], issues);
    job.cargo.forEach((c, ci) => {
      const cargoPath: Path = [...jobPath, "cargo", ci];
      checkRef(bundle.items, c.itemDefId, "item", [...cargoPath, "itemDefId"], issues);
      if (c.countMin > c.countMax) {
        issues.push(
          issue(
            "referential",
            cargoPath,
            `countMin (${c.countMin}) exceeds countMax (${c.countMax})`,
          ),
        );
      }
    });
  });

  port.routes.forEach((route, i) => {
    const routePath: Path = [...path, "routes", i];
    if (!checkRef(bundle.ports, route.toPortId, "port", [...routePath, "toPortId"], issues)) return;
    const back = bundle.ports[route.toPortId]?.routes.find((r) => r.toPortId === port.id);
    if (back === undefined) {
      issues.push(
        issue("referential", routePath, `route to "${route.toPortId}" has no return route from it`),
      );
    } else if (back.distance !== route.distance) {
      issues.push(
        issue(
          "referential",
          [...routePath, "distance"],
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
  checkRef(bundle.ports, scenario.startPortId, "port", [...path, "startPortId"], issues);
  scenario.crew.forEach((crewId, i) => {
    checkRef(bundle.crew, crewId, "crew", [...path, "crew", i], issues);
  });

  const zoneKeys = new Set((deck?.zones ?? []).map((z) => z.key));
  scenario.startingItems.forEach((si, i) => {
    const itemPath: Path = [...path, "startingItems", i];
    checkRef(bundle.items, si.itemDefId, "item", [...itemPath, "itemDefId"], issues);
    if (deck !== undefined && !zoneKeys.has(si.zoneKey)) {
      issues.push(issue("referential", [...itemPath, "zoneKey"], `unknown zone "${si.zoneKey}"`));
    }
  });

  const placementByKey = new Map((deck?.machines ?? []).map((m) => [m.key, m]));
  scenario.initialFaults.forEach((fault, i) => {
    const faultPath: Path = [...path, "initialFaults", i];
    const placement = placementByKey.get(fault.placementKey);
    if (placement === undefined) {
      issues.push(
        issue(
          "referential",
          [...faultPath, "placementKey"],
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
          [...faultPath, "faultKey"],
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
    checkRef(bundle.ports, portId, "port", ["people", "ports", portId], issues);
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

/** A machine-frame offset in deck coordinates, for this placement. */
function placeOffset(placement: MachinePlacementDef, offset: TileCoord): TileCoord {
  const rotated = rotateOffset(offset, placement.rotation);
  return { x: placement.origin.x + rotated.x, y: placement.origin.y + rotated.y };
}

function isAdjacent(a: TileCoord, b: TileCoord): boolean {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  return (dx === 1 && dy === 0) || (dx === 0 && dy === 1);
}

/** Deck geometry index: the compartment under each tile, and floor. Rebuilt once per deck. */
function buildDeckIndex(deck: DeckDef) {
  const symbolToCompartment = new Map(deck.compartments.map((c) => [c.symbol, c]));

  /** Undefined off the grid and on void (symbols are never whitespace). */
  function compartmentAt(t: TileCoord) {
    if (t.y < 0 || t.y >= deck.height || t.x < 0 || t.x >= deck.width) {
      return undefined;
    }
    const ch = deck.tiles[t.y]?.[t.x];
    return ch === undefined ? undefined : symbolToCompartment.get(ch);
  }

  function isFloor(t: TileCoord): boolean {
    return compartmentAt(t) !== undefined;
  }

  return { compartmentAt, isFloor };
}

type DeckIndex = ReturnType<typeof buildDeckIndex>;

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

function checkDeckEdges(deck: DeckDef, index: DeckIndex, issues: ValidationIssue[]): void {
  const path: Path = ["decks", deck.id];

  function checkBoundary(edgePath: Path, edge: TileEdge, expectHull: boolean, label: string): void {
    const hereComp = index.compartmentAt(edge);
    const thereComp = index.compartmentAt(neighborTile(edge));
    if (hereComp === undefined) {
      issues.push(
        issue("physical", edgePath, `${label} edge tile (${edge.x},${edge.y}) is not floor`),
      );
      return;
    }
    let problem: string | undefined;
    if (expectHull) {
      if (thereComp !== undefined) {
        problem = `${label} must be on a hull edge (adjacent to void), found compartment "${thereComp.key}"`;
      }
    } else if (thereComp === undefined) {
      problem = `${label} must be between two compartments, found hull`;
    } else if (thereComp.key === hereComp.key) {
      problem = `${label} must be on a boundary between two different compartments`;
    }
    if (problem !== undefined) issues.push(issue("physical", edgePath, problem));
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
  index: DeckIndex,
  issues: ValidationIssue[],
): void {
  const occupied = new Map<string, string>();
  // A door is "covered" only when a single footprint spans both tiles it connects (blocking the
  // aperture itself); merely sitting on one side of a doorway is ordinary floor use.
  const doorSpans: [string, string][] = deck.doors.map((door) => [
    tileKey(door.edge),
    tileKey(neighborTile(door.edge)),
  ]);

  deck.machines.forEach((placement, i) => {
    const machine = bundle.machines[placement.machineDefId];
    if (machine === undefined) {
      return; // reported by L2
    }
    const report = (message: string) =>
      issues.push(issue("physical", ["decks", deck.id, "machines", i], message));
    const name = `machine "${placement.key}"`;
    const footprint = machine.footprint.map((offset) => placeOffset(placement, offset));
    const footprintKeys = new Set(footprint.map(tileKey));
    for (const tile of footprint) {
      if (!index.isFloor(tile)) {
        report(`${name} footprint tile (${tile.x},${tile.y}) is not floor`);
        continue;
      }
      const key = tileKey(tile);
      const existing = occupied.get(key);
      if (existing !== undefined) {
        report(`${name} footprint tile (${tile.x},${tile.y}) overlaps "${existing}"`);
      } else {
        occupied.set(key, placement.key);
      }
    }
    for (const [a, b] of doorSpans) {
      if (footprintKeys.has(a) && footprintKeys.has(b)) {
        report(`${name} footprint spans and covers a door`);
      }
    }

    for (const pos of machine.interactionPositions) {
      const tile = placeOffset(placement, pos.offset);
      if (!index.isFloor(tile)) {
        report(
          `${name} interaction position "${pos.key}" at (${tile.x},${tile.y}) is not walkable`,
        );
      } else if (!footprint.some((f) => isAdjacent(f, tile))) {
        report(`${name} interaction position "${pos.key}" is not adjacent to its footprint`);
      }
    }
  });
}

/** BFS over the compartment graph induced by doors and openings; every compartment must be reachable. */
function checkDeckConnectivity(deck: DeckDef, index: DeckIndex, issues: ValidationIssue[]): void {
  const adjacency = new Map<string, Set<string>>();
  for (const c of deck.compartments) {
    adjacency.set(c.key, new Set());
  }
  const link = (edge: TileEdge) => {
    const a = index.compartmentAt(edge);
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

  const [start] = adjacency.keys();
  if (start === undefined) {
    return;
  }
  const seen = new Set([start]);
  const stack = [start];
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    for (const next of adjacency.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  for (const key of adjacency.keys()) {
    if (!seen.has(key)) {
      issues.push(
        issue(
          "physical",
          ["decks", deck.id, "compartments"],
          `compartment "${key}" is not reachable from "${start}" via doors/openings`,
        ),
      );
    }
  }
}

function checkDeckZonesAndSpawns(deck: DeckDef, index: DeckIndex, issues: ValidationIssue[]): void {
  const path: Path = ["decks", deck.id];
  const requireFloor = (tile: TileCoord, tilePath: Path, what: string) => {
    if (!index.isFloor(tile)) {
      issues.push(issue("physical", tilePath, `${what} (${tile.x},${tile.y}) is not floor`));
    }
  };
  deck.zones.forEach((zone, zi) => {
    zone.tiles.forEach((tile, ti) => {
      requireFloor(tile, [...path, "zones", zi, "tiles", ti], `zone "${zone.key}" tile`);
    });
  });
  deck.spawnPoints.forEach((sp, i) => {
    requireFloor(sp.tile, [...path, "spawnPoints", i], `spawn point "${sp.key}" tile`);
  });
  const transferTiles = [
    ...deck.docking.cargoTransferTiles,
    ...deck.docking.personnelTransferTiles,
  ];
  transferTiles.forEach((tile, i) => {
    requireFloor(tile, [...path, "docking"], `transfer tile ${i} at`);
  });
}

function checkRecipeToolsSatisfiable(bundle: ContentBundle, issues: ValidationIssue[]): void {
  const availableToolKinds = new Set<string>(
    Object.values(bundle.items).flatMap((item) => item.toolKinds),
  );
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
    const carried = new Set(
      scenario.startingItems.flatMap((line) => bundle.items[line.itemDefId]?.toolKinds ?? []),
    );
    for (const machineDefId of new Set(deck.machines.map((m) => m.machineDefId))) {
      const machine = bundle.machines[machineDefId];
      if (machine === undefined) continue;
      const steps = [
        ...machine.faults.flatMap((fault) => fault.repair.steps),
        ...(machine.maintenance === undefined ? [] : [machine.maintenance.inspect]),
      ];
      const reported = new Set<string>();
      for (const step of steps) {
        for (const tool of step.tools) {
          if (carried.has(tool) || reported.has(tool)) continue;
          reported.add(tool);
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
