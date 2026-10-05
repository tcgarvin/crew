/**
 * The recreation candidate (slice 4, calls 1 and 2): one candidate per person, the best-scored
 * activity, never above routine class: off duty anything above `needs.seekThreshold`; between
 * `recreation.joinAbove` and the seek threshold only joining an open session (a neutral player
 * makes up the table when they have time on their hands); nothing below. On duty (D84 tuning) only
 * above the seek threshold and at `voluntaryActivity`, as rest and chat are (`leisureCandidate`):
 * any routine work still wins, but a cook with nothing on the stove bakes or plays instead of
 * standing idle at the post (the post and rounds are voluntary too and rank by travel). Every recreation candidate is `routineObligation` (W1 deviation from call 1, which made
 * the join voluntary): off watch everyone is in a voluntary rest or chat hold, which a voluntary
 * candidate never interrupts, so a voluntary join never filled a table.
 *
 * Each `ActivityDef` the deck has a venue for is scored: interest (strong like 3, like 2, neutral
 * 1, dislike 0, never chosen; the 3/2/1/0 rule is `core/interests.ts` `interestScore`, which the
 * planner may not import, so it is restated here), +2 for an open session with room (D84 tuning;
 * call 2 said +1), +1 for hosting a group activity (D84 tuning: company is worth something), +0.5
 * for a session holding someone the actor likes (affinity above `social.preferAbove`), −∞ for one
 * holding someone at or below `social.avoidBelow`; with mood above `mood.highAbove` group
 * activities +1; with mood below `mood.lowBelow` solo only (a group game's `solo` variant, or a
 * min-1 group activity played alone). Joining needs score ≥ 1; hosting needs a like (interest
 * ≥ 2); playing a solo activity needs ≥ 1 (a bored person with nothing they like still does
 * something). Ties: join over host over solo, then travel, then the bigger table (D84 tuning: the
 * vids before the two-player video game at the one vid screen), then id. Emits `recreate:<activityId>` with
 * `choice.activityId`, `choice.role` and (joining) `choice.sessionId`.
 *
 * Reads `self.interests`, `self.affinity`, `self.mood`, `sessions()`, `travel()`, known items
 * (`ownerId` for an owned instrument), `knownProblems()` for `blockedByProblems`, the schematic
 * for venue presence, and the defs from `activities()`. It cannot see reservations: a seat lost
 * on the way is the plan's and the step's to find (`occupiedPosition`, backoff).
 *
 * Owner: W1 of ship life slice 4.
 */
import type { DeepReadonly, TileCoord } from "../core/types/common";
import type { ActivityDef, InterestTag, VenueDef } from "../core/types/content";
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView, SessionView } from "../core/types/view";
import type { RecreateRole, UrgencyClass } from "../core/types/work";
import type { Candidate, Rejection } from "./candidates";
import { backingOff, inMyHands, loungeTile, personal } from "./common";

type Def = DeepReadonly<ActivityDef>;

interface Option {
  readonly def: Def;
  readonly role: RecreateRole;
  readonly session?: SessionView;
  readonly score: number;
  readonly ticks: number;
}

const ROLE_ORDER: Readonly<Record<RecreateRole, number>> = { join: 0, host: 1, solo: 2 };

/**
 * D84 tuning: an open session with room is worth +2 (call 2 said +1), so a neutral joiner (1 + 2)
 * makes up a table against their own strong-liked solo (3), and the join-over-solo tie fills it;
 * at +1 a third of sessions collapsed for want of a second player.
 */
const OPEN_SESSION_BONUS = 2;

/**
 * D84 tuning: hosting a group activity is worth its interest + 1 (company is worth something), so
 * a liked debate (2 + 1) ties a strong-liked solo (3) and the host-over-solo tie opens it; at bare
 * interest nobody ever hosted a debate.
 */
const HOST_COMPANY_BONUS = 1;

/** Strong like 3, like 2, neutral 1, dislike 0 (`core/interests.ts` `interestScore`). */
export function interestScoreOf(view: AgentView, tag: InterestTag): number {
  const interests = view.self.interests;
  if (interests.dislikes.includes(tag)) return 0;
  if (interests.strong === tag) return 3;
  if (interests.likes.includes(tag)) return 2;
  return 1;
}

const isGroup = (def: Def): boolean => def.participants.max >= 2;

