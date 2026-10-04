/**
 * Save migrations, keyed by the schema version they upgrade *from* (see `save.ts`). Each takes
 * untrusted JSON and must tolerate missing or odd fields: anything it does not recognise is left
 * for the invariants to judge.
 */
import { dockAreaTiles } from "./docks";
import type { TileCoord } from "./types/common";
import type { DeckDefId, DockDefId } from "./types/ids";
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
export function addMarkets(raw: unknown): unknown {
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
export function attachDockOnLoad(raw: unknown, { content }: MigrationContext): unknown {
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
export function stageLoadingFreightOnLoad(raw: unknown, { content }: MigrationContext): unknown {
  if (!isRecord(raw) || !isRecord(raw.travel) || !isRecord(raw.deck)) return raw;
  const stage = raw.travel.stage;
  if (stage !== "docked" && stage !== "preparingDeparture") return raw;
  const presence = raw.deck.dock;
  if (!isRecord(presence) || typeof presence.deckId !== "string") return raw;
  const dock =
    typeof presence.dockId === "string" ? content.docks?.[presence.dockId as DockDefId] : undefined;
  if (dock === undefined) return raw;
  const portId = dock.portId;
  const tiles = dockAreaTiles(dock, "freightStaging");
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
export function stowHandTruckOnLoad(raw: unknown, { content }: MigrationContext): unknown {
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
export function addDockside(raw: unknown): unknown {
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

export const migrations: MigrationRegistry = {
  1: migrateJobsToPeople,
  2: addMarkets,
  3: migrateToDockside,
  4: addDockside,
  5: captainAshore,
};
