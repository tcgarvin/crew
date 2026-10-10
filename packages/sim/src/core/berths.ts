/**
 * Berths (§berth-assignment; ship-life §7). Every crew member and passenger aboard has a bed of
 * their own when the ship has one free, recorded in `WorldState.berths` as the bed's placement key.
 *
 * `assignBerths` is a standing rule, not a one-off: run at world creation and by the needs stage
 * every tick, it first releases the berth of anyone dead, gone from `actors` (a passenger who
 * walked off the ship is deleted) or left behind ashore (a passage ended `leftBehind`), then
 * gives each crew member without a berth the first free bed for their rank, captain first, then
 * the first officer, the rest of the crew, passengers last, each in actor-id order:
 *
 * - passenger → a bed in a `passengerCabin` compartment (whatever their role tags);
 * - captain → `captainsCabin`;
 * - first officer → `officersCabin`;
 * - anyone else → `quarters` (the bunkroom);
 * - failing that, any free bed not in a `passengerCabin`; failing that, none (unberthed).
 *
 * A bed is a placement whose machine carries `bed` and not `medBed` (the infirmary bed is not a
 * berth); beds are tried in deck placement order. Someone ashore for a while (`offShip`: an
 * errand through the gate, a round-trip passenger's stay) keeps their berth.
 *
 * `stowPersonalItems` runs once at world creation: each crew member's `personal` starting items
 * leave their hands for the first tile of their berth's `locker` zone (the zone whose
 * `machineKey` is the bed), with `ownerId` set. No locker, or no berth: they keep them.
 */
import { byId } from "./ids";
import type { Actor } from "./types/actor";
import type { TileCoord } from "./types/common";
import type { ContentBundle, DeckDef, MachinePlacementDef } from "./types/content";
import type { ActorId, LocalKey } from "./types/ids";
import type { WorldState } from "./types/state";

type BerthContent = Pick<ContentBundle, "machines">;

/** The compartment tag that ranks a bed for someone. */
type RankTag = "captainsCabin" | "officersCabin" | "passengerCabin" | "quarters";

/** Zone tag of the locker a bed's owner keeps their belongings in. */
const LOCKER_ZONE_TAG = "locker";

interface Bed {
  readonly key: LocalKey;
  /** Tags of the compartment the bed stands in (its placement origin's tile). */
  readonly compartmentTags: readonly string[];
}

/** A passenger is ranked as one whatever their role tags (they are not serving aboard). */
function rankTag(actor: Pick<Actor, "roleTags" | "passenger">): RankTag {
  if (actor.passenger === true) return "passengerCabin";
  if (actor.roleTags.includes("captain")) return "captainsCabin";
  if (actor.roleTags.includes("firstOfficer")) return "officersCabin";
  return "quarters";
}

/** Is this placement a berth: a `bed` machine that is not a `medBed`? Throws on an unknown def. */
export function isBerthPlacement(content: BerthContent, placement: MachinePlacementDef): boolean {
  const def = content.machines[placement.machineDefId];
  if (def === undefined) throw new Error(`Placement "${placement.key}" has unknown machine def`);
  return def.tags.includes("bed") && !def.tags.includes("medBed");
}

/** The compartment tags at a deck tile ([] for void or an unknown symbol). */
function compartmentTagsAt(deck: DeckDef, x: number, y: number): readonly string[] {
  const symbol = deck.tiles[y]?.[x];
  return deck.compartments.find((c) => c.symbol === symbol)?.tags ?? [];
}

/** The deck's berths in placement order, each with its compartment's tags. */
function bedsOf(deck: DeckDef, content: BerthContent): Bed[] {
  return deck.machines
    .filter((placement) => isBerthPlacement(content, placement))
    .map((placement) => ({
      key: placement.key,
      compartmentTags: compartmentTagsAt(deck, placement.origin.x, placement.origin.y),
    }));
}

const RANK_ORDER: Readonly<Record<RankTag, number>> = {
  captainsCabin: 0,
  officersCabin: 1,
  quarters: 2,
  passengerCabin: 3,
};

