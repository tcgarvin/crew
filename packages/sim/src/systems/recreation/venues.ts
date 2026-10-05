/**
 * Venues (slice 4, call 12): where an activity happens on this deck, from content tags at plan
 * time, against the reservation cache. `ActivityDef.venue` is an ordered list; the first
 * alternative with a free spot on the deck wins (a games table with every seat taken falls to the
 * lounge floor). A machine venue stands at a `use` position not reserved and not spoken for by
 * someone else's plan; a zone venue at a zone tile free of actors; a compartment venue at a free
 * floor tile chosen by `loungeTile`'s rule (computed over state); `own` restricts a machine to
 * the actor's berth compartment. With `session`, the session's venue is fixed and a free spot of
 * it is taken.
 *
 * "Spoken for" is slice 3's mess-seat rule (`systems/galley/eat.ts` `seatsSpokenFor`): a
 * reservation is only taken when a walk starts, so a plan that fetches a book first, or four
 * players planning in one tick, would otherwise pick the same seat. A spot named by a `moveTo`
 * still ahead in anyone else's plan is not free.
 *
 * Owner: W1 of ship life slice 4.
 */
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly, TileCoord } from "../../core/types/common";
import type { ActivityDef, VenueDef } from "../../core/types/content";
import type { CompartmentId, DeckDefId, LocalKey, MachineId } from "../../core/types/ids";
import type { NavInteractionPosition } from "../../core/types/nav";
import type { StepCtx } from "../../core/types/pipeline";
import type { GroupSession, SessionVenue } from "../../core/types/state";
import type { StepTarget } from "../../core/types/work";
import { compartmentAt } from "../spatial/geometry";
import { reservationHolders, tileCapacity } from "../spatial/reservations";
import { standingTile } from "./common";

/** A venue and the spot in it this actor takes. */
export interface ResolvedVenue {
  readonly venue: SessionVenue;
  readonly target: StepTarget;
}

type VenueCtx = Pick<StepCtx, "state" | "content" | "caches">;

const tileKey = (tile: TileCoord): string => `${tile.x},${tile.y}`;
const manhattan = (a: TileCoord, b: TileCoord): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** Spots someone else's plan still has a walk to: `machineId:positionKey` and `x,y` keys. */
function spokenFor(ctx: VenueCtx, actor: Actor): Set<string> {
  const out = new Set<string>();
  for (const other of Object.values(ctx.state.actors)) {
    const activity = other.activity;
    if (other.id === actor.id || activity.kind === "idle" || activity.plan === undefined) continue;
    for (const step of activity.plan.steps.slice(activity.plan.stepIndex)) {
      if (step.kind !== "moveTo") continue;
      const target = step.target;
      out.add(
        "machineId" in target ? `${target.machineId}:${target.positionKey}` : tileKey(target),
      );
    }
  }
  return out;
}

/** Tiles other actors on `deckId` stand on. */
function standingElsewhere(ctx: VenueCtx, actor: Actor, deckId: DeckDefId): Set<string> {
  const out = new Set<string>();
  for (const other of Object.values(ctx.state.actors)) {
    if (other.id === actor.id || other.location.kind !== "onDeck") continue;
    if (other.location.deckId !== deckId) continue;
    const tile = standingTile(other);
    if (tile !== undefined) out.add(tileKey(tile));
  }
  return out;
}

/** The compartment a machine stands in (its placement origin's). */
export function machineCompartment(ctx: VenueCtx, machineId: MachineId): CompartmentId | undefined {
  const machine = ctx.state.machines[machineId];
  const geometry = machine === undefined ? undefined : ctx.caches.nav.decks[machine.deckId];
  if (machine === undefined || geometry === undefined) return undefined;
  const placement = ctx.content.decks[machine.deckId]?.machines.find(
    (p) => p.key === machine.placementKey,
  );
  if (placement === undefined) return undefined;
  return compartmentAt(geometry, placement.origin.x, placement.origin.y);
}

/** The compartment of the actor's own bed (`state.berths`), if they have one. */
function berthCompartment(ctx: VenueCtx, actor: Actor): CompartmentId | undefined {
  const bedKey = ctx.state.berths[actor.id];
  if (bedKey === undefined || actor.location.kind !== "onDeck") return undefined;
  const deckId = actor.location.deckId;
  const bed = Object.values(ctx.state.machines).find(
    (m) => m.deckId === deckId && m.placementKey === bedKey,
  );
  return bed === undefined ? undefined : machineCompartment(ctx, bed.id);
}

