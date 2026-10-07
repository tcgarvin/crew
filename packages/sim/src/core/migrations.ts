/**
 * Save migrations, keyed by the schema version they upgrade *from* (see `save.ts`). Each takes
 * untrusted JSON and must tolerate missing or odd fields: anything it does not recognise is left
 * for the invariants to judge.
 */
import { watchIndexAt } from "./clock";
import { emptyCells } from "./dirt-grid";
import { berthDock, dockAreaTiles } from "./docks";
import { interestsFromSeed } from "./interests";
import { SaveCompatibilityError } from "./save-error";
import type { TileCoord } from "./types/common";
import type { ItemDef } from "./types/content";
import type { ActorId, CrewDefId, DeckDefId, DockDefId, ScenarioDefId } from "./types/ids";
import type { MigrationContext, MigrationRegistry } from "./types/save";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 1 → 2 (D25): a job's `issuer` was a bare string (usually a company). It stays as the display
 * label; the person becomes that name with the role "shipper", the pitch a generic template
 * line, and the urgency "relaxed". The literals mirror `LEGACY_ISSUER_ROLE` and
 * `DEFAULT_PITCH_KEY` in `systems/commerce/jobs.ts` (core may not import systems); a migration
 * is frozen once shipped, so they must not follow later changes to those constants anyway.
 */
export function migrateJobsToPeople(raw: unknown): unknown {
  if (!isRecord(raw) || !isRecord(raw.jobs)) return raw;
  for (const job of Object.values(raw.jobs)) {
    if (!isRecord(job) || isRecord(job.issuerPerson)) continue;
    const name = typeof job.issuer === "string" ? job.issuer : "A dockside broker";
    job.issuer = name;
    job.issuerPerson = { name, role: "shipper" };
    if (!isRecord(job.pitch)) job.pitch = { key: "job.pitch.default", params: {} };
    if (typeof job.urgency !== "string") job.urgency = "relaxed";
  }
  return raw;
}

/**
 * 2 → 3 (D47): `markets` is a new slice. An empty table is enough: a port with no entry reads
 * as its content seed (`core/markets.ts` `effectiveMarket`), so a save from before the market
 * existed opens every port at its authored stock the first time anyone looks.
 */
function addMarkets(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  if (!isRecord(raw.markets)) raw.markets = {};
  return raw;
}

/** The port whose dock is alongside at a saved travel stage (D61), read from untrusted JSON. */
function portAlongside(travel: Record<string, unknown>): string | undefined {
  const field =
    travel.stage === "docked"
      ? "portId"
      : travel.stage === "docking"
        ? "toPortId"
        : travel.stage === "preparingDeparture" || travel.stage === "undocking"
          ? "fromPortId"
          : undefined;
  const value = field === undefined ? undefined : travel[field];
  return typeof value === "string" ? value : undefined;
}

/**
 * 3 → 4 (D61): the dock alongside is state (`deck.dock`) from the start of `docking` to the end
 * of `undocking`. A save in one of those stages at a port whose dock map is in the content it is
 * restored against gets it set, with the geometry revision bumped; restore's cache build then
 * grafts it. A docked save also has its ramps asked down (docked means ramps down, D59; saves
 * from before D59 had them close by themselves), and the door system lowers them. Anyone on the
 * old personnel-ramp transfer tile is still on ship floor. Freight waiting in the port store is
 * moved onto the dock by `stageLoadingFreightOnLoad` (D63), which runs next. A port with no dock
 * map, or a save already carrying a dock, is left alone.
 */
function attachDockOnLoad(raw: unknown, { content }: MigrationContext): unknown {
  if (!isRecord(raw) || !isRecord(raw.travel) || !isRecord(raw.deck)) return raw;
  if (raw.deck.dock !== undefined) return raw;
  const portId = portAlongside(raw.travel);
  if (portId === undefined) return raw;
  const dock = Object.values(content.docks ?? {}).find((d) => d.portId === portId);
  if (dock === undefined) return raw;
  const deckIds = isRecord(raw.deck.tiles) ? Object.keys(raw.deck.tiles) : [];
  const deckId = deckIds.find((id) => id in content.decks);
  if (deckId === undefined) return raw;
  raw.deck.dock = { dockId: dock.id, deckId };
  if (typeof raw.deck.geometryRevision === "number") raw.deck.geometryRevision += 1;
  if (raw.travel.stage === "docked" && isRecord(raw.doors)) {
    for (const door of Object.values(raw.doors)) {
      if (isRecord(door) && door.kind === "ramp" && door.deckId === deckId) {
        door.requestedState = "open";
      }
    }
  }
  return raw;
}

