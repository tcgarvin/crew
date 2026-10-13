/**
 * One validation path for authored and generated content (review §E.2, D13).
 *
 * - **L1 structural**: Zod, implemented here.
 * - **L2 referential**: every definition ID resolves across the bundle; record keys equal their
 *   value's `id`; no ID collisions; `gen.` namespace only for generated content (checked by the
 *   loader before defs are keyed; see `loader.ts`); each namespace matches its table; local keys
 *   unique within their def; a zone's `machineKey` names a placement on its deck; scenario
 *   placement/fault keys exist; `unique` items have `maxStack: 1`; port routes symmetric; price
 *   bands `min <= max`; config numbers finite. §sections-and-dayworkers: every watch-bill member is
 *   in the scenario's crew, and dayworkers' watches exist in the day; §thoughts: each thought sits
 *   under its own key. Slice 4 (§activities-and-interests): an activity's topics and product
 *   resolve and its required item tag is carried by some item def, by a `personal` one when it must
 *   be the actor's own; at most four take part (one plate's worth); a group activity that is not a
 *   contest says how it is done alone (`solo`); a thought label carries `{ref}` only for a key the
 *   sim gives a `refId`.
 * - **L3 semantic/physical**: tile rows match width/height and use declared symbols; doors and
 *   openings sit on compartment boundaries, ramps on hull edges; footprints in bounds, on floor and
 *   non-overlapping (and don't cover doors); interaction positions walkable and adjacent to
 *   footprints; deck connected; zones on floor; spawn points on floor; recipe tools satisfiable by
 *   some item def, and carried from the start by every scenario whose deck has the machine
 *   (§scenario-tools). The hull contract (`validate-hull.ts`, §what-a-deck-must-offer): size class,
 *   bow east, ramps south, the rooms, stations, zones and spawn points every deck needs, the helm's
 *   standby position (§handover), lockers serving beds; a scenario's crew each get a crew spawn
 *   point. §sections-and-dayworkers: a scenario's watch bill has a section per watch of the day,
 *   each with a helm-qualified member, and only a fixture-sized crew may go without one
 *   (`checkScenarioWatchBill`). Dock maps (`validate-dock.ts`): rows against the legend, the berth
 *   box on the map and void, each deck's ramp landings on floor, posts and areas on floor and
 *   reachable from both landings, the quay row under the box walkable, the size cap; a scenario's
 *   ship fits every berth box and has beds for its crew + 1 (`checkScenarioBeds`). Activity venues
 *   (`validate-venues.ts`, §activities-and-interests): a present venue fits `participants.max`, a
 *   product's zone exists, and a scenario's deck hosts every activity; a deck no scenario sails may
 *   lack some, reported as notes (`activityVenueNotes`).
 * - L4 (simulation smoke) lives in `apps/cli`, not here.
 */
