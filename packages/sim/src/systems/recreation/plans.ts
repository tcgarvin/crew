import { lockerTileOf } from "../../core/berths";
/**
 * The `recreate` plan (slice 4, calls 12 and 13): an item the activity `requires` is fetched
 * first (slice 3's acquire shape: `moveTo` its believed tile, `pickUp`; one's own `instrument` by
 * `ownerId`, a `book` split off the shelf's stack), then the venue (`resolveVenue`), then the
 * `recreate` step with the intent's `role` and `sessionId`, then the item carried home and
 * `putDown` (an owned item's locker tile, `core/berths.ts` `lockerTileOf`; the first tile of the
 * `bookShelf` zone for a book; where it was picked up when it has no home). `transitOnly` against
 * `state.travel.stage`; `blockedByProblems` against open problems (`dependencyPending`). No item
 * believed anywhere fails the plan (`inaccessibleSupply`); one not where believed fails the
 * pick-up the same way. A join whose session is gone or full, or a venue with no free spot, is
 * `occupiedPosition`.
 *
 * Owner: W1 of ship life slice 4.
 */
import { dayTicks } from "../../core/clock";
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly, TileCoord } from "../../core/types/common";
import type { ActivityDef } from "../../core/types/content";
import type { ItemId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { ActivityStep, Intent, RecreateRole } from "../../core/types/work";
import {
  type PlanResult,
  acquireSteps,
  believedLocation,
  blocked,
  carriedItems,
  planOf,
} from "../work/plans";
import { isGroup, soloTicks, standingTile } from "./common";
import { joinable } from "./sessions";
import { resolveVenue } from "./venues";

const manhattan = (a: TileCoord, b: TileCoord): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** Is something stopping `def` today: the wrong stage of the voyage, or a blocking problem? */
export function offeredNow(ctx: Pick<StepCtx, "state">, def: DeepReadonly<ActivityDef>): boolean {
  if (def.transitOnly === true && ctx.state.travel.stage !== "transit") return false;
  const blocking = def.blockedByProblems ?? [];
  if (blocking.length === 0) return true;
  return !Object.values(ctx.state.work.problems).some(
    (p) => p.status === "open" && blocking.includes(p.kind),
  );
}

/** The item `def` requires: one in hand, else the nearest believed on deck (own, for `own`). */
function requiredItem(
  ctx: StepCtx,
  actor: Actor,
  def: DeepReadonly<ActivityDef>,
): { readonly itemId: ItemId; readonly inHand: boolean; readonly from?: TileCoord } | undefined {
  const requires = def.requires;
  if (requires === undefined) return undefined;
  const fits = (itemId: ItemId): boolean => {
    const item = ctx.state.items[itemId];
    if (item === undefined) return false;
    if (!ctx.content.items[item.defId]?.tags.includes(requires.itemTag)) return false;
    return requires.own !== true || (item.stacking === "unique" && item.ownerId === actor.id);
  };
  const held = carriedItems(ctx, actor.id).find((item) => fits(item.id));
  if (held !== undefined) return { itemId: held.id, inHand: true };
  const here = standingTile(actor) ?? { x: 0, y: 0 };
  let best: { itemId: ItemId; tile: TileCoord; d: number } | undefined;
  for (const fact of Object.values(actor.knowledge)) {
    if (fact.factType !== "itemLocation" || fact.value.absent === true) continue;
    const itemId = fact.subjectId as ItemId;
    const location = believedLocation(actor, itemId);
    if (location?.kind !== "onDeck" || !fits(itemId)) continue;
    const tile = { x: Math.floor(location.x), y: Math.floor(location.y) };
    const d = manhattan(tile, here);
    if (best === undefined || d < best.d || (d === best.d && itemId < best.itemId)) {
      best = { itemId, tile, d };
    }
  }
  return best === undefined ? undefined : { itemId: best.itemId, inHand: false, from: best.tile };
}

/** Where a fetched item goes back: an owned item's locker, a book's shelf, else where it was. */
function homeOf(
  ctx: StepCtx,
  actor: Actor,
  def: DeepReadonly<ActivityDef>,
  from: TileCoord | undefined,
): TileCoord | undefined {
  if (actor.location.kind !== "onDeck") return from;
  const deck = ctx.content.decks[actor.location.deckId];
  if (deck === undefined) return from;
  if (def.requires?.own === true) {
    const bedKey = ctx.state.berths[actor.id];
    const locker = bedKey === undefined ? undefined : lockerTileOf(deck, bedKey);
    return locker ?? from;
  }
  if (def.requires?.itemTag === "book") {
    const shelf = deck.zones.find((z) => z.tags.includes("bookShelf"))?.tiles[0];
    return shelf === undefined ? from : { ...shelf };
  }
  return from;
}

export function recreatePlan(
  ctx: StepCtx,
  actor: Actor,
  intent: Extract<Intent, { kind: "personal" }>,
): PlanResult {
  const def =
    intent.activityId === undefined ? undefined : ctx.content.activities[intent.activityId];
  if (def === undefined) return blocked("unreachableTarget");
  if (!offeredNow(ctx, def)) return blocked("dependencyPending");
  const role: RecreateRole = !isGroup(def) ? "solo" : (intent.role ?? "host");
  const session =
    role === "join" && intent.sessionId !== undefined
      ? ctx.state.social.sessions[intent.sessionId]
      : undefined;
  if (role === "join" && (session === undefined || !joinable(ctx, session))) {
    return blocked("occupiedPosition");
  }
  const item = requiredItem(ctx, actor, def);
  if (def.requires !== undefined && item === undefined) return blocked("inaccessibleSupply");
  const acquire: ActivityStep[] | string =
    item === undefined || item.inHand ? [] : acquireSteps(ctx, actor, item.itemId, true);
  if (typeof acquire === "string") return blocked("inaccessibleSupply");
  const venue = resolveVenue(ctx, actor, def, session);
  if (venue === undefined) return blocked("occupiedPosition");
  const ticksNeeded =
    role === "solo" ? soloTicks(ctx.config, def, role) : dayTicks(ctx.config, def.durationDays);
  const steps: ActivityStep[] = [
    ...acquire,
    { kind: "moveTo", target: venue.target, requested: false },
    {
      kind: "recreate",
      activityId: def.id,
      role,
      ...(role === "join" && intent.sessionId !== undefined ? { sessionId: intent.sessionId } : {}),
      ticksDone: 0,
      ticksNeeded,
    },
  ];
  if (item !== undefined) {
    const home = homeOf(ctx, actor, def, item.from);
    if (home !== undefined) steps.push({ kind: "moveTo", target: { ...home }, requested: false });
    steps.push({ kind: "putDown", itemId: item.itemId });
  }
  return planOf(steps);
}