/**
 * 3 → 4, second half (D63): with the dock alongside, freight is physical on it. A save docked (or
 * preparing to depart) mid-loading at a port with a dock map has its accepted freight still in
 * that port's store, where schema 3 spawned it; it moves to the dock's staging area, one crate per
 * tile in order, and every actor who believed it in the store now believes it there. A save
 * mid-unloading has its open `cargoToUnload` problems at that port revised, so their tasks
 * re-derive towards the delivery bay. Runs after `attachDockOnLoad`, which set `deck.dock`.
 */
function stageLoadingFreightOnLoad(raw: unknown, { content }: MigrationContext): unknown {
  if (!isRecord(raw) || !isRecord(raw.travel) || !isRecord(raw.deck)) return raw;
  const stage = raw.travel.stage;
  if (stage !== "docked" && stage !== "preparingDeparture") return raw;
  const presence = raw.deck.dock;
  if (!isRecord(presence) || typeof presence.deckId !== "string") return raw;
  const dock =
    typeof presence.dockId === "string" ? content.docks?.[presence.dockId as DockDefId] : undefined;
  const deck = content.decks[presence.deckId as DeckDefId];
  if (dock === undefined || deck === undefined) return raw;
  const portId = dock.portId;
  const tiles = dockAreaTiles(berthDock(dock, deck), "freightStaging");
  if (tiles.length > 0 && isRecord(raw.jobs) && isRecord(raw.items)) {
    let next = 0;
    const moved = new Map<string, Record<string, unknown>>();
    for (const job of Object.values(raw.jobs)) {
      if (!isRecord(job) || job.status !== "accepted" || job.fromPortId !== portId) continue;
      if (!Array.isArray(job.cargoItemIds)) continue;
      for (const itemId of job.cargoItemIds) {
        const item = typeof itemId === "string" ? raw.items[itemId] : undefined;
        if (!isRecord(item) || !isRecord(item.location)) continue;
        if (item.location.kind !== "inExternalStore" || item.location.portId !== portId) continue;
        const tile = tiles[next % tiles.length] as TileCoord;
        next += 1;
        const location = {
          kind: "onDeck",
          deckId: presence.deckId,
          x: tile.x + 0.5,
          y: tile.y + 0.5,
        };
        item.location = location;
        moved.set(itemId as string, location);
      }
    }
    if (moved.size > 0 && isRecord(raw.actors)) {
      for (const actor of Object.values(raw.actors)) {
        if (!isRecord(actor) || !isRecord(actor.knowledge)) continue;
        for (const [itemId, location] of moved) {
          const fact = actor.knowledge[`${itemId}/itemLocation`];
          if (isRecord(fact)) fact.value = { location: { ...location } };
        }
      }
    }
  }
  if (isRecord(raw.work) && isRecord(raw.work.problems)) {
    for (const problem of Object.values(raw.work.problems)) {
      if (!isRecord(problem) || problem.kind !== "cargoToUnload" || problem.status !== "open")
        continue;
      if (!isRecord(problem.payload) || problem.payload.portId !== portId) continue;
      if (typeof problem.revision === "number") problem.revision += 1;
    }
  }
  return raw;
}

/**
 * 3 → 4, third part (D65): the ship carries a hand truck (the default scenario stows one in the
 * cargo stowage zone). A save from before has none, so one is set down on the zone's first tile:
 * the content's hand-truck item (a `handTruck` tool with a capacity), unless the save already
 * has one. Its id comes from the save's own item counter. Crew learn where it is by looking.
 */