/** Machines on the deck carrying `alt.machineTag` (in the actor's berth compartment for `own`). */
function venueMachines(ctx: VenueCtx, actor: Actor, alt: DeepReadonly<VenueDef>): MachineId[] {
  if (alt.machineTag === undefined || actor.location.kind !== "onDeck") return [];
  const deckId = actor.location.deckId;
  const tag = alt.machineTag;
  const own = alt.own === true ? berthCompartment(ctx, actor) : undefined;
  if (alt.own === true && own === undefined) return [];
  return Object.values(ctx.state.machines)
    .filter((m) => m.deckId === deckId && ctx.content.machines[m.defId]?.tags.includes(tag))
    .filter((m) => own === undefined || machineCompartment(ctx, m.id) === own)
    .map((m) => m.id)
    .sort();
}

/** A free `use` position of one of `machineIds`: one the actor holds first, else the nearest. */
function freePosition(
  ctx: VenueCtx,
  actor: Actor,
  machineIds: readonly MachineId[],
): NavInteractionPosition | undefined {
  if (actor.location.kind !== "onDeck") return undefined;
  const deckId = actor.location.deckId;
  const geometry = ctx.caches.nav.decks[deckId];
  const here = standingTile(actor);
  if (geometry === undefined || here === undefined) return undefined;
  const spoken = spokenFor(ctx, actor);
  let best: { position: NavInteractionPosition; d: number } | undefined;
  for (const position of geometry.interactionPositions) {
    if (!machineIds.includes(position.machineId) || !position.purposes.includes("use")) continue;
    const holders = reservationHolders(ctx.caches, deckId, position.tile);
    const mine = holders.includes(actor.id);
    if (!mine && holders.length >= tileCapacity(geometry, position.tile)) continue;
    if (!mine && spoken.has(`${position.machineId}:${position.key}`)) continue;
    const d = mine ? -1 : manhattan(position.tile, here);
    if (best === undefined || d < best.d) best = { position, d };
  }
  return best?.position;
}

/** Zones on the actor's deck carrying `tag`. */
function zonesTagged(ctx: VenueCtx, actor: Actor, tag: string) {
  if (actor.location.kind !== "onDeck") return [];
  return ctx.content.decks[actor.location.deckId]?.zones.filter((z) => z.tags.includes(tag)) ?? [];
}

/** A free tile of `tiles`: where the actor stands first, else the nearest nobody stands on. */
function freeTile(
  ctx: VenueCtx,
  actor: Actor,
  tiles: readonly TileCoord[],
  order: "nearest" | "hashed",
): TileCoord | undefined {
  if (actor.location.kind !== "onDeck") return undefined;
  const here = standingTile(actor);
  if (here === undefined) return undefined;
  if (tiles.some((t) => t.x === here.x && t.y === here.y)) return { ...here };
  const taken = standingElsewhere(ctx, actor, actor.location.deckId);
  for (const key of spokenFor(ctx, actor)) taken.add(key);
  const free = tiles.filter((t) => !taken.has(tileKey(t)));
  if (free.length === 0) return undefined;
  if (order === "hashed") {
    // `loungeTile`'s rule: a deterministic per-actor spot, so idlers spread out.
    let hash = 0;
    for (const ch of actor.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const pick = free[hash % free.length];
    return pick === undefined ? undefined : { ...pick };
  }
  const sorted = [...free].sort((a, b) => manhattan(a, here) - manhattan(b, here));
  const pick = sorted[0];
  return pick === undefined ? undefined : { ...pick };
}

/** The ids and floor tiles (clear of machine positions) of the deck's compartments by key. */
function compartmentFloor(
  ctx: VenueCtx,
  deckId: DeckDefId,
  compartmentId: CompartmentId,
): TileCoord[] {
  const geometry = ctx.caches.nav.decks[deckId];
  const key = ctx.state.compartments[compartmentId]?.key;
  const deck = ctx.content.decks[deckId];
  const def = deck?.compartments.find((c) => c.key === key);
  if (geometry === undefined || deck === undefined || def === undefined) return [];
  const positions = new Set(geometry.interactionPositions.map((p) => tileKey(p.tile)));
  const footprints = new Set<string>();
  for (const placement of deck.machines) {
    const mdef = ctx.content.machines[placement.machineDefId];
    for (const f of mdef?.footprint ?? []) {
      footprints.add(tileKey({ x: placement.origin.x + f.x, y: placement.origin.y + f.y }));
    }
  }
  const out: TileCoord[] = [];
  deck.tiles.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== def.symbol) continue;
      const k = tileKey({ x, y });
      if (positions.has(k) || footprints.has(k)) continue;
      out.push({ x, y });
    }
  });
  return out;
}

