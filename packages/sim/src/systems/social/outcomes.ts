/**
 * Outcomes (slice 4, call 5), resolved once at a session's end by the recreation system, which
 * then deletes the row (this module never touches `social.sessions`).
 *
 * - *contest*: a winner by `rng.weighted("social")` over the members with weight
 *   `1 + interestScore`; the tally and streak per loser (`social.rivalries`); `win`/`lose`
 *   thoughts; memories by `def.memories` (`together` pairwise both ways, `loserToWinner`); a
 *   losing run of `social.rivalry.streakFor` or more gives the loser the `keepsBeatingMe`
 *   thought (refId the winner) and memory, and reaching it exactly also `rivalryStreak` (one
 *   line per run, not one per further loss).
 * - *debate*: the session's topic (else one picked from `def.topics`); each member's stance by
 *   `stanceOn`; per pair, within `social.debate.agreeWithin` `spiritedTalk` and `goodTalk` both
 *   ways, at or beyond `argueBeyond` `argued` (thought refId the other, and memory) both ways, and the session's
 *   first arguing pair is its one `argument` event; anyone awake in the venue compartment who is
 *   not a member and does not like debate gets `gotLectured`.
 * - *perform*: everyone awake in the compartment but the performer (the host): likers of the
 *   def's interest `listened` (`enjoyedMusic`) and `playedForMe` toward the performer, dislikers
 *   `listenedDislike` (`hatedTheNoise`), the neutral nothing.
 * - *bond*: with two or more members, `joined` (`goodCompany`) all round, and `memories.together`
 *   from each member who likes the def's interest toward each other member (D85 tuning).
 * - *none*: nothing.
 *
 * Then for every outcome: `skillGain` (`perDay × durationDays`, capped at 10) per member, `dirt`
 * (`depositDirt` at the venue tile), `produces` (a stack on the first tile of the zone carrying
 * `zoneTag`, `Item.meal` from the host's cooking and the venue room's tier, `treatsBaked`, every
 * crew member aboard told where it is) and `risk` (per member, `sparringBruise` and `tookAKnock`).
 *
 * Returns what the recreation system's `sessionEnded` payload needs (`winnerId`, `topicId`,
 * `argued`). A one-member session (a solo activity's completion) resolves the same way: no
 * winner, no pairs, the skill, dirt, product and risk still apply.
 *
 * Owner: W2 of ship life slice 4.
 */