function stowHandTruckOnLoad(raw: unknown, { content }: MigrationContext): unknown {
  if (!isRecord(raw) || !isRecord(raw.items) || !isRecord(raw.nextId) || !isRecord(raw.deck)) {
    return raw;
  }
  const truck = Object.values(content.items).find(
    (def) => def.toolKinds.includes("handTruck") && (def.capacityUnits ?? 0) >= 2,
  );
  if (truck === undefined) return raw;
  if (Object.values(raw.items).some((item) => isRecord(item) && item.defId === truck.id)) {
    return raw;
  }
  const deckIds = isRecord(raw.deck.tiles) ? Object.keys(raw.deck.tiles) : [];
  const deck = deckIds.map((id) => content.decks[id as DeckDefId]).find((d) => d !== undefined);
  const tile = deck?.zones.find((z) => z.tags.includes("cargoStowage"))?.tiles[0];
  const counter = raw.nextId.item;
  if (deck === undefined || tile === undefined) return raw;
  if (typeof counter !== "number" || !Number.isInteger(counter) || counter < 1) return raw;
  const id = `i${counter}`;
  raw.nextId.item = counter + 1;
  raw.items[id] = {
    id,
    defId: truck.id,
    stacking: "unique",
    condition: 1,
    location: { kind: "onDeck", deckId: deck.id, x: tile.x + 0.5, y: tile.y + 0.5 },
  };
  return raw;
}

/** 3 → 4 (D61, D63, D65): the dock alongside, then the freight on it, then the hand truck. */
function migrateToDockside(raw: unknown, context: MigrationContext): unknown {
  const docked = stageLoadingFreightOnLoad(attachDockOnLoad(raw, context), context);
  return stowHandTruckOnLoad(docked, context);
}

/**
 * 4 → 5 (D66): locals and the staging call.
 * - `dockside` is a new slice, empty; a save with a dock alongside has it dressed with the floor
 *   set on its first tick (`systems/travel/locals.ts`), so the migration places nobody.
 * - `nextId.local` starts at 1.
 * - `approachingPort` is retired. A save halted on one has it dropped as answered (its id joins
 *   `recentHookIds`), so the game runs on: a save past the transit lead point simply docks
 *   without staging, and one before it raises `stageDock` as usual.
 * - D69: a narrative event committed in the save's last tick has not been checked for a
 *   `notableEvent` yet; it becomes `narrator.pendingNotable` (travel checks its type against
 *   `hookOnEvents` when it raises the hook).
 */
function addDockside(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  if (!isRecord(raw.dockside)) raw.dockside = { locals: {}, props: [] };
  if (isRecord(raw.nextId) && typeof raw.nextId.local !== "number") raw.nextId.local = 1;
  const narrator = raw.narrator;
  const last = isRecord(narrator) ? narrator.lastNarrativeEvent : undefined;
  if (isRecord(narrator) && isRecord(last) && last.tick === raw.tick) {
    narrator.pendingNotable = { ...last };
  }
  if (isRecord(narrator) && isRecord(narrator.pendingHook)) {
    const hook = narrator.pendingHook;
    if (hook.kind === "approachingPort") {
      // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
      delete narrator.pendingHook;
      if (Array.isArray(narrator.recentHookIds) && typeof hook.id === "string") {
        narrator.recentHookIds.push(hook.id);
      }
    }
  }
  return raw;
}

/** The id of the save's `captain`-tagged actor (D8's captain), read from untrusted JSON. */
function captainIdOf(raw: Record<string, unknown>): string | undefined {
  if (!isRecord(raw.actors)) return undefined;
  for (const actor of Object.values(raw.actors)) {
    if (!isRecord(actor) || typeof actor.id !== "string" || !Array.isArray(actor.roleTags))
      continue;
    if (actor.roleTags.includes("captain")) return actor.id;
  }
  return undefined;
}

/**
 * 5 → 6 (D70): the captain goes ashore to look for work.
 * - `jobBoard` is now `captainAshore`, whose context also names who went ashore: a save halted
 *   on a `jobBoard` hook keeps it as a `captainAshore` hook from the captain (the narrator answers
 *   it the same way), and `jobBoardLastAsk` becomes `captainAshoreLastAsk` with the captain as the
 *   one who asked.
 * - `decisions.held` is new and empty: nothing was held before.
 * - D42's `surfaceWhenDocked` is retired: an offer surfaced in flight whose card was waiting for
 *   the dock never had a decision record, and offers are now only made at the dock, so it is
 *   withdrawn as expired at the save's tick (the narrator is asked again when the captain goes
 *   ashore). An offer no longer open just loses the flag.
 */
