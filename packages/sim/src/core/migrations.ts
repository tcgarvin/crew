/**
 * Save migrations, keyed by the schema version they upgrade *from* (see `save.ts`). Each takes
 * untrusted JSON and must tolerate missing or odd fields: anything it does not recognise is left
 * for the invariants to judge.
 */
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
 * from before D59 had them close by themselves), and the door system lowers them. Nothing else
 * moves: freight in a port store stays there (loading still runs through the transfer tiles), and
 * anyone on the old personnel-ramp transfer tile is still on ship floor. A port with no dock map,
 * or a save already carrying a dock, is left alone.
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

export const migrations: MigrationRegistry = {
  1: migrateJobsToPeople,
  2: addMarkets,
  3: attachDockOnLoad,
};