/** Compartment ids on the deck carrying `tag`, in authored order. */
function compartmentsTagged(ctx: VenueCtx, deckId: DeckDefId, tag: string): CompartmentId[] {
  const deck = ctx.content.decks[deckId];
  if (deck === undefined) return [];
  const keys = deck.compartments.filter((c) => c.tags.includes(tag)).map((c) => c.key);
  return keys.flatMap((key) => {
    const found = Object.values(ctx.state.compartments).find(
      (c) => c.deckId === deckId && c.key === key,
    );
    return found === undefined ? [] : [found.id];
  });
}

function zoneCompartment(
  ctx: VenueCtx,
  deckId: DeckDefId,
  tiles: readonly TileCoord[],
): CompartmentId | undefined {
  const geometry = ctx.caches.nav.decks[deckId];
  const first = tiles[0];
  return geometry === undefined || first === undefined
    ? undefined
    : compartmentAt(geometry, first.x, first.y);
}

/**
 * Is this machine or zone the venue of a session of another activity? One game to a table: a
 * board game does not set up beside a hand of cards. A room holds any number.
 */
function heldByAnother(
  ctx: VenueCtx,
  def: DeepReadonly<ActivityDef>,
  where: MachineId | LocalKey,
): boolean {
  return Object.values(ctx.state.social.sessions).some((s) => {
    if (s.activityId === def.id) return false;
    const venue = s.venue;
    return (
      ("machineId" in venue && venue.machineId === where) ||
      ("zoneKey" in venue && venue.zoneKey === where)
    );
  });
}

/** A spot at one venue alternative, if it has a free one. */
function atAlternative(
  ctx: VenueCtx,
  actor: Actor,
  def: DeepReadonly<ActivityDef>,
  alt: DeepReadonly<VenueDef>,
): ResolvedVenue | undefined {
  if (actor.location.kind !== "onDeck") return undefined;
  const deckId = actor.location.deckId;
  if (alt.machineTag !== undefined) {
    const free = venueMachines(ctx, actor, alt).filter((id) => !heldByAnother(ctx, def, id));
    const position = freePosition(ctx, actor, free);
    return position === undefined ? undefined : machineVenue(ctx, position);
  }
  if (alt.zoneTag !== undefined) {
    for (const zone of zonesTagged(ctx, actor, alt.zoneTag)) {
      if (heldByAnother(ctx, def, zone.key)) continue;
      const tile = freeTile(ctx, actor, zone.tiles, "nearest");
      const compartmentId = zoneCompartment(ctx, deckId, zone.tiles);
      if (tile !== undefined && compartmentId !== undefined) {
        return { venue: { compartmentId, zoneKey: zone.key }, target: tile };
      }
    }
    return undefined;
  }
  if (alt.compartmentTag !== undefined) {
    for (const compartmentId of compartmentsTagged(ctx, deckId, alt.compartmentTag)) {
      const tile = freeTile(ctx, actor, compartmentFloor(ctx, deckId, compartmentId), "hashed");
      if (tile !== undefined) return { venue: { compartmentId }, target: tile };
    }
  }
  return undefined;
}

function machineVenue(ctx: VenueCtx, position: NavInteractionPosition): ResolvedVenue | undefined {
  const compartmentId = machineCompartment(ctx, position.machineId);
  if (compartmentId === undefined) return undefined;
  return {
    venue: { compartmentId, machineId: position.machineId },
    target: { machineId: position.machineId, positionKey: position.key },
  };
}