/** The compartment of the actor's own bed, if they have one. */
function berthCompartment(view: AgentView): string | undefined {
  const bed = view.self.berth?.machineId;
  if (bed === undefined) return undefined;
  const placement = view.schematic.machines().find((m) => m.machineId === bed);
  const tile = placement?.footprint[0];
  return tile === undefined ? undefined : view.schematic.compartmentAt(tile);
}

/** A tile representing one venue alternative on this deck, if it is there. */
function alternativeTile(view: AgentView, alt: DeepReadonly<VenueDef>): TileCoord | undefined {
  if (alt.machineTag !== undefined) {
    const own = alt.own === true ? berthCompartment(view) : undefined;
    if (alt.own === true && own === undefined) return undefined;
    for (const machine of view.schematic.amenities(alt.machineTag)) {
      const origin = machine.footprint[0];
      if (
        own !== undefined &&
        (origin === undefined || view.schematic.compartmentAt(origin) !== own)
      ) {
        continue;
      }
      const use = machine.interactionTiles.find((t) => t.purposes.includes("use"));
      if (use !== undefined) return use.tile;
    }
    return undefined;
  }
  if (alt.zoneTag !== undefined) {
    const tag = alt.zoneTag;
    const zone = view.schematic.deck.zones.find((z) => z.tags.includes(tag));
    const first = zone?.tiles[0];
    return first === undefined ? undefined : { x: first.x, y: first.y };
  }
  if (alt.compartmentTag !== undefined) return loungeTile(view, [alt.compartmentTag]);
  return undefined;
}

/** The first venue alternative of `def` the deck has, as a tile. */
function venueTile(view: AgentView, def: Def): TileCoord | undefined {
  for (const alt of def.venue) {
    const tile = alternativeTile(view, alt);
    if (tile !== undefined) return tile;
  }
  return undefined;
}

/** A tile at a session's venue: its machine's seat, its zone, or a floor tile of the room. */
function sessionTile(view: AgentView, session: SessionView): TileCoord | undefined {
  const venue = session.venue;
  if ("machineId" in venue) {
    const machine = view.schematic.machines().find((m) => m.machineId === venue.machineId);
    return machine?.interactionTiles.find((t) => t.purposes.includes("use"))?.tile;
  }
  if ("zoneKey" in venue) {
    const first = view.schematic.deck.zones.find((z) => z.key === venue.zoneKey)?.tiles[0];
    return first === undefined ? undefined : { x: first.x, y: first.y };
  }
  const rows = view.schematic.deck.tiles;
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < (rows[y]?.length ?? 0); x++) {
      const tile = { x, y };
      if (
        view.schematic.isFloor(tile) &&
        view.schematic.compartmentAt(tile) === venue.compartmentId
      ) {
        return tile;
      }
    }
  }
  return undefined;
}

/**
 * Ticks to reach `to` from where the actor stands, by way of the item the activity requires
 * (`null` when the item or the venue cannot be reached, or the item is not known).
 */
function travelTicks(view: AgentView, def: Def, to: TileCoord): number | null {
  const requires = def.requires;
  if (requires === undefined) return view.estimateTravelTicks(to);
  let best: number | null = null;
  for (const item of view.knownItems()) {
    if (item.absent || !item.tags.includes(requires.itemTag)) continue;
    if (requires.own === true && item.ownerId !== view.self.id) continue;
    if (inMyHands(view, item)) return view.estimateTravelTicks(to);
    if (item.tile === undefined || item.location.kind !== "onDeck") continue;
    const fetch = view.estimateTravelTicks(item.tile);
    const onward = view.estimateTravelTicks(to, item.tile);
    if (fetch === null || onward === null) continue;
    if (best === null || fetch + onward < best) best = fetch + onward;
  }
  return best;
}

/** Is `def` offered now: the right stage of the voyage, and no blocking problem known open? */
function offeredNow(view: AgentView, def: Def): boolean {
  if (def.transitOnly === true && view.travel().stage !== "transit") return false;
  const blocking = def.blockedByProblems ?? [];
  if (blocking.length === 0) return true;
  return !view.knownProblems().some((p) => p.status === "open" && blocking.includes(p.kind));
}

/** Can a latecomer still join `session`: room left and not running past `lateJoinSeconds`? */
function hasRoom(view: AgentView, config: PlannerConfig, def: Def, session: SessionView): boolean {
  if (session.members.length >= def.participants.max) return false;
  if (session.startedTick === undefined) return true;
  const late = Math.ceil(config.recreation.lateJoinSeconds * config.time.tickRate);
  return view.tick - session.startedTick <= late;
}