import { dayTicks } from "../../core/clock";
import { allocateId } from "../../core/ids";
import { interestScore, stanceOn } from "../../core/interests";
import { rivalryKey } from "../../core/social";
import { addThought } from "../../core/thoughts";
import type { Actor } from "../../core/types/actor";
import type { TileCoord } from "../../core/types/common";
import type { ActivityDef, MemoryKey, ThoughtKey, TopicDef } from "../../core/types/content";
import type { ActorId, DeckDefId, ItemId, TopicDefId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { Item } from "../../core/types/ship";
import type { GroupSession } from "../../core/types/state";
import { depositDirt } from "../dirt/deposit";
import { mealQuality, positionTiles, roomTierAt, tileAt } from "../galley/kitchen";
import { isAsleep } from "../work/activity";
import { emitSim } from "../work/events";
import { writeFact } from "../work/facts";
import { awaitsFamiliarityBrief } from "../work/perception";
import { touchInventory } from "../work/steps";
import { addMemory } from "./relationships";

/** Skill levels stop here (as piloting practice does at the helm). */
const SKILL_CAP = 10;
/** An interest score at or above this is a like (2 like, 3 strong). */
const LIKES_FROM = 2;

/** What the session's `sessionEnded` line needs from its outcome. */
export interface OutcomeSummary {
  readonly winnerId?: ActorId;
  readonly topicId?: TopicDefId;
  readonly argued?: boolean;
}

export function resolveOutcome(
  ctx: StepCtx,
  session: GroupSession,
  def: ActivityDef,
): OutcomeSummary {
  const members = membersOf(ctx, session);
  let summary: OutcomeSummary = {};
  switch (def.outcome) {
    case "contest":
      summary = resolveContest(ctx, def, members);
      break;
    case "debate":
      summary = resolveDebate(ctx, session, def, members);
      break;
    case "perform":
      resolvePerform(ctx, session, def);
      break;
    case "bond":
      resolveBond(ctx, def, members);
      break;
    case "none":
      break;
  }
  applySkillGain(ctx, def, members);
  applyDirt(ctx, session, def);
  applyProduces(ctx, session, def);
  applyRisk(ctx, def, members);
  return summary;
}

/** The session's members still aboard as actors, in member order. */
function membersOf(ctx: StepCtx, session: GroupSession): Actor[] {
  return session.members.flatMap((id) => {
    const actor = ctx.state.actors[id];
    return actor === undefined ? [] : [actor];
  });
}

/** Every unordered pair of `members`, in member order. */
function pairsOf<T>(members: readonly T[]): [T, T][] {
  return members.flatMap((a, i) => members.slice(i + 1).map((b): [T, T] => [a, b]));
}

/** `a` and `b` each remember `key` about the other. */
function rememberBoth(ctx: StepCtx, a: ActorId, b: ActorId, key: MemoryKey): void {
  addMemory(ctx, a, b, key);
  addMemory(ctx, b, a, key);
}

// ---------------------------------------------------------------------------------------------
// Contest
// ---------------------------------------------------------------------------------------------

function resolveContest(ctx: StepCtx, def: ActivityDef, members: Actor[]): OutcomeSummary {
  if (members.length < 2) return {};
  const winner = ctx.rng.weighted(
    "social",
    members.map((actor) => ({
      item: actor,
      weight: 1 + interestScore(actor.interests, def.interest),
    })),
  );
  const losers = members.filter((actor) => actor.id !== winner.id);
  const together = def.memories?.together;
  if (together !== undefined) {
    for (const [a, b] of pairsOf(members)) rememberBoth(ctx, a.id, b.id, together);
  }
  if (def.thoughts?.win !== undefined) addThought(ctx, winner, def.thoughts.win);
  const loserToWinner = def.memories?.loserToWinner;
  for (const loser of losers) {
    if (def.thoughts?.lose !== undefined) addThought(ctx, loser, def.thoughts.lose);
    if (loserToWinner !== undefined) addMemory(ctx, loser.id, winner.id, loserToWinner);
    tally(ctx, def, winner, loser);
  }
  return { winnerId: winner.id };
}

/**
 * One more win for `winner` over `loser` at `def` in the pair's rivalry row; a losing run at
 * `streakFor` or more weighs on the loser (see the module comment).
 */
function tally(ctx: StepCtx, def: ActivityDef, winner: Actor, loser: Actor): void {
  const key = rivalryKey(winner.id, loser.id, def.id);
  const row = ctx.state.social.rivalries[key] ?? { wins: 0, losses: 0, streak: 0 };
  ctx.state.social.rivalries[key] = row;
  const winnerIsFirst = key.startsWith(`${winner.id}|`);
  if (winnerIsFirst) {
    row.wins += 1;
    row.streak = row.streak > 0 ? row.streak + 1 : 1;
  } else {
    row.losses += 1;
    row.streak = row.streak < 0 ? row.streak - 1 : -1;
  }
  const run = Math.abs(row.streak);
  const { streakFor } = ctx.config.social.rivalry;
  if (run < streakFor) return;
  addThought(ctx, loser, "keepsBeatingMe", winner.id);
  addMemory(ctx, loser.id, winner.id, "keepsBeatingMe");
  if (run !== streakFor) return;
  emitSim(ctx, "rivalryStreak", [winner.id, loser.id], {
    winnerId: winner.id,
    loserId: loser.id,
    activityId: def.id,
    streak: run,
  });
}

// ---------------------------------------------------------------------------------------------
// Debate, performance, bond
// ---------------------------------------------------------------------------------------------

/** The awake people in the venue's compartment other than `except`. */
function audience(ctx: StepCtx, session: GroupSession, except: ReadonlySet<ActorId>): Actor[] {
  const here = ctx.caches.index.actorsByCompartment[session.venue.compartmentId] ?? [];
  return here.flatMap((id) => {
    const actor = ctx.state.actors[id];
    if (actor === undefined || except.has(id) || isAsleep(actor.activity)) return [];
    return [actor];
  });
}

function debateTopic(ctx: StepCtx, session: GroupSession, def: ActivityDef): TopicDef | undefined {
  const topicId =
    session.topicId ??
    (def.topics === undefined || def.topics.length === 0
      ? undefined
      : ctx.rng.pick("social", def.topics));
  if (topicId === undefined) return undefined;
  const topic = ctx.content.topics[topicId];
  if (topic === undefined) throw new Error(`resolveOutcome: content has no topic "${topicId}"`);
  return topic;
}

function resolveDebate(
  ctx: StepCtx,
  session: GroupSession,
  def: ActivityDef,
  members: Actor[],
): OutcomeSummary {
  const topic = debateTopic(ctx, session, def);
  const memberIds = new Set(members.map((actor) => actor.id));
  for (const bystander of audience(ctx, session, memberIds)) {
    if (interestScore(bystander.interests, def.interest) < LIKES_FROM) {
      addThought(ctx, bystander, "gotLectured");
    }
  }
  if (topic === undefined) return {};
  const { agreeWithin, argueBeyond } = ctx.config.social.debate;
  let argued = false;
  for (const [a, b] of pairsOf(members)) {
    const gap = Math.abs(stanceOn(a.values, topic) - stanceOn(b.values, topic));
    if (gap <= agreeWithin) {
      addThought(ctx, a, "spiritedTalk");
      addThought(ctx, b, "spiritedTalk");
      rememberBoth(ctx, a.id, b.id, "goodTalk");
    } else if (gap >= argueBeyond) {
      addThought(ctx, a, "argued", b.id);
      addThought(ctx, b, "argued", a.id);
      rememberBoth(ctx, a.id, b.id, "argued");
      if (!argued)
        emitSim(ctx, "argument", [a.id, b.id], { aId: a.id, bId: b.id, topicId: topic.id });
      argued = true;
    }
  }
  return { topicId: topic.id, argued };
}

function resolvePerform(ctx: StepCtx, session: GroupSession, def: ActivityDef): void {
  const performer = ctx.state.actors[session.hostId];
  if (performer === undefined) return;
  const liked: ThoughtKey = def.thoughts?.listened ?? "enjoyedMusic";
  const disliked: ThoughtKey = def.thoughts?.listenedDislike ?? "hatedTheNoise";
  for (const listener of audience(ctx, session, new Set([performer.id]))) {
    const score = interestScore(listener.interests, def.interest);
    if (score >= LIKES_FROM) {
      addThought(ctx, listener, liked);
      addMemory(ctx, listener.id, performer.id, "playedForMe");
    } else if (score === 0) {
      addThought(ctx, listener, disliked);
    }
  }
}

function resolveBond(ctx: StepCtx, def: ActivityDef, members: Actor[]): void {
  if (members.length < 2) return;
  const joined: ThoughtKey = def.thoughts?.joined ?? "goodCompany";
  for (const member of members) addThought(ctx, member, joined);
  const together = def.memories?.together;
  if (together === undefined) return;
  // D85 tuning: only someone who likes the activity warms to the company (a neutral who sat
  // through the vids does not), so affinity is directed: a liker toward each other member.
  for (const member of members) {
    if (interestScore(member.interests, def.interest) < LIKES_FROM) continue;
    for (const other of members) {
      if (other.id !== member.id) addMemory(ctx, member.id, other.id, together);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Skill, dirt, product, risk
// ---------------------------------------------------------------------------------------------

function applySkillGain(ctx: StepCtx, def: ActivityDef, members: Actor[]): void {
  const gain = def.skillGain;
  if (gain === undefined) return;
  const amount = gain.perDay * def.durationDays;
  for (const member of members) {
    const now = member.skills[gain.skill] ?? 0;
    if (now >= SKILL_CAP) continue;
    member.skills = { ...member.skills, [gain.skill]: Math.min(SKILL_CAP, now + amount) };
  }
}

/** The venue's tile on its deck: the machine's first `use` position, the zone's first tile, else the host's tile. */
function venueTile(
  ctx: StepCtx,
  session: GroupSession,
): { deckId: DeckDefId; tile: TileCoord } | undefined {
  const venue = session.venue;
  const compartment = ctx.state.compartments[venue.compartmentId];
  if (compartment === undefined) return undefined;
  const deckId = compartment.deckId;
  if ("machineId" in venue) {
    const tile = positionTiles(ctx.state, ctx.content, venue.machineId, "use")[0];
    if (tile !== undefined) return { deckId, tile };
  }
  if ("zoneKey" in venue) {
    const tile = ctx.content.decks[deckId]?.zones.find((z) => z.key === venue.zoneKey)?.tiles[0];
    if (tile !== undefined) return { deckId, tile: { x: tile.x, y: tile.y } };
  }
  const host = ctx.state.actors[session.hostId];
  if (host?.location.kind === "onDeck" && host.location.deckId === deckId) {
    return { deckId, tile: tileAt(host.location) };
  }
  return undefined;
}

function applyDirt(ctx: StepCtx, session: GroupSession, def: ActivityDef): void {
  if (def.dirt === undefined || def.dirt <= 0) return;
  const at = venueTile(ctx, session);
  if (at === undefined) return;
  depositDirt(ctx.state, ctx.content, ctx.config, at.deckId, at.tile, def.dirt);
}

function applyProduces(ctx: StepCtx, session: GroupSession, def: ActivityDef): void {
  const produces = def.produces;
  if (produces === undefined || produces.count <= 0) return;
  const cook = ctx.state.actors[session.hostId];
  const compartment = ctx.state.compartments[session.venue.compartmentId];
  if (cook === undefined || compartment === undefined) return;
  const deckId = compartment.deckId;
  const zone = ctx.content.decks[deckId]?.zones.find((z) => z.tags.includes(produces.zoneTag));
  const first = zone?.tiles[0];
  if (first === undefined) {
    throw new Error(
      `resolveOutcome: ${def.id} produces at "${produces.zoneTag}", absent on ${deckId}`,
    );
  }
  const itemDef = ctx.content.items[produces.itemDefId];
  if (itemDef === undefined) {
    throw new Error(`resolveOutcome: ${def.id} produces unknown item ${produces.itemDefId}`);
  }
  const at = venueTile(ctx, session);
  const quality = mealQuality(
    cook.skills.cooking ?? 0,
    at === undefined ? "clean" : roomTierAt(ctx.state, ctx.content, at.deckId, at.tile),
    ctx.config,
  );
  const meal = {
    quality,
    spoilsAtTick: ctx.tick + dayTicks(ctx.config, ctx.config.galley.mealSpoilDays),
    cookId: cook.id,
  };
  const location = { kind: "onDeck", deckId, x: first.x + 0.5, y: first.y + 0.5 } as const;
  const made: Item[] = [];
  const unitsEach = itemDef.stacking === "stackable" ? [produces.count] : [];
  if (itemDef.stacking !== "stackable") for (let i = 0; i < produces.count; i++) unitsEach.push(1);
  for (const count of unitsEach) {
    const id: ItemId = allocateId(ctx.state, "item");
    const item: Item =
      itemDef.stacking === "stackable"
        ? { id, defId: itemDef.id, stacking: "stack", count, reserved: 0, location, meal }
        : { id, defId: itemDef.id, stacking: "unique", condition: 1, location, meal };
    ctx.state.items[id] = item;
    made.push(item);
  }
  touchInventory(ctx);
  announce(ctx, cook, made);
  emitSim(ctx, "treatsBaked", [cook.id, ...made.map((item) => item.id)], {
    cookId: cook.id,
    count: produces.count,
  });
}

/** Tell every crew member aboard where the tray is (a report from the baker, as the mess call). */
function announce(ctx: StepCtx, cook: Actor, items: readonly Item[]): void {
  const source = {
    tick: ctx.tick,
    sourceId: cook.id,
    evidence: "report",
    certainty: "reported",
  } as const;
  for (const other of Object.values(ctx.state.actors)) {
    if (!other.crew || other.availability === "dead" || other.availability === "offShip") continue;
    // Their first look's familiarity brief covers it; a fact written first would stop that brief.
    if (other.id !== cook.id && awaitsFamiliarityBrief(other)) continue;
    for (const item of items) {
      writeFact(other, item.id, "itemLocation", { location: item.location }, source);
    }
  }
}

function applyRisk(ctx: StepCtx, def: ActivityDef, members: Actor[]): void {
  const chance = def.risk?.injuryChance;
  if (chance === undefined || chance <= 0) return;
  for (const member of members) {
    if (!ctx.rng.chance("social", chance)) continue;
    addThought(ctx, member, "sparringBruise");
    emitSim(ctx, "tookAKnock", [member.id], { actorId: member.id, activityId: def.id });
  }
}