export function captainAshore(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const captainId = captainIdOf(raw);
  const narrator = raw.narrator;
  if (isRecord(narrator)) {
    const hook = narrator.pendingHook;
    if (isRecord(hook) && hook.kind === "jobBoard" && isRecord(hook.context)) {
      hook.kind = "captainAshore";
      if (captainId !== undefined) hook.context.actorId = captainId;
    }
    const ask = narrator.jobBoardLastAsk;
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete narrator.jobBoardLastAsk;
    if (isRecord(ask) && captainId !== undefined) {
      narrator.captainAshoreLastAsk = { ...ask, actorId: captainId };
    }
  }
  if (isRecord(raw.decisions) && !Array.isArray(raw.decisions.held)) raw.decisions.held = [];
  if (isRecord(raw.jobs)) {
    for (const job of Object.values(raw.jobs)) {
      if (!isRecord(job) || job.surfaceWhenDocked === undefined) continue;
      // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
      delete job.surfaceWhenDocked;
      if (job.status !== "offered") continue;
      job.status = "expired";
      if (typeof raw.tick === "number") job.closedTick = raw.tick;
    }
  }
  return raw;
}

/**
 * 6 → 7 (D72, D74): refused. Freighter Mk1 was mirrored bow-east and every dock map changed
 * shape, so every tile-bearing field of an older save (locations, paths, plan steps, facts,
 * claims) is in a frame that no longer exists; migrating them all is the change the compiler
 * cannot check (D59). Saves predate players (PLAN §3); the host starts a new game.
 */
function refuseBeforeShipLife(): never {
  throw new SaveCompatibilityError("save predates ship life (schema 6); start a new game");
}

/**
 * 7 → 8 (D77-D79): watches replace shifts; thoughts, hazards and the hazard budget.
 * - `schedule.shiftKey` becomes `{ section }`: the actor's crew def's section in the watch bill
 *   of the save's scenario in the content restored against, its index the section's place in the
 *   bill. A scenario without a bill, or a def in no section (a narrator-spawned hand, a passenger),
 *   is a dayworker (`{}`). The bill is read inline rather than through `core/watch-bill.ts`, so
 *   this migration stays as shipped whatever that file becomes.
 * - `thoughts: []` on every actor; `watch` with the bell already rung for the save's watch (no
 *   bell on the first tick after load); `hazards: []`, `nextId.hazard` 1.
 * - The narrator budget gains `hazardsRemaining` at the config's `hazardBudget`, and the refill
 *   clock starts at the save's tick.
 * - Every `stationToStaff` problem is the watch's (`owner: "watch"`, `post: "watch"`), and its
 *   task keeps its identity under the new derivation key (`staff:watch`), so a pilot at the helm
 *   in the save stays there.
 */
function watchesAndThoughts(raw: unknown, { content, config }: MigrationContext): unknown {
  if (!isRecord(raw)) return raw;
  const tick =
    typeof raw.tick === "number" && Number.isInteger(raw.tick) && raw.tick >= 0 ? raw.tick : 0;
  const scenario =
    typeof raw.scenarioId === "string"
      ? Object.values(content.scenarios).find((s) => s.id === raw.scenarioId)
      : undefined;
  const sectionOf = new Map<string, { key: string; index: number }>();
  scenario?.watchBill?.sections.forEach((section, index) => {
    for (const member of section.members) sectionOf.set(member, { key: section.key, index });
  });
  if (isRecord(raw.actors)) {
    for (const actor of Object.values(raw.actors)) {
      if (!isRecord(actor)) continue;
      const section = typeof actor.defId === "string" ? sectionOf.get(actor.defId) : undefined;
      actor.schedule = section === undefined ? {} : { section: { ...section } };
      if (!Array.isArray(actor.thoughts)) actor.thoughts = [];
    }
  }
  if (!isRecord(raw.watch)) raw.watch = { lastBellWatch: watchIndexAt(config, tick), helm: {} };
  if (!Array.isArray(raw.hazards)) raw.hazards = [];
  if (isRecord(raw.nextId) && typeof raw.nextId.hazard !== "number") raw.nextId.hazard = 1;
  const narrator = raw.narrator;
  if (isRecord(narrator)) {
    if (isRecord(narrator.budget) && typeof narrator.budget.hazardsRemaining !== "number") {
      narrator.budget.hazardsRemaining = config.narrator.hazardBudget;
    }
    if (typeof narrator.budgetRefilledTick !== "number") narrator.budgetRefilledTick = tick;
  }
  const staffing = new Set<string>();
  if (isRecord(raw.work) && isRecord(raw.work.problems)) {
    for (const [id, problem] of Object.entries(raw.work.problems)) {
      if (!isRecord(problem) || problem.kind !== "stationToStaff") continue;
      problem.owner = "watch";
      if (isRecord(problem.payload)) problem.payload.post = "watch";
      staffing.add(id);
    }
  }
  if (isRecord(raw.work) && isRecord(raw.work.tasks)) {
    for (const task of Object.values(raw.work.tasks)) {
      if (!isRecord(task) || typeof task.problemId !== "string") continue;
      if (staffing.has(task.problemId) && task.derivationKey === "staff") {
        task.derivationKey = "staff:watch";
      }
    }
  }
  return raw;
}