/** The company bonus of a session: −∞ with an enemy in it, +0.5 with a friend. */
function companyBonus(view: AgentView, config: PlannerConfig, session: SessionView): number {
  let bonus = 0;
  for (const memberId of session.members) {
    if (memberId === view.self.id) continue;
    const affinity = view.self.affinity[memberId] ?? 0;
    if (affinity <= config.social.avoidBelow) return Number.NEGATIVE_INFINITY;
    if (affinity > config.social.preferAbove) bonus = 0.5;
  }
  return bonus;
}

/** Every way the actor might take part in `def` now, scored (see the module comment). */
function optionsFor(view: AgentView, config: PlannerConfig, def: Def, routine: boolean): Option[] {
  const interest = interestScoreOf(view, def.interest);
  if (interest === 0) return [];
  const mood = view.self.mood;
  const out: Option[] = [];
  const add = (
    role: RecreateRole,
    score: number,
    to: TileCoord | undefined,
    session?: SessionView,
  ) => {
    if (to === undefined || !Number.isFinite(score)) return;
    const ticks = travelTicks(view, def, to);
    if (ticks === null) return;
    out.push({ def, role, score, ticks, ...(session === undefined ? {} : { session }) });
  };
  if (!isGroup(def)) {
    if (routine) add("solo", interest, venueTile(view, def));
    return out;
  }
  if (mood < config.mood.lowBelow) {
    // Solo only: a game's solitaire, or a min-1 group activity alone (vids).
    const alone = def.participants.min < 2 || def.solo !== undefined;
    if (routine && alone) add("solo", interest, venueTile(view, def));
    return out;
  }
  const high = mood > config.mood.highAbove ? 1 : 0;
  const ofDef = view.sessions().filter((session) => session.activityId === def.id);
  for (const session of ofDef) {
    if (!hasRoom(view, config, def, session)) continue;
    add(
      "join",
      interest + OPEN_SESSION_BONUS + high + companyBonus(view, config, session),
      sessionTile(view, session),
      session,
    );
  }
  // One game of a kind at a time: with cards already on (open, or full and running), a second
  // table would only gather nobody and collapse (the fifth of five would-be hosts).
  if (routine && interest >= 2 && ofDef.length === 0) {
    add("host", interest + HOST_COMPANY_BONUS + high, venueTile(view, def));
  }
  return out;
}

const better = (a: Option, b: Option | undefined): boolean =>
  b === undefined ||
  (a.score !== b.score
    ? a.score > b.score
    : a.role !== b.role
      ? ROLE_ORDER[a.role] < ROLE_ORDER[b.role]
      : a.ticks !== b.ticks
        ? a.ticks < b.ticks
        : a.def.participants.max !== b.def.participants.max
          ? a.def.participants.max > b.def.participants.max
          : a.def.id < b.def.id);

export function recreationCandidate(
  view: AgentView,
  config: PlannerConfig,
): Candidate | Rejection | undefined {
  const boredom = view.self.needs.recreation;
  const onDuty = view.self.onDuty;
  if (boredom <= (onDuty ? config.needs.seekThreshold : config.recreation.joinAbove)) {
    return undefined;
  }
  const routine = boredom > config.needs.seekThreshold;
  // A plan that could not be built backs off the bare ref (`startPersonal`); a failed game its own.
  if (backingOff(view, "recreate")) return { ref: "recreate", reason: "backoff" };
  let best: Option | undefined;
  let backedOff = false;
  for (const def of view.activities()) {
    if (backingOff(view, `recreate:${def.id}`)) {
      backedOff = true;
      continue;
    }
    if (!offeredNow(view, def)) continue;
    for (const option of optionsFor(view, config, def, routine)) {
      if (better(option, best)) best = option;
    }
  }
  if (best === undefined) {
    return backedOff ? { ref: "recreate", reason: "backoff" } : undefined;
  }
  // A join below the seek threshold is routine too, not voluntary: off watch everyone is already
  // in a voluntary rest or chat hold, which a voluntary candidate never interrupts (same-class
  // commitment), so the open table would never fill. The mess call is routine for the same reason.
  // On duty it is voluntary, so the watch's work (routine) always comes first.
  const urgency: UrgencyClass = onDuty ? "voluntaryActivity" : "routineObligation";
  return personal(`recreate:${best.def.id}`, urgency, best.ticks, view.tick, {
    kind: "personal",
    activity: "recreate",
    activityId: best.def.id,
    role: best.role,
    ...(best.session === undefined ? {} : { sessionId: best.session.id }),
  });
}