import type {
  ActivityDef,
  ContentBundle,
  CrewDef,
  DeckDef,
  ItemDef,
  MachineDef,
  MachinePlacementDef,
  PortDef,
  ScenarioDef,
  SkillId,
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
import {
  checkCastSeedPosts,
  checkDockPhysical,
  checkDockReferences,
  checkScenarioBerths,
} from "./validate-dock";
import { checkHullContract, checkScenarioBeds, checkScenarioCrewSpawns } from "./validate-hull";
import { checkActivityVenues } from "./validate-venues";

export type { ValidationIssue, ValidationLevel };
export { activityVenueNotes, hostedVenues } from "./validate-venues";

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
  activities: "activity",
  topics: "topic",
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

  // Ship life plan call 8: a zone serves a placement on its own deck (a locker, its bed).
  const placementKeys = new Set(deck.machines.map((m) => m.key));
  deck.zones.forEach((zone, i) => {
    if (zone.machineKey !== undefined && !placementKeys.has(zone.machineKey)) {
      issues.push(
        issue(
          "referential",
          [...path, "zones", i, "machineKey"],
          `zone "${zone.key}" names unknown machine placement "${zone.machineKey}"`,
        ),
      );
    }
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

  // §diagnosis: a fault is diagnosed at the machine's `repair` positions, so a machine that can
  // break needs one, and each repair step stands at a purpose some position offers.
  const purposes = new Set(machine.interactionPositions.flatMap((p) => p.purposes));
  if (machine.faults.length > 0 && !purposes.has("repair")) {
    issues.push(
      issue(
        "referential",
        [...path, "interactionPositions"],
        `machine "${machine.id}" has faults but no "repair" interaction position to diagnose them at`,
      ),
    );
  }
  machine.faults.forEach((fault, fi) => {
    fault.repair.steps.forEach((step, si) => {
      if (purposes.has(step.at)) return;
      issues.push(
        issue(
          "referential",
          [...path, "faults", fi, "repair", "steps", si, "at"],
          `repair step "${step.key}" stands at "${step.at}", which no interaction position offers`,
        ),
      );
    });
  });

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
  // §hand-truck-trips: a hand truck is one unique thing with a load it can carry, and only a hand
  // truck has one.
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

  // §market-stock: a market line names a real item, once per port.
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

  // Expeditions A1 (§3.1, call 1): a site's one route runs to its port, which never lists it back,
  // so nothing sails to a site until A2.
  if (port.kind === "site" && port.nearPortId !== undefined) {
    if (checkRef(bundle.ports, port.nearPortId, "port", [...path, "nearPortId"], issues)) {
      if (bundle.ports[port.nearPortId]?.kind === "site") {
        issues.push(
          issue("referential", [...path, "nearPortId"], "a site lies near a port, not a site"),
        );
      }
    }
  }
  port.routes.forEach((route, i) => {
    const routePath: Path = [...path, "routes", i];
    if (!checkRef(bundle.ports, route.toPortId, "port", [...routePath, "toPortId"], issues)) return;
    if (bundle.ports[route.toPortId]?.kind === "site") {
      issues.push(
        issue(
          "referential",
          routePath,
          `a port never lists a site in its routes ("${route.toPortId}")`,
        ),
      );
      return;
    }
    if (port.kind === "site") return;
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
  checkWatchBillCrew(scenario, path, issues);
}

/**
 * §sections-and-dayworkers: every watch-bill member is one of the scenario's crew (L1 has ruled out
 * duplicates).
 */
function checkWatchBillCrew(scenario: ScenarioDef, path: Path, issues: ValidationIssue[]): void {
  const bill = scenario.watchBill;
  if (bill === undefined) return;
  const crew = new Set<string>(scenario.crew);
  const check = (id: string, memberPath: Path) => {
    if (!crew.has(id)) {
      issues.push(
        issue("referential", memberPath, `"${id}" is in the watch bill but not the crew`),
      );
    }
  };
  bill.sections.forEach((section, i) => {
    section.members.forEach((id, j) => {
      check(id, [...path, "watchBill", "sections", i, "members", j]);
    });
  });
  bill.dayworkers.forEach((id, j) => check(id, [...path, "watchBill", "dayworkers", j]));
}

/** §sections-and-dayworkers: dayworkers' watches are watches of the day, each listed once. */
function checkDayworkerWatches(bundle: ContentBundle, issues: ValidationIssue[]): void {
  const watches = bundle.config.time.watchesPerDay;
  const seen = new Set<number>();
  bundle.config.watches.dayworkerOnWatches.forEach((watch, i) => {
    const path: Path = ["config", "watches", "dayworkerOnWatches", i];
    if (watch >= watches) {
      issues.push(issue("referential", path, `watch ${watch} is not one of the ${watches} a day`));
    }
    if (seen.has(watch)) issues.push(issue("referential", path, `watch ${watch} is listed twice`));
    seen.add(watch);
  });
}

/**
 * The thoughts the sim gives with a `refId` (the rival, the one argued with; the narrator's
 * `giveThought` of someone to worry about or grieve for, which refuses one without,
 * §thought-and-reveal-levers); the inspector and the digest fill `{ref}` from it. Any other key
 * would show the placeholder itself.
 */
const THOUGHTS_WITH_REF: ReadonlySet<string> = new Set([
  "keepsBeatingMe",
  "argued",
  "worriedAbout",
  "grieving",
]);

/**
 * §thoughts: each thought def sits under its own key; §crew-lines: `{ref}` only where a `refId`
 * comes.
 */
function checkThoughtKeys(bundle: ContentBundle, issues: ValidationIssue[]): void {
  for (const [key, def] of Object.entries(bundle.thoughts)) {
    if (def.key !== key) {
      issues.push(
        issue("referential", ["thoughts", key, "key"], `thought "${def.key}" is under "${key}"`),
      );
    }
    if (def.label.includes("{ref}") && !THOUGHTS_WITH_REF.has(key)) {
      issues.push(
        issue(
          "referential",
          ["thoughts", key, "label"],
          `"{ref}" in the label of "${key}", which the sim never gives a refId`,
        ),
      );
    }
  }
}

/**
 * §cooking-and-serving: the galley finds what it cooks from and what it serves by tag, so no item
 * id lives in config: exactly one `meal`-tagged item def (with a `nutrition`), at least one
 * `provisions`.
 */
function checkGalleyItems(bundle: ContentBundle, issues: ValidationIssue[]): void {
  const items = Object.values(bundle.items);
  const meals = items.filter((item) => item.tags.includes("meal"));
  if (meals.length !== 1) {
    issues.push(
      issue(
        "referential",
        ["items"],
        `expected exactly one "meal"-tagged item, found ${meals.length}`,
      ),
    );
  }
  for (const meal of meals) {
    if (!meal.tags.includes("food") || meal.nutrition === undefined) {
      issues.push(
        issue(
          "referential",
          ["items", meal.id, "tags"],
          `meal "${meal.id}" must be food with a nutrition`,
        ),
      );
    }
  }
  if (!items.some((item) => item.tags.includes("provisions"))) {
    issues.push(issue("referential", ["items"], 'expected at least one "provisions"-tagged item'));
  }
}

/**
 * One session renders as one plate of first names at the venue (§activities-and-interests): four
 * fit.
 */
const MAX_PARTICIPANTS = 4;

/**
 * Slice 4: an activity's references resolve: its `topics`, the item it `produces`, and the tag it
 * `requires` is carried by some item def (a `personal` one when it must be the actor's own). Its
 * thought keys and problem kinds are closed enums (L1). The venue rules against each deck are L3.
 */
function checkActivities(bundle: ContentBundle, issues: ValidationIssue[]): void {
  const items = Object.values(bundle.items);
  const itemTags = new Set(items.flatMap((item) => item.tags));
  const personalTags = new Set(
    items.filter((item) => item.tags.includes("personal")).flatMap((item) => item.tags),
  );
  for (const activity of Object.values(bundle.activities)) {
    const path: Path = ["activities", activity.id];
    checkActivityShape(activity, path, issues);
    const owned = activity.requires;
    if (owned?.own === true && itemTags.has(owned.itemTag) && !personalTags.has(owned.itemTag)) {
      issues.push(
        issue(
          "referential",
          [...path, "requires", "own"],
          `no "personal" item def carries the tag "${owned.itemTag}", so nobody owns one`,
        ),
      );
    }
    (activity.topics ?? []).forEach((topicId, i) => {
      checkRef(bundle.topics, topicId, "topic", [...path, "topics", i], issues);
    });
    if (activity.produces !== undefined) {
      const at: Path = [...path, "produces", "itemDefId"];
      checkRef(bundle.items, activity.produces.itemDefId, "item", at, issues);
    }
    const required = activity.requires?.itemTag;
    if (required !== undefined && !itemTags.has(required)) {
      issues.push(
        issue(
          "referential",
          [...path, "requires", "itemTag"],
          `no item def carries the tag "${required}"`,
        ),
      );
    }
  }
}

/**
 * §activities-and-interests: at most `MAX_PARTICIPANTS` take part; a group activity that is not a
 * contest has a `solo` variant, so a session nobody joined still restores something (a contest
 * without one fails).
 */
function checkActivityShape(activity: ActivityDef, path: Path, issues: ValidationIssue[]): void {
  const { min, max } = activity.participants;
  if (max > MAX_PARTICIPANTS) {
    issues.push(
      issue(
        "referential",
        [...path, "participants", "max"],
        `${max} participants; one session's plate names at most ${MAX_PARTICIPANTS}`,
      ),
    );
  }
  if (min >= 2 && activity.outcome !== "contest" && activity.solo === undefined) {
    issues.push(
      issue(
        "referential",
        [...path, "solo"],
        `a ${activity.outcome} for ${min} or more needs a solo variant for when nobody joins`,
      ),
    );
  }
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

/**
 * §issuers-and-pitches: every port with job templates has people to offer them, and every entry is
 * a port. No given name is a crew member's first name: labels and log lines call people by first
 * name, so a dock local named like a crew member reads as them.
 */
function checkPeople(bundle: ContentBundle, issues: ValidationIssue[]): void {
  const people = bundle.people;
  if (people === undefined) return;
  const crewByFirstName = new Map(
    Object.values(bundle.crew).map((crew) => [crew.name.split(" ")[0] ?? crew.name, crew.id]),
  );
  people.givenNames.forEach((given, i) => {
    const crewId = crewByFirstName.get(given);
    if (crewId !== undefined) {
      issues.push(
        issue(
          "referential",
          ["people", "givenNames", i],
          `given name "${given}" is the first name of crew "${crewId}"`,
        ),
      );
    }
  });
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
  checkDayworkerWatches(bundle, issues);
  checkThoughtKeys(bundle, issues);
  checkGalleyItems(bundle, issues);
  checkActivities(bundle, issues);
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
 * §scenario-tools: a scenario's ship starts able to do every repair and inspection its own
 * machines' recipes describe: each tool kind a recipe on the scenario's deck names is provided by
 * one of its starting items. A tool only a far port sells left every fault that needs it
 * unrepairable everywhere else (the welder). Markets may still sell tools, as replacements.
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

/**
 * §sections-and-dayworkers: more crew than this need an authored watch bill; the generated one is
 * for test fixtures.
 */
const MAX_CREW_WITHOUT_WATCH_BILL = 3;

/** The skill and level a helm-stander needs on `deck`: its pilot station's operator requirement. */
function helmRequirement(
  deck: DeckDef,
  bundle: ContentBundle,
): { readonly skill: SkillId; readonly min: number } | undefined {
  for (const placement of deck.machines) {
    const def = bundle.machines[placement.machineDefId];
    if (def?.tags.includes("pilotStation") !== true) continue;
    return def.operation.operatorSkill ?? { skill: "piloting", min: 0 };
  }
  return undefined; // the hull contract reports a deck without a pilot station
}

/**
 * §sections-and-dayworkers (ship life plan, slice 2 call 4): section `i` stands watch `i` of the
 * day with no wrap, so an authored bill has exactly `time.watchesPerDay` sections or some watch has
 * nobody on it; each section needs a member qualified for the helm, or its watch has no stander.
 * Membership, nobody listed twice and dayworkers apart from the sections are L1 and L2. A scenario
 * without a bill gets a generated one, which is for fixtures of at most
 * `MAX_CREW_WITHOUT_WATCH_BILL` crew.
 */
function checkScenarioWatchBill(
  scenario: ScenarioDef,
  deck: DeckDef,
  bundle: ContentBundle,
  issues: ValidationIssue[],
): void {
  const path: Path = ["scenarios", scenario.id];
  const bill = scenario.watchBill;
  if (bill === undefined) {
    if (scenario.crew.length <= MAX_CREW_WITHOUT_WATCH_BILL) return;
    issues.push(
      issue(
        "physical",
        [...path, "crew"],
        `${scenario.crew.length} crew and no watch bill: author one (a section per watch, each with a helm-stander, and dayworkers); a generated bill is for fixtures of at most ${MAX_CREW_WITHOUT_WATCH_BILL} crew`,
      ),
    );
    return;
  }
  const watches = bundle.config.time.watchesPerDay;
  if (bill.sections.length !== watches) {
    issues.push(
      issue(
        "physical",
        [...path, "watchBill", "sections"],
        `${bill.sections.length} watch-bill sections for ${watches} watches a day; each watch needs its section`,
      ),
    );
  }
  const helm = helmRequirement(deck, bundle);
  if (helm === undefined) return;
  bill.sections.forEach((section, i) => {
    const qualified = section.members.some(
      (id) => (bundle.crew[id]?.skills[helm.skill] ?? 0) >= helm.min,
    );
    if (qualified) return;
    issues.push(
      issue(
        "physical",
        [...path, "watchBill", "sections", i, "members"],
        `no qualified helm-stander in section "${section.key}" (needs ${helm.skill} ${helm.min})`,
      ),
    );
  });
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
    checkHullContract(deck, bundle.machines, issues);
    checkActivityVenues(deck, bundle, issues);
  }
  for (const dock of Object.values(bundle.docks ?? {})) checkDockPhysical(dock, bundle, issues);
  for (const scenario of Object.values(bundle.scenarios)) {
    checkScenarioBerths(scenario, bundle, issues);
    const deck = bundle.decks[scenario.deckId];
    if (deck === undefined) continue; // reported by L2
    checkScenarioCrewSpawns(scenario, deck, issues);
    checkScenarioBeds(scenario, deck, bundle.machines, issues);
    checkScenarioWatchBill(scenario, deck, bundle, issues);
  }
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