/**
 * 8 → 9 (D81-D83): the galley and dirt.
 * - `dirt`: a zeroed cell row for each deck in `deck.tiles` the content knows, no tiers, no dust
 *   this visit; `boots: 0` on every actor; `galley.lastMealWatch` the save's watch, so the first
 *   meal raised after load is the coming watch's.
 * - A schema-8 save has no provisions and no mop. The scenario's `startingItems` lines for a
 *   `provisions`-tagged item and for a `mop` tool are spawned into their zones as fresh items
 *   (ids from `nextId.item`, chunks of `maxStack`, zone tiles round-robin, exactly as
 *   `scenarioSetupCommands` does), unless the save already holds one of that def; the owner is
 *   told through `warn`. Crew learn where they are by looking.
 */
function galleyAndDirt(raw: unknown, { content, config, warn }: MigrationContext): unknown {
  if (!isRecord(raw)) return raw;
  const tick =
    typeof raw.tick === "number" && Number.isInteger(raw.tick) && raw.tick >= 0 ? raw.tick : 0;
  const deckIds = isRecord(raw.deck) && isRecord(raw.deck.tiles) ? Object.keys(raw.deck.tiles) : [];
  if (!isRecord(raw.dirt)) {
    const cells: Record<string, number[]> = {};
    for (const id of deckIds) {
      const deck = content.decks[id as DeckDefId];
      if (deck !== undefined) cells[id] = emptyCells(deck);
    }
    raw.dirt = { cells, tiers: {}, dustThisVisit: 0 };
  }
  if (isRecord(raw.actors)) {
    for (const actor of Object.values(raw.actors)) {
      if (isRecord(actor) && typeof actor.boots !== "number") actor.boots = 0;
    }
  }
  if (!isRecord(raw.galley)) raw.galley = { lastMealWatch: watchIndexAt(config, tick) };
  spawnGalleyStoresOnLoad(raw, content, deckIds, warn);
  return raw;
}

/** The 8 → 9 spawn of the scenario's provisions and mop (see `galleyAndDirt`). */
function spawnGalleyStoresOnLoad(
  raw: Record<string, unknown>,
  content: MigrationContext["content"],
  deckIds: readonly string[],
  warn: MigrationContext["warn"],
): void {
  const spawned = spawnScenarioStores(
    raw,
    content,
    deckIds,
    (def) => def.tags.includes("provisions") || def.toolKinds.includes("mop"),
  );
  if (spawned.length > 0) {
    warn?.(`Save predates the galley (schema 8); stowed the scenario's ${spawned.join(" and ")}`);
  }
}

/**
 * The scenario's `startingItems` lines whose def passes `wanted`, spawned into their zones as
 * fresh items (ids from `nextId.item`, chunks of `maxStack`, zone tiles round-robin, exactly as
 * `scenarioSetupCommands` does) unless the save already holds one of that def. Returns what was
 * stowed ("3× provisions in pantry"), for the owner's warning. Shared by 8 → 9 and 9 → 10.
 */