/**
 * Passengers left behind ashore (`leftBehind`): they stay in `actors`, off ship, but they have
 * left it for good. Empty unless a passage ended that way, which is rare.
 */
function leftBehind(state: WorldState): ReadonlySet<ActorId> {
  const out = new Set<ActorId>();
  for (const job of Object.values(state.jobs)) {
    if (job.passage?.endReason === "leftBehind") out.add(job.passage.actorId);
  }
  return out;
}

/** Should this actor hold a berth: crew (passengers included), alive, not left behind? */
const belongsAboard = (actor: Actor | undefined, gone: ReadonlySet<ActorId>): actor is Actor =>
  actor?.crew === true && actor.availability !== "dead" && !gone.has(actor.id);

function releaseGone(state: WorldState, gone: ReadonlySet<ActorId>): void {
  const kept = Object.entries(state.berths).filter(([id]) =>
    belongsAboard(state.actors[id as ActorId], gone),
  );
  if (kept.length === Object.keys(state.berths).length) return;
  state.berths = Object.fromEntries(kept) as WorldState["berths"];
}

/** Crew without a berth who should have one, in rank then actor-id order. */
function unberthed(state: WorldState, gone: ReadonlySet<ActorId>): Actor[] {
  return Object.values(state.actors)
    .filter((a) => belongsAboard(a, gone) && state.berths[a.id] === undefined)
    .sort((a, b) => RANK_ORDER[rankTag(a)] - RANK_ORDER[rankTag(b)] || byId(a, b));
}

/** Apply the standing berth rule (module doc). Idempotent; cheap when everyone is berthed. */
export function assignBerths(state: WorldState, deck: DeckDef, content: BerthContent): void {
  const gone = leftBehind(state);
  releaseGone(state, gone);
  const waiting = unberthed(state, gone);
  if (waiting.length === 0) return;
  const taken = new Set<LocalKey>(Object.values(state.berths));
  const beds = bedsOf(deck, content);
  const firstFree = (fits: (bed: Bed) => boolean) =>
    beds.find((bed) => !taken.has(bed.key) && fits(bed));
  for (const actor of waiting) {
    const tag = rankTag(actor);
    const bed =
      firstFree((b) => b.compartmentTags.includes(tag)) ??
      firstFree((b) => !b.compartmentTags.includes("passengerCabin"));
    if (bed === undefined) continue;
    state.berths[actor.id] = bed.key;
    taken.add(bed.key);
  }
}

/**
 * The tile of the locker serving the bed `bedKey` (the first tile of the `locker` zone whose
 * `machineKey` names it); undefined for a bed without one. Slice 4: where an owned item is put
 * back after use.
 */
export function lockerTileOf(
  deck: Pick<DeckDef, "zones">,
  bedKey: LocalKey,
): TileCoord | undefined {
  const locker = deck.zones.find(
    (z) => z.machineKey === bedKey && z.tags.includes(LOCKER_ZONE_TAG),
  );
  return locker?.tiles[0];
}

/** Move each crew member's `personal` carried items into their berth's locker (module doc). */
export function stowPersonalItems(
  state: WorldState,
  deck: DeckDef,
  content: BerthContent & Pick<ContentBundle, "items">,
): void {
  for (const [actorId, bedKey] of Object.entries(state.berths) as [ActorId, LocalKey][]) {
    const tile = lockerTileOf(deck, bedKey);
    if (tile === undefined) continue;
    for (const item of Object.values(state.items)) {
      const location = item.location;
      if (location.kind !== "carriedBy" || location.actorId !== actorId) continue;
      const def = content.items[item.defId];
      if (def === undefined) throw new Error(`Item ${item.id} has unknown def "${item.defId}"`);
      if (!def.tags.includes("personal")) continue;
      if (item.stacking !== "unique") {
        throw new Error(`Personal item "${item.defId}" must be unique to have an owner`);
      }
      item.location = { kind: "onDeck", deckId: deck.id, x: tile.x + 0.5, y: tile.y + 0.5 };
      item.ownerId = actorId;
    }
  }
}