/** A free spot at a session's fixed venue. */
function atSession(
  ctx: VenueCtx,
  actor: Actor,
  session: DeepReadonly<GroupSession>,
): ResolvedVenue | undefined {
  if (actor.location.kind !== "onDeck") return undefined;
  const deckId = actor.location.deckId;
  const venue = session.venue;
  if ("machineId" in venue) {
    const position = freePosition(ctx, actor, [venue.machineId]);
    return position === undefined ? undefined : machineVenue(ctx, position);
  }
  if ("zoneKey" in venue) {
    const zone = ctx.content.decks[deckId]?.zones.find((z) => z.key === venue.zoneKey);
    const tile = zone === undefined ? undefined : freeTile(ctx, actor, zone.tiles, "nearest");
    return tile === undefined
      ? undefined
      : { venue: { compartmentId: venue.compartmentId, zoneKey: venue.zoneKey }, target: tile };
  }
  const tile = freeTile(ctx, actor, compartmentFloor(ctx, deckId, venue.compartmentId), "nearest");
  return tile === undefined
    ? undefined
    : { venue: { compartmentId: venue.compartmentId }, target: tile };
}

/** Where `actor` would do `def` (joining `session` if given); undefined when nowhere is free. */
export function resolveVenue(
  ctx: VenueCtx,
  actor: Actor,
  def: DeepReadonly<ActivityDef>,
  session?: DeepReadonly<GroupSession>,
): ResolvedVenue | undefined {
  if (session !== undefined) return atSession(ctx, actor, session);
  for (const alt of def.venue) {
    const found = atAlternative(ctx, actor, def, alt);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The venue of `def` the actor is standing at, by its alternatives in order: a `use` position of
 * a tagged machine, a tile of a tagged zone, or a tagged compartment. The host's first tick opens
 * the session here; a solo outcome resolves here.
 */
export function venueAt(
  ctx: VenueCtx,
  actor: Actor,
  def: DeepReadonly<ActivityDef>,
): SessionVenue | undefined {
  const here = standingTile(actor);
  if (here === undefined || actor.location.kind !== "onDeck") return undefined;
  const deckId = actor.location.deckId;
  const geometry = ctx.caches.nav.decks[deckId];
  if (geometry === undefined) return undefined;
  const compartmentId = compartmentAt(geometry, here.x, here.y);
  for (const alt of def.venue) {
    if (alt.machineTag !== undefined) {
      const tagged = venueMachines(ctx, actor, alt);
      const position = geometry.interactionPositions.find(
        (p) =>
          tagged.includes(p.machineId) &&
          p.purposes.includes("use") &&
          p.tile.x === here.x &&
          p.tile.y === here.y,
      );
      const at = position === undefined ? undefined : machineCompartment(ctx, position.machineId);
      if (position !== undefined && at !== undefined) {
        return { compartmentId: at, machineId: position.machineId };
      }
    } else if (alt.zoneTag !== undefined) {
      const zone = zonesTagged(ctx, actor, alt.zoneTag).find((z) =>
        z.tiles.some((t) => t.x === here.x && t.y === here.y),
      );
      const at = zone === undefined ? undefined : zoneCompartment(ctx, deckId, zone.tiles);
      if (zone !== undefined && at !== undefined) return { compartmentId: at, zoneKey: zone.key };
    } else if (alt.compartmentTag !== undefined && compartmentId !== undefined) {
      if (compartmentsTagged(ctx, deckId, alt.compartmentTag).includes(compartmentId)) {
        return { compartmentId };
      }
    }
  }
  return undefined;
}

/** Is `venue`'s machine or zone the venue of a session of another activity (`heldByAnother`)? */
export function venueTakenByAnother(
  ctx: VenueCtx,
  def: DeepReadonly<ActivityDef>,
  venue: DeepReadonly<SessionVenue>,
): boolean {
  if ("machineId" in venue) return heldByAnother(ctx, def, venue.machineId);
  if ("zoneKey" in venue) return heldByAnother(ctx, def, venue.zoneKey);
  return false;
}

/** Are two venues the same place (compartment, and machine or zone)? */
export function sameVenue(a: DeepReadonly<SessionVenue>, b: DeepReadonly<SessionVenue>): boolean {
  if (a.compartmentId !== b.compartmentId) return false;
  const machineA = "machineId" in a ? a.machineId : undefined;
  const machineB = "machineId" in b ? b.machineId : undefined;
  const zoneA: LocalKey | undefined = "zoneKey" in a ? a.zoneKey : undefined;
  const zoneB: LocalKey | undefined = "zoneKey" in b ? b.zoneKey : undefined;
  return machineA === machineB && zoneA === zoneB;
}