function spawnScenarioStores(
  raw: Record<string, unknown>,
  content: MigrationContext["content"],
  deckIds: readonly string[],
  wanted: (def: ItemDef) => boolean,
): string[] {
  if (!isRecord(raw.items) || !isRecord(raw.nextId)) return [];
  const scenario =
    typeof raw.scenarioId === "string"
      ? content.scenarios[raw.scenarioId as ScenarioDefId]
      : undefined;
  const deck = deckIds.map((id) => content.decks[id as DeckDefId]).find((d) => d !== undefined);
  if (scenario === undefined || deck === undefined || deck.id !== scenario.deckId) return [];
  const items = raw.items;
  // Held before this migration, so a def stocked in several zones (slice 5's patch kits, one line
  // per locker) is spawned on every line, not only the first.
  const held = new Set(
    Object.values(items).flatMap((item) =>
      isRecord(item) && typeof item.defId === "string" ? [item.defId] : [],
    ),
  );
  const spawned: string[] = [];
  for (const line of scenario.startingItems) {
    const def = content.items[line.itemDefId];
    if (def === undefined || !wanted(def)) continue;
    if (held.has(def.id)) continue;
    const zone = deck.zones.find((z) => z.key === line.zoneKey);
    if (zone === undefined || zone.tiles.length === 0) continue;
    const chunk = def.stacking === "unique" ? 1 : def.maxStack;
    let placed = 0;
    for (let left = line.count, index = 0; left > 0; left -= chunk, index++) {
      const counter: unknown = raw.nextId.item;
      if (typeof counter !== "number" || !Number.isInteger(counter) || counter < 1) return spawned;
      const tile = zone.tiles[index % zone.tiles.length] as TileCoord;
      const location = { kind: "onDeck", deckId: deck.id, x: tile.x + 0.5, y: tile.y + 0.5 };
      const id = `i${counter}`;
      raw.nextId.item = counter + 1;
      items[id] =
        def.stacking === "unique"
          ? { id, defId: def.id, stacking: "unique", condition: 1, location }
          : {
              id,
              defId: def.id,
              stacking: "stack",
              count: Math.min(chunk, left),
              reserved: 0,
              location,
            };
      placed += 1;
    }
    if (placed > 0)
      spawned.push(`${line.count}× ${def.name.toLowerCase()} in ${zone.name.toLowerCase()}`);
  }
  return spawned;
}

/**
 * 9 → 10 (slice 4): off watch.
 * - `needs.recreation: 0.3` for everyone; `interests` and `values` from the actor's crew def
 *   (content, else the save's generated defs), else `interestsFromSeed(actorId)` (a keyed hash, no
 *   rng);
 * - `social`: the empty slice (no relationships, rivalries or sessions, no captain's table yet);
 *   `nextId.session: 1`;
 * - a sleep hold's `disturbedTicks` absent means 0, so held steps need nothing;
 * - the scenario's `book`-tagged `startingItems` (the shelf) spawned as 8 → 9 spawns provisions,
 *   unless the save holds one; the owner is told through `warn`. The harmonica already lies in
 *   Bettina's locker (D74).
 */
function offWatch(raw: unknown, { content, warn }: MigrationContext): unknown {
  if (!isRecord(raw)) return raw;
  const dynamicCrew =
    isRecord(raw.defs) && isRecord(raw.defs.dynamic) && isRecord(raw.defs.dynamic.crew)
      ? raw.defs.dynamic.crew
      : {};
  if (isRecord(raw.actors)) {
    for (const [id, actor] of Object.entries(raw.actors)) {
      if (!isRecord(actor)) continue;
      if (isRecord(actor.needs) && typeof actor.needs.recreation !== "number") {
        actor.needs.recreation = 0.3;
      }
      if (isRecord(actor.interests) && isRecord(actor.values)) continue;
      const defId = typeof actor.defId === "string" ? actor.defId : "";
      const def = content.crew[defId as CrewDefId] ?? dynamicCrew[defId];
      const seeded = interestsFromSeed(id as ActorId);
      const authored = isRecord(def) ? def : {};
      if (!isRecord(actor.interests)) {
        actor.interests = structuredJson(authored.interests ?? seeded.interests);
      }
      if (!isRecord(actor.values)) actor.values = structuredJson(authored.values ?? seeded.values);
    }
  }
  if (!isRecord(raw.social)) {
    raw.social = { relationships: {}, rivalries: {}, sessions: {}, captainsTableDay: -1 };
  }
  if (isRecord(raw.nextId) && typeof raw.nextId.session !== "number") raw.nextId.session = 1;
  const deckIds = isRecord(raw.deck) && isRecord(raw.deck.tiles) ? Object.keys(raw.deck.tiles) : [];
  const spawned = spawnScenarioStores(raw, content, deckIds, (def) => def.tags.includes("book"));
  if (spawned.length > 0) {
    warn?.(`Save predates off watch (schema 9); shelved the scenario's ${spawned.join(" and ")}`);
  }
  return raw;
}

