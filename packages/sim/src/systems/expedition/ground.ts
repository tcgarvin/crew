/**
 * Expeditions A1 (§8.1): the ground a fight is on, read once a tick: the site map in its berth,
 * the deck's nav geometry, the foot and top of the personnel ramp, and the site's posts, all in
 * the deck frame the fight runs in; and where each person is on it.
 *
 * Owner: W2 of expeditions A1.
 */
import { type BerthedDock, dockToDeck, isOnDock } from "../../core/docks";
import { rampFoot, siteOf } from "../../core/sites";
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly, TileCoord } from "../../core/types/common";
import type { DockPostKind } from "../../core/types/content";
import type { DeckDefId, DoorId } from "../../core/types/ids";
import type { DeckGeometry } from "../../core/types/nav";
import type { ReadonlyWorldState, StepCtx } from "../../core/types/pipeline";
import { rampTop } from "../spatial/dock";
import { isDockTile, isStaticWalkable } from "../spatial/geometry";

export interface Ground {
  readonly berth: BerthedDock;
  readonly geometry: DeckGeometry;
  readonly deckId: DeckDefId;
  /** The personnel ramp's landing on the site floor: where the party gathers and falls back to. */
  readonly foot: TileCoord;
  /** The ship tile at the top of the personnel ramp: aboard. */
  readonly top: TileCoord;
  /** The first post of each kind on the site, in the deck frame. */
  readonly posts: Partial<Readonly<Record<DockPostKind, TileCoord>>>;
}

/** The personnel ramp's door id on the deck alongside. */
function personnelRamp(ctx: Pick<StepCtx, "state" | "content">, deckId: DeckDefId): DoorId {
  const key = ctx.content.decks[deckId]?.docking.personnelRampDoorKey;
  const ramps = Object.values(ctx.state.doors).filter((d) => d.kind === "ramp");
  const ramp = ramps.find((d) => d.placementKey === key) ?? ramps[0];
  if (ramp === undefined) throw new Error(`deck "${deckId}" has no ramp to go ashore by`);
  return ramp.id;
}

/** The ground of the site alongside, or undefined with no site alongside. */
export function groundOf(ctx: Pick<StepCtx, "state" | "content" | "caches">): Ground | undefined {
  const berth = siteOf(ctx.content, ctx.state);
  const presence = ctx.state.deck.dock;
  if (berth === undefined || presence === undefined) return undefined;
  const geometry = ctx.caches.nav.decks[presence.deckId];
  const foot = rampFoot(ctx.content, ctx.state);
  if (geometry === undefined || foot === undefined) return undefined;
  const posts: Partial<Record<DockPostKind, TileCoord>> = {};
  for (const post of berth.dock.posts) {
    posts[post.kind] ??= dockToDeck(berth, post.tile);
  }
  return {
    berth,
    geometry,
    deckId: presence.deckId,
    foot,
    top: rampTop(geometry, personnelRamp(ctx, presence.deckId)),
    posts,
  };
}

/** The tile an actor stands on (a carried actor's carrier's), or undefined off deck. */
export function tileOfActor(
  state: ReadonlyWorldState,
  actor: DeepReadonly<Actor>,
): TileCoord | undefined {
  const location =
    actor.location.kind === "carriedBy"
      ? state.actors[actor.location.actorId]?.location
      : actor.location;
  if (location?.kind !== "onDeck") return undefined;
  return { x: Math.floor(location.x), y: Math.floor(location.y) };
}

/** On the site floor (not aboard, not carried). */
export function onSite(
  ctx: Pick<StepCtx, "state" | "content">,
  actor: DeepReadonly<Actor>,
): boolean {
  return isOnDock(ctx.content, ctx.state, actor.location);
}

/** On the ship's own floor, the ramp's top included. */
export function aboard(
  ctx: Pick<StepCtx, "state" | "content">,
  ground: Ground,
  actor: DeepReadonly<Actor>,
): boolean {
  const location = actor.location;
  return (
    location.kind === "onDeck" &&
    location.deckId === ground.deckId &&
    !isOnDock(ctx.content, ctx.state, location)
  );
}

/** A site floor tile someone can stand on. */
export function standable(ground: Ground, tile: TileCoord): boolean {
  return (
    isDockTile(ground.geometry, tile.x, tile.y) && isStaticWalkable(ground.geometry, tile.x, tile.y)
  );
}

/** Straight-line distance between tile centres. */
export function distance(a: TileCoord, b: TileCoord): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export const sameTile = (a: TileCoord, b: TileCoord): boolean => a.x === b.x && a.y === b.y;