/**
 * 10 → 11 (D88): affinity from memories. Every relationship entry loses its `affinity` and gains
 * an empty `memories`; `lastChatTick` is kept. Nobody remembers anything yet, so everyone stands
 * at their compatibility: a running total from before cannot be split into memories.
 */
function affinityFromMemories(raw: unknown): unknown {
  if (!isRecord(raw) || !isRecord(raw.social) || !isRecord(raw.social.relationships)) return raw;
  for (const row of Object.values(raw.social.relationships)) {
    if (!isRecord(row)) continue;
    for (const [to, entry] of Object.entries(row)) {
      const lastChatTick = isRecord(entry) ? entry.lastChatTick : undefined;
      row[to] =
        typeof lastChatTick === "number" ? { memories: [], lastChatTick } : { memories: [] };
    }
  }
  return raw;
}

/**
 * 11 → 12 (slice 5, D92-D95): the asteroid field.
 * - `hull`: whole, at the save's deck's `hull.max` (`HullDef.max`); no scars;
 * - no `field` and no `alert` (nothing was scheduled before the lever existed);
 *   `nextId.field` and `nextId.scar` start at 1;
 * - a waiting hazard of the retired kind `asteroidBelt` becomes a `debrisField` at the same
 *   difficulty, so the narrator's spent budget still buys a check (call 28);
 * - the scenario's `patchKit`-tagged `startingItems` (two per locker) spawned as 9 → 10 shelved
 *   the books, unless the save holds a kit; the owner is told through `warn`.
 */
function asteroidField(raw: unknown, { content, warn }: MigrationContext): unknown {
  if (!isRecord(raw)) return raw;
  const deckIds = isRecord(raw.deck) && isRecord(raw.deck.tiles) ? Object.keys(raw.deck.tiles) : [];
  if (!isRecord(raw.hull)) {
    const deck = deckIds.map((id) => content.decks[id as DeckDefId]).find((d) => d !== undefined);
    if (deck === undefined) {
      throw new SaveCompatibilityError(
        `Save's deck (${deckIds.join(", ") || "none"}) is not in this content; cannot size its hull`,
      );
    }
    raw.hull = { integrity: deck.hull.max, max: deck.hull.max, scars: [] };
  }
  if (isRecord(raw.nextId)) {
    if (typeof raw.nextId.field !== "number") raw.nextId.field = 1;
    if (typeof raw.nextId.scar !== "number") raw.nextId.scar = 1;
  }
  if (Array.isArray(raw.hazards)) {
    for (const hazard of raw.hazards) {
      if (isRecord(hazard) && hazard.kind === "asteroidBelt") hazard.kind = "debrisField";
    }
  }
  const spawned = spawnScenarioStores(raw, content, deckIds, (def) =>
    def.tags.includes("patchKit"),
  );
  if (spawned.length > 0) {
    warn?.(
      `Save predates the asteroid field (schema 11); stowed the scenario's patch kits in ${spawned.length} lockers`,
    );
  }
  return raw;
}

/** A detached plain-JSON copy, so a migrated actor never aliases content. */
function structuredJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

export const migrations: MigrationRegistry = {
  1: migrateJobsToPeople,
  2: addMarkets,
  3: migrateToDockside,
  4: addDockside,
  5: captainAshore,
  6: refuseBeforeShipLife,
  7: watchesAndThoughts,
  8: galleyAndDirt,
  9: offWatch,
  10: affinityFromMemories,
  11: asteroidField,
};
