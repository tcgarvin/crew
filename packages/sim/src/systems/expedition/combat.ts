/**
 * Expeditions A1 (§8.1, plan call 9): the combatant loop. The combat system runs every tick but
 * each combatant decides only every `decideEverySeconds`, staggered by actor (their
 * `lastDecidedTick` is set apart when they join); lines of sight are walked only at decisions and
 * shots. A tick: bodies first (down, dead, back on their feet), then the shots whose aim is done,
 * then the decisions that are due, then arrivals (the cast at the exit, the party aboard, the
 * carried at the ramp).
 *
 * **Contact** (`expeditionContact`, `fightStartedTick`, the alert with `cause: "fight"`): a guard
 * or ally notices a party member on the site floor within `noticeRadius` they can see (half the
 * radius for someone whose resolve starts below `waverBelow`: the shaky are not watching; W2
 * decision, so `creep` can work against a shaky cast); the first shot; or (ruling 1) the party
 * ashore `contactAfterSeconds` under any posture but `creep`; or a creeper beside the objective
 * (they spring: the taking needs no guard within four tiles in sight of it, so one there makes it a
 * fight). D105 (`Expedition.notice`): `unseen` leaves only the party's own first shot (in
 * `walkingOut` too); `seen` makes contact the first tick any party member stands on the site
 * floor, even while the rest are still mustering.
 *
 * **A decision** moves resolve by the interval's terms (after contact; `morale.ts`; "leader near"
 * reads the leader now, `plans.ts` `leaderNow`, so the lead passes on when the leader is down), and
 * under `flank` a cast member who sees both groups once the small one is at the flank post takes
 * `morale.outflanked` once; then it picks what to do by side, part and state:
 * - `breaking`: the cast `retreat` to the exit, surrendering when cornered (no route, or a party
 *   member beside them) or unarmed; the party `retreat` aboard by the ramp.
 * - The party by posture (`plans.ts` `postureMode`): `press` (`fire` at what is in sight and in
 *   range, standing within five tiles, else while they `advance` on the objective); `hold`
 *   (`takeCover` at their cover spot by the ramp, `fire`, else `guardPassage`; a baton waits at
 *   the head of the ramp, out of the shooting, and `hold` presses once no cast member who shoots
 *   is left); `flank`'s small group `advance`s to the flank post first; `bait`'s leader walks in
 *   on the nearest guard and does not fire; `creep` keeps to tiles nobody would notice.
 *   Wavering, they do not advance.
 *   `rescue` comes first for whoever is nearest a down ally in sight (anywhere on the site once
 *   the objective is held) with no armed enemy in sight.
 *   After the objective is held, everyone falls back to the ramp foot.
 * - Guards: at their post until contact; then `fire` at the party in sight and range, a wavering
 *   one `takeCover` first; a devoted one closes in; with nobody in sight
 *   `guardSearchAfterSeconds` after contact a steady guard moves to a spot that sees the nearest
 *   party member (ruling 2); else `guardPassage` at the post. A baton needs adjacency (`melee`).
 * - The target (ruling 4): a target who wants out keeps low for `targetBoltsAfterSeconds` after
 *   contact, then `retreat`s to the exit, unless a party member is beside them; one who wants
 *   blood fights if armed. A bystander gets clear at the first shot.
 *
 * **Fire selection** (ruling 5): the party fires only at armed cast who can still fight (never a
 *   bystander, never the unarmed target, never someone running), and never at the target at all
 *   under a plan whose `targetMustLive` is set (A2: the errand wants them alive); the cast at any
 *   party member up. The nearest in sight and range is chosen. **A shot** lands `aimSeconds` after
 *   the aim began if the target is still in sight and range: `weapon.hit × (hitSkillBase +
 *   hitPerFighting × fighting) × rangeFalloff × cover × moving`, clamped to [0.05, 0.95], drawn
 *   keyed by shooter, target and tick on the `failures` stream; a hit goes through the damage entry
 *   point (stun under `fire: stun` with a weapon that can). `holdFire` holds the party's fire until
 *   contact.
 *
 * **Turns** (A2 call 15): a tick's fight records, in order, each fighter who broke or gave up and
 * each party member who went down or died (`Fight.turns`), for the turn card (`cards.ts`).
 *
 * **Arrivals**: a cast member at the exit leaves; it is `targetFled` only when the plan goes for the
 * target (`takeTarget`): going for an item, the target leaving is one more of the cast gone.
 *
 * Owner after the gate: W2 of expeditions A1.
 */
import { configTicks } from "../../core/clock";
import { isOnDock } from "../../core/docks";
import { addThought } from "../../core/thoughts";
import type { Actor, Combatant } from "../../core/types/actor";
import type { TileCoord } from "../../core/types/common";
import type { WeaponDef } from "../../core/types/content";
import type { ActorId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { BattlePlan, Expedition } from "../../core/types/state";
import type { DamageResult, Hit } from "../bodies/damage";
import { addMemory } from "../social/relationships";
import { isStaticWalkable } from "../spatial/geometry";
import { releaseReservations } from "../spatial/reservations";
import {
  FISTS,
  aimAt,
  carriedBy,
  destination,
  enterFight,
  goTo,
  halt,
  heldWeapon,
  inFight,
  lowerAim,
  pickUp,
  setDown,
  setLabel,
} from "./actions";
import { type Ground, aboard, distance, onSite, standable, tileOfActor } from "./ground";
import { adjacent8, inCover, lineOfSight } from "./los";
import { canAct, intervalDelta, shiftResolve, upright } from "./morale";
import { type PostureMode, flankGroups, leaderNow, postureMode } from "./plans";
import {
  type Watcher,
  cheapestPath,
  coverSpots,
  isWatched,
  searchPath,
  spotSeeing,
  standingBeside,
  watchedTiles,
} from "./routes";

/** The one damage entry point (`systems/bodies/damage.ts` `applyDamage`), injectable for tests. */
export type DamageFn = (ctx: StepCtx, actorId: ActorId, hit: Hit) => DamageResult;

export interface CombatDeps {
  readonly applyDamage: DamageFn;
}

/** How far a guard may go to find a line to the party (ruling 2), in steps. */
const REPOSITION_STEPS = 12;
/** How far a holder shifts to get cover from what they shoot at, in steps. */
const HOLD_SHIFT_STEPS = 2;
/** What a tile the cast can see adds to the flank's route, in steps. */
const SEEN_STEP = 12;
/** How far off their post a guard steps to cover the way in, in steps. */
const GUARD_STEPS = 3;
/**
 * A presser stops to shoot within this many tiles of their mark: far enough out that an assault
 * trades fire with the guard rather than walking past him to the target.
 */
const STAND_AND_SHOOT_TILES = 5;
/** "At the ramp": this close to its foot. */
export const AT_RAMP_TILES = 2;
/** A cast member this close to the exit is gone. */
const AT_EXIT_TILES = 1;

/** A2 call 15: how the fight turned for someone, as the turn card says it. */
export type TurnHow = "breaking" | "down" | "dead";

/** A2 call 15: a fighter who broke or gave up, or a party member who went down or died. */
export interface FightTurn {
  readonly actorId: ActorId;
  /** Their name then (a cast member who reaches the exit is gone from `state.actors`). */
  readonly name: string;
  readonly side: "us" | "them";
  readonly how: TurnHow;
}

/** One tick's fight: the ground, the expedition and everyone in it. */
export interface Fight {
  readonly ctx: StepCtx;
  readonly deps: CombatDeps;
  readonly ground: Ground;
  readonly expedition: Expedition;
  readonly plan: BattlePlan | undefined;
  /** Everyone with a combatant, by id. */
  readonly people: readonly Actor[];
  /** This tick's turns so far, in order; appended to by the combat loop (`turned`). */
  readonly turns: FightTurn[];
}

/** What a tick of the fight reports to the expedition system. */
export interface CombatTick {
  /** The target got away by the exit this tick (their name, for the log). */
  readonly targetFled?: string;
}

export function fightOf(ctx: StepCtx, deps: CombatDeps, ground: Ground): Fight | undefined {
  const expedition = ctx.state.expedition;
  if (expedition === undefined) return undefined;
  const people = Object.values(ctx.state.actors)
    .filter((a) => a.combatant !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  return { ctx, deps, ground, expedition, plan: expedition.plan, people, turns: [] };
}

const combatantOf = (actor: Actor): Combatant => {
  const combatant = actor.combatant;
  if (combatant === undefined) throw new Error(`${actor.id} is not in the fight`);
  return combatant;
};

const isParty = (actor: Actor) => actor.combatant?.side === "us";

/** A2 call 15: note that the fight turned for `actor` this tick. */
function turned(fight: Fight, actor: Actor, how: TurnHow): void {
  fight.turns.push({ actorId: actor.id, name: actor.name, side: combatantOf(actor).side, how });
}

/** Is a tile free of `self`'s side: nobody else on it, or walking to it? */
type Free = (tile: TileCoord) => boolean;

/**
 * The tiles another living combatant on `self`'s side stands on or is walking to. A walk claims
 * its end at the decision that starts it, so a later decision the same tick sees the claim; tile
 * choices prefer a free tile so a side does not stack on one (a phone shows one figure).
 */
function freeOf(fight: Fight, self: Actor): Free {
  const side = combatantOf(self).side;
  const claimed = new Set<string>();
  for (const other of fight.people) {
    const c = other.combatant;
    if (other.id === self.id || c === undefined || c.side !== side || c.state === "dead") continue;
    if (other.location.kind !== "onDeck") continue;
    const at = tileOfActor(fight.ctx.state, other);
    if (at !== undefined) claimed.add(`${at.x},${at.y}`);
    const to = destination(other);
    if (to !== undefined) claimed.add(`${to.x},${to.y}`);
  }
  return (tile) => !claimed.has(`${tile.x},${tile.y}`);
}

/** `tiles` with the free ones first, order otherwise kept (the claimed are a last resort). */
function freeFirst(tiles: readonly TileCoord[], free: Free): TileCoord[] {
  return [...tiles.filter(free), ...tiles.filter((t) => !free(t))];
}

/** Armed cast: a guard or ally with a weapon in hand, or a target who carries one. */
function armed(fight: Fight, actor: Actor): boolean {
  return heldWeapon(fight.ctx, actor) !== undefined;
}

/** What `actor` fights with: their weapon, or fists for the party. */
function weaponOf(fight: Fight, actor: Actor): WeaponDef | undefined {
  return heldWeapon(fight.ctx, actor) ?? (isParty(actor) ? FISTS : undefined);
}

function seconds(fight: Fight, ticks: number): number {
  return ticks / fight.ctx.config.time.tickRate;
}

// ---------------------------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------------------------

/** One tick of the fight (phases `walkingOut`, `approach` and `fight`). */
export function runCombat(fight: Fight): CombatTick {
  for (const person of fight.people) syncBody(fight, person);
  for (const person of fight.people) resolveShot(fight, person);
  const every = configTicks(fight.ctx.config, fight.ctx.config.expedition.decideEverySeconds);
  for (const person of fight.people) {
    const combatant = person.combatant;
    if (combatant === undefined || fight.ctx.state.actors[person.id] === undefined) continue;
    if (fight.ctx.tick - combatant.lastDecidedTick < every) continue;
    if (isParty(person) && !inFight(person)) continue;
    decide(fight, person);
  }
  return arrivals(fight);
}

/** Bodies first: the down and the dead are out; someone back on their feet is back in, shaken. */
function syncBody(fight: Fight, person: Actor): void {
  const combatant = combatantOf(person);
  if (person.availability === "dead" && combatant.state !== "dead") {
    combatant.state = "dead";
    lowerAim(person);
    if (isParty(person)) turned(fight, person, "dead");
  } else if (person.availability === "incapacitated" && combatant.state !== "down") {
    if (combatant.state === "dead") return;
    combatant.state = "down";
    lowerAim(person);
    if (isParty(person)) turned(fight, person, "down");
  } else if (person.availability === "available" && combatant.state === "down") {
    combatant.state = "wavering";
    if (person.location.kind === "carriedBy") return;
    enterFight(fight.ctx, person, "wavering");
  }
}

// ---------------------------------------------------------------------------------------------
// Sight
// ---------------------------------------------------------------------------------------------

interface Seen {
  readonly actor: Actor;
  readonly tile: TileCoord;
  readonly distance: number;
}

/** Someone on the site floor in the fight on their feet (not carried, not aboard). */
function standingInFight(fight: Fight, actor: Actor): boolean {
  const combatant = actor.combatant;
  return combatant !== undefined && upright(combatant) && onSite(fight.ctx, actor);
}

/** Who `self` can see of `side`, nearest first. */
function seenOf(fight: Fight, self: Actor, from: TileCoord, side: "us" | "them"): Seen[] {
  const out: Seen[] = [];
  for (const other of fight.people) {
    if (other.id === self.id || other.combatant?.side !== side) continue;
    if (!standingInFight(fight, other)) continue;
    const tile = tileOfActor(fight.ctx.state, other);
    if (tile === undefined || !lineOfSight(fight.ground.berth, from, tile)) continue;
    out.push({ actor: other, tile, distance: distance(from, tile) });
  }
  return out.sort((a, b) => a.distance - b.distance || a.actor.id.localeCompare(b.actor.id));
}

/** Can `self` shoot `seen` with `weapon` from where they stand? */
function inReach(weapon: WeaponDef, from: TileCoord, seen: Seen): boolean {
  if (weapon.range <= 1) return adjacent8(from, seen.tile);
  return seen.distance <= weapon.range;
}

/** Ruling 5: may the party fire at this cast member? Armed, able to fight, not running. */
function fairGame(fight: Fight, other: Actor): boolean {
  const combatant = other.combatant;
  if (combatant === undefined || !canAct(combatant)) return false;
  if (combatant.disposition.part === "bystander") return false;
  return armed(fight, other);
}

/** A2: the errand wants the target alive, so the party never fires at them (`targetMustLive`). */
function spared(fight: Fight, other: Actor): boolean {
  return fight.plan?.targetMustLive === true && other.combatant?.disposition.part === "target";
}

/** Whom `self` would shoot now: the nearest fair target in sight and reach. */
function markFor(fight: Fight, self: Actor, from: TileCoord, seen: readonly Seen[]) {
  const weapon = weaponOf(fight, self);
  if (weapon === undefined) return undefined;
  for (const s of seen) {
    if (isParty(self) && (!fairGame(fight, s.actor) || spared(fight, s.actor))) continue;
    if (!isParty(self) && !canAct(combatantOf(s.actor))) continue;
    if (inReach(weapon, from, s)) return s;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------------------------

/** Hit chance for `shooter` at `target` (§8.1). */
export function hitChance(
  fight: Fight,
  shooter: Actor,
  weapon: WeaponDef,
  from: TileCoord,
  target: Actor,
  at: TileCoord,
): number {
  const e = fight.ctx.config.expedition;
  const skill = e.hitSkillBase + e.hitPerFighting * (shooter.skills.fighting ?? 0);
  const reach = Math.max(1, weapon.range);
  const falloff = 1 - (1 - e.rangeFalloffFloor) * Math.min(1, distance(from, at) / reach);
  const cover = inCover(fight.ground.berth, at, from) ? e.coverPenalty : 1;
  const moving = target.movement.kind === "moving" ? e.movingTargetFactor : 1;
  const shooting = shooter.movement.kind === "moving" ? e.movingShooterFactor : 1;
  const p = weapon.hit * skill * falloff * cover * moving * shooting;
  return Math.min(0.95, Math.max(0.05, p));
}

/** A shot whose aim is done lands now, if its target is still there to be shot. */
function resolveShot(fight: Fight, shooter: Actor): void {
  const { ctx } = fight;
  const aim = shooter.combatant?.aim;
  const weapon = weaponOf(fight, shooter);
  if (aim === undefined || weapon === undefined) return;
  if (ctx.tick - aim.sinceTick < configTicks(ctx.config, weapon.aimSeconds)) return;
  lowerAim(shooter);
  const target = ctx.state.actors[aim.targetId];
  const from = tileOfActor(ctx.state, shooter);
  if (target === undefined || from === undefined || !canAct(combatantOf(shooter))) return;
  if (!standingInFight(fight, target) || !onSite(ctx, shooter)) return;
  const at = tileOfActor(ctx.state, target);
  if (at === undefined || !lineOfSight(fight.ground.berth, from, at)) return;
  if (!inReach(weapon, from, { actor: target, tile: at, distance: distance(from, at) })) return;
  const chance = hitChance(fight, shooter, weapon, from, target, at);
  const roll = ctx.rng.keyedFloat("failures", `shot:${shooter.id}:${target.id}`, ctx.tick);
  const hit = roll < chance;
  fight.expedition.shots += 1;
  ctx.emit({
    type: "shotFired",
    subjectIds: [shooter.id, target.id],
    causeIds: [],
    source: "sim",
    payload: { byActorId: shooter.id, atActorId: target.id, hit },
  });
  if (shotMakesContact(fight.expedition)) startFight(fight);
  if (hit) onHit(fight, shooter, weapon, target);
}

/**
 * The first shot is contact in the approach. Got in unseen (D105) it is the only way to contact,
 * so one fired before the leader is ashore (`walkingOut`) is contact too.
 */
function shotMakesContact(expedition: Expedition): boolean {
  if (expedition.phase === "approach") return true;
  return expedition.phase === "walkingOut" && expedition.notice === "unseen";
}

function onHit(fight: Fight, shooter: Actor, weapon: WeaponDef, target: Actor): void {
  const { ctx } = fight;
  const morale = ctx.config.expedition.morale;
  const stun = isParty(shooter) && fight.plan?.fire === "stun" && weapon.stun;
  const result = fight.deps.applyDamage(ctx, target.id, {
    severity: weapon.severity,
    type: stun ? "stun" : weapon.damageType,
    byActorId: shooter.id,
  });
  const victim = combatantOf(target);
  shaken(fight, target, morale.hitSelf);
  const side = victim.side;
  const allies = fight.people.filter(
    (p) => p.id !== target.id && p.combatant?.side === side && upright(combatantOf(p)),
  );
  if (result.died) {
    victim.state = "dead";
    if (side === "us") turned(fight, target, "dead");
    for (const ally of allies) {
      shaken(fight, ally, morale.allyDead);
    }
    if (shooter.crew && ctx.content.thoughts.killedSomeone !== undefined) {
      addThought(ctx, shooter, "killedSomeone", target.id);
    }
  } else if (result.incapacitated) {
    victim.state = "down";
    if (side === "us") turned(fight, target, "down");
    for (const ally of allies) {
      shaken(fight, ally, morale.allyDown);
    }
  }
  if (result.died || result.incapacitated) lowerAim(target);
  for (const friend of fight.people) {
    if (friend.combatant?.side !== shooter.combatant?.side || !upright(combatantOf(friend))) {
      continue;
    }
    shaken(fight, friend, morale.allyHit);
  }
  if (side === "us") sawCrewHurt(fight, target);
}

/** Party members who see a crew member hit take it with them (`sawCrewHurt`). */
function sawCrewHurt(fight: Fight, hurt: Actor): void {
  const { ctx } = fight;
  if (ctx.content.thoughts.sawCrewHurt === undefined) return;
  const at = tileOfActor(ctx.state, hurt);
  if (at === undefined) return;
  for (const friend of fight.people) {
    if (friend.id === hurt.id || !isParty(friend) || !standingInFight(fight, friend)) continue;
    const from = tileOfActor(ctx.state, friend);
    if (from !== undefined && lineOfSight(fight.ground.berth, from, at)) {
      addThought(ctx, friend, "sawCrewHurt", hurt.id);
    }
  }
}

/**
 * Does `actor` have a morale ladder? The party, guards and allies do; the target and bystanders
 * are not fighting and neither waver nor break (W2 decision): the target slips away or is taken,
 * a bystander gets clear.
 */
export function fights(actor: Actor): boolean {
  const c = actor.combatant;
  return (
    c !== undefined &&
    (c.side === "us" || c.disposition.part === "guard" || c.disposition.part === "ally")
  );
}

/** Move `actor`'s resolve by `delta` if they fight, saying so if they break. */
export function shaken(fight: Fight, actor: Actor, delta: number): void {
  if (!fights(actor)) return;
  const morale = fight.ctx.config.expedition.morale;
  breakIf(fight, actor, shiftResolve(combatantOf(actor), delta, morale));
}

/** Someone just broke: say so (the party's ordered withdrawal says so itself). */
function breakIf(fight: Fight, actor: Actor, broke: boolean): void {
  if (!broke) return;
  lowerAim(actor);
  turned(fight, actor, "breaking");
  fight.ctx.emit({
    type: "combatantBroke",
    subjectIds: [actor.id],
    causeIds: [],
    source: "sim",
    payload: { actorId: actor.id, side: combatantOf(actor).side, how: "fled" },
  });
}

// ---------------------------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------------------------

/** The fight is on: contact, the alert, and everyone in the cast into the fight. */
export function startFight(fight: Fight): void {
  const { ctx, expedition } = fight;
  if (expedition.phase === "fight" || expedition.phase === "resolved") return;
  expedition.phase = "fight";
  expedition.fightStartedTick = ctx.tick;
  const everyone = fight.people.map((p) => p.id);
  ctx.emit({
    type: "expeditionContact",
    subjectIds: everyone,
    causeIds: [],
    source: "sim",
    locationRef: { kind: "port", portId: expedition.siteId },
    payload: { siteId: expedition.siteId },
  });
  raiseFightAlert(fight);
  for (const person of fight.people) {
    if (!isParty(person) && person.availability === "available") enterFight(ctx, person, "alert");
  }
}

function raiseFightAlert(fight: Fight): void {
  const { ctx, expedition } = fight;
  const alert = ctx.state.alert;
  if (alert !== undefined) {
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete alert.clearsAtTick;
    return;
  }
  ctx.state.alert = { sinceTick: ctx.tick, cause: "fight", reports: {} };
  ctx.emit({
    type: "alertRaised",
    subjectIds: [],
    causeIds: [],
    source: "sim",
    payload: { cause: "fight", siteId: expedition.siteId },
  });
}

/** Who watches for the party: guards and allies on their feet, the shaky at half the radius. */
export function watchers(fight: Fight): Watcher[] {
  const radius = fight.ground.berth.dock.noticeRadius ?? 0;
  const morale = fight.ctx.config.expedition.morale;
  const out: Watcher[] = [];
  for (const person of fight.people) {
    const combatant = combatantOf(person);
    const part = combatant.disposition.part;
    if (combatant.side !== "them" || (part !== "guard" && part !== "ally")) continue;
    if (!upright(combatant)) continue;
    const tile = tileOfActor(fight.ctx.state, person);
    if (tile === undefined) continue;
    const shaky = combatant.disposition.resolveBase < morale.waverBelow;
    out.push({ tile, radius: shaky ? radius / 2 : radius });
  }
  return out;
}

/** Does any watcher notice a party member on the site floor? */
function noticed(fight: Fight): boolean {
  const list = watchers(fight);
  for (const person of fight.people) {
    if (!isParty(person) || !standingInFight(fight, person)) continue;
    const tile = tileOfActor(fight.ctx.state, person);
    if (tile === undefined) continue;
    const seen = list.some(
      (w) => distance(w.tile, tile) <= w.radius && lineOfSight(fight.ground.berth, w.tile, tile),
    );
    if (seen) return true;
  }
  return false;
}

/**
 * Contact by noticing, by (ruling 1) the party standing ashore long enough, or by a creeper
 * springing: beside the objective unnoticed, they show themselves (a guard still within reach of
 * it means the taking is a fight at arm's length).
 *
 * D105 overrides all three by the expedition's notice: `seen`, the cast were waiting and contact
 * comes the first tick any party member stands on the site floor, though the rest may still be
 * mustering (the expedition system checks it then too: the fight runs from contact, and
 * `walkingOut` and the approach never come); `unseen`, nobody notices, nobody hears the landing
 * and a creeper beside the objective stays hidden, so only the party's own first shot
 * (`resolveShot`) makes contact.
 */
export function checkContact(fight: Fight): void {
  const { ctx, expedition } = fight;
  if (expedition.notice === "seen") {
    if (expedition.plan !== undefined && partyOnFloor(fight)) startFight(fight);
    return;
  }
  if (expedition.phase !== "approach" || expedition.notice === "unseen") return;
  const since = expedition.approachTick;
  const creeping = fight.plan?.posture === "creep";
  const loud =
    !creeping &&
    since !== undefined &&
    ctx.tick - since >= configTicks(ctx.config, ctx.config.expedition.contactAfterSeconds);
  if (loud || noticed(fight) || (creeping && sprung(fight))) startFight(fight);
}

/** D105 `seen`: is a party member on the site floor, in the fight or still on the muster? */
function partyOnFloor(fight: Fight): boolean {
  return fight.expedition.party.some((id) => {
    const actor = fight.ctx.state.actors[id];
    return actor !== undefined && onSite(fight.ctx, actor);
  });
}

/** Is a party member standing beside the objective? */
function sprung(fight: Fight): boolean {
  return fight.people.some((p) => {
    if (!isParty(p) || !standingInFight(fight, p)) return false;
    const at = tileOfActor(fight.ctx.state, p);
    const goal = at === undefined ? undefined : objectiveTile(fight, at);
    return at !== undefined && goal !== undefined && adjacent8(at, goal);
  });
}

// ---------------------------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------------------------

function decide(fight: Fight, person: Actor): void {
  const { ctx } = fight;
  const combatant = combatantOf(person);
  const interval = seconds(fight, ctx.tick - combatant.lastDecidedTick);
  combatant.lastDecidedTick = ctx.tick;
  if (combatant.state === "surrendered") {
    surrenderedTurn(fight, person);
    return;
  }
  if (!upright(combatant) || person.location.kind !== "onDeck") return;
  const from = tileOfActor(ctx.state, person);
  if (from === undefined) return;
  const enemies = seenOf(fight, person, from, combatant.side === "us" ? "them" : "us");
  if (fight.expedition.phase === "fight" && canAct(combatant) && fights(person)) {
    moraleTurn(fight, person, from, enemies, interval);
    if (!isParty(person)) outflank(fight, person, enemies);
  }
  if (combatant.state === "breaking") {
    retreat(fight, person, from);
    return;
  }
  if (isParty(person)) partyTurn(fight, person, from, enemies);
  else castTurn(fight, person, from, enemies);
  unstack(fight, person, from, enemies);
}

/**
 * Someone standing still on a tile an earlier ally of their side also stands still on (the party
 * arrives at the ramp foot together; a fight halts them where they stand) steps to a free tile
 * beside it, one with a line to the nearest enemy in sight if they can. The earliest by id stays.
 */
function unstack(fight: Fight, person: Actor, from: TileCoord, enemies: readonly Seen[]): void {
  if (person.movement.kind === "moving" || !upright(combatantOf(person))) return;
  if (!standable(fight.ground, from)) return;
  const side = combatantOf(person).side;
  const shared = fight.people.some((other) => {
    const c = other.combatant;
    if (other.id === person.id || c === undefined || c.side !== side) return false;
    if (c.state === "dead" || other.movement.kind === "moving") return false;
    const at = other.location.kind === "onDeck" ? tileOfActor(fight.ctx.state, other) : undefined;
    const earlier = other.id.localeCompare(person.id, "en", { numeric: true }) < 0;
    return earlier && at !== undefined && at.x === from.x && at.y === from.y;
  });
  if (!shared) return;
  const free = freeOf(fight, person);
  const enemy = enemies[0];
  const range = weaponOf(fight, person)?.range ?? 1;
  const seeing =
    enemy === undefined ? undefined : spotSeeing(fight.ground, from, enemy.tile, range, 1, free);
  const beside = standingBeside(fight.ground, from, from).filter(free);
  const to = seeing !== undefined && free(seeing) ? seeing : beside[0];
  if (to !== undefined) goTo(fight.ctx, person, to);
}

function moraleTurn(
  fight: Fight,
  person: Actor,
  from: TileCoord,
  enemies: readonly Seen[],
  interval: number,
): void {
  const { ctx } = fight;
  const combatant = combatantOf(person);
  const e = ctx.config.expedition;
  const armedEnemies = enemies.filter((s) => canAct(combatantOf(s.actor)) && armed(fight, s.actor));
  const friends = seenOf(fight, person, from, combatant.side).filter(
    (s) => canAct(combatantOf(s.actor)) && (isParty(s.actor) || armed(fight, s.actor)),
  );
  const selfArmed = isParty(person) || armed(fight, person) ? 1 : 0;
  const nearest = armedEnemies[0];
  const leader = ctx.state.actors[leaderNow(ctx.state, fight.expedition)];
  const leaderTile = leader === undefined ? undefined : tileOfActor(ctx.state, leader);
  const leaderNear =
    isParty(person) &&
    leader !== undefined &&
    leader.id !== person.id &&
    leader.combatant !== undefined &&
    canAct(leader.combatant) &&
    leaderTile !== undefined &&
    distance(from, leaderTile) <= e.leaderNearTiles;
  const underFire = fight.people.some(
    (p) => p.combatant?.aim?.targetId === person.id && p.combatant.side !== combatant.side,
  );
  const delta = intervalDelta(
    {
      underFire,
      inCover: nearest !== undefined && inCover(fight.ground.berth, from, nearest.tile),
      outnumbered: armedEnemies.length > friends.length + selfArmed,
      leaderNear,
    },
    interval,
    e.morale,
  );
  breakIf(fight, person, shiftResolve(combatant, delta, e.morale));
}

/**
 * §8.3 `flank`: once the small group has reached the flank post, a cast member who sees a member
 * of each group takes `morale.outflanked`, once a fight.
 */
function outflank(fight: Fight, person: Actor, enemies: readonly Seen[]): void {
  const { expedition } = fight;
  const combatant = combatantOf(person);
  if (expedition.plan?.posture !== "flank" || expedition.flankTick === undefined) return;
  if (combatant.outflanked === true) return;
  const { small, large } = flankGroups(fight.ctx.state, expedition.party);
  const sees = (group: readonly ActorId[]) => enemies.some((s) => group.includes(s.actor.id));
  if (!sees(small) || !sees(large)) return;
  combatant.outflanked = true;
  shaken(fight, person, fight.ctx.config.expedition.morale.outflanked);
}

/** `retreat`: the cast to the exit (or give up), the party aboard. */
function retreat(fight: Fight, person: Actor, from: TileCoord): void {
  const { ctx, ground } = fight;
  lowerAim(person);
  if (isParty(person)) {
    goTo(ctx, person, ground.top);
    setLabel(person, "running");
    return;
  }
  const exit = ground.posts.exit;
  const cornered =
    ctx.config.expedition.surrenderIfCornered &&
    fight.people.some((p) => {
      if (!isParty(p) || !standingInFight(fight, p)) return false;
      const at = tileOfActor(ctx.state, p);
      return at !== undefined && adjacent8(at, from);
    });
  const unarmed = !armed(fight, person) && combatantOf(person).disposition.part === "guard";
  if (exit === undefined || cornered || unarmed || !goTo(ctx, person, exit)) {
    surrender(fight, person);
    return;
  }
  enterFight(ctx, person, "running");
}

/** Give up where they stand (`combatantBroke`, surrendered). */
export function surrender(fight: Fight, person: Actor): void {
  const combatant = combatantOf(person);
  if (combatant.state === "surrendered") return;
  combatant.state = "surrendered";
  lowerAim(person);
  halt(fight.ctx, person);
  if (inFight(person)) setLabel(person, "surrendered");
  // The target giving up is the objective taken, not the fight turning.
  if (fights(person)) turned(fight, person, "breaking");
  fight.ctx.emit({
    type: "combatantBroke",
    subjectIds: [person.id],
    causeIds: [],
    source: "sim",
    payload: { actorId: person.id, side: combatant.side, how: "surrendered" },
  });
}

/** A surrendered target, once taken, goes with the party to the ramp; anyone else stays put. */
function surrenderedTurn(fight: Fight, person: Actor): void {
  const part = combatantOf(person).disposition.part;
  if (part !== "target" || fight.expedition.objectiveTick === undefined) return;
  if (person.availability !== "available") return;
  goTo(fight.ctx, person, fight.ground.foot);
  setLabel(person, "taken");
}

// ---------------------------------------------------------------------------------------------
// The party
// ---------------------------------------------------------------------------------------------

/** Line up on `mark` (standing within a few tiles of it, or for a baton), labelled. */
function shootAt(fight: Fight, person: Actor, mark: Seen, standStill: boolean): void {
  if (standStill || mark.distance <= STAND_AND_SHOOT_TILES) halt(fight.ctx, person);
  aimAt(fight.ctx, person, mark.actor.id);
  const weapon = weaponOf(fight, person);
  setLabel(person, weapon !== undefined && weapon.range <= 1 ? "fighting" : "firing");
}

/** May the party shoot now? `holdFire` waits for contact. */
function partyMayFire(fight: Fight): boolean {
  if (fight.plan?.fire !== "holdFire") return true;
  return fight.expedition.phase === "fight";
}

/** Is party member `actor` going for the objective now (not holding back, not sneaking)? */
export function presses(fight: Fight, actor: Actor): boolean {
  if (!isParty(actor) || actor.combatant === undefined || !canAct(actor.combatant)) return false;
  if (fight.expedition.objectiveTick !== undefined) return false;
  return modeOf(fight, actor) === "press" || modeOf(fight, actor) === "creep";
}

function modeOf(fight: Fight, person: Actor): PostureMode {
  return postureMode({
    state: fight.ctx.state,
    expedition: fight.expedition,
    actorId: person.id,
    armedCastLeft: fight.people.some((p) => !isParty(p) && shootsBack(fight, p)),
  });
}

/**
 * Cast who keep `hold` holding: armed with something that reaches past arm's length. A baton
 * out of sight cannot pin the party at the ramp, so it does not freeze `hold`.
 */
function shootsBack(fight: Fight, other: Actor): boolean {
  return fairGame(fight, other) && (heldWeapon(fight.ctx, other)?.range ?? 0) > 1;
}

function partyTurn(fight: Fight, person: Actor, from: TileCoord, enemies: readonly Seen[]): void {
  const { ctx, ground, expedition } = fight;
  const carrying = carriedBy(ctx, person.id);
  if (carrying !== undefined) {
    lowerAim(person);
    goTo(ctx, person, ground.foot);
    setLabel(person, `dragging ${carrying.name}`);
    return;
  }
  const armedInSight = enemies.some((s) => fairGame(fight, s.actor));
  if (!armedInSight && rescue(fight, person, from)) return;
  const mode = modeOf(fight, person);
  const mark =
    partyMayFire(fight) && mode !== "bait" && mode !== "creep"
      ? markFor(fight, person, from, enemies)
      : undefined;
  const wavering = combatantOf(person).state === "wavering";
  if (expedition.objectiveTick !== undefined) {
    if (mark !== undefined) {
      shootAt(fight, person, mark, true);
      return;
    }
    lowerAim(person);
    goTo(ctx, person, ground.foot);
    setLabel(person, distance(from, ground.foot) <= AT_RAMP_TILES ? "at the ramp" : "falling back");
    return;
  }
  switch (mode) {
    case "hold":
      holdTurn(fight, person, from, mark);
      return;
    case "toFlank":
      if (mark !== undefined) shootAt(fight, person, mark, wavering);
      else lowerAim(person);
      if (!wavering) toFlank(fight, person, from, mark !== undefined);
      return;
    case "bait":
      baitTurn(fight, person, from);
      return;
    case "creep":
      creepTurn(fight, person, from);
      return;
    case "press":
      pressTurn(fight, person, from, mark, wavering);
      return;
  }
}

/** Where the party is going: the target, the loot, or (to break them) the nearest armed guard. */
export function objectiveTile(fight: Fight, near: TileCoord): TileCoord | undefined {
  const objective = fight.plan?.objective ?? "takeTarget";
  const { ctx, ground } = fight;
  if (objective === "takeItem") return ground.posts.loot ?? ground.posts.target;
  if (objective === "breakThem") {
    const guards = fight.people
      .filter((p) => !isParty(p) && fairGame(fight, p) && standingInFight(fight, p))
      .map((p) => tileOfActor(ctx.state, p))
      .filter((t): t is TileCoord => t !== undefined)
      .sort((a, b) => distance(a, near) - distance(b, near));
    return guards[0] ?? ground.posts.target;
  }
  const target = fight.people.find((p) => combatantOf(p).disposition.part === "target");
  const at = target === undefined ? undefined : tileOfActor(ctx.state, target);
  return at ?? ground.posts.target;
}

function pressTurn(
  fight: Fight,
  person: Actor,
  from: TileCoord,
  mark: Seen | undefined,
  wavering: boolean,
): void {
  const { ctx, ground } = fight;
  if (mark !== undefined) shootAt(fight, person, mark, wavering);
  else lowerAim(person);
  if (wavering) {
    if (mark === undefined) {
      halt(ctx, person);
      setLabel(person, "wavering");
    }
    return;
  }
  if (mark !== undefined && mark.distance <= STAND_AND_SHOOT_TILES) return;
  const goal = objectiveTile(fight, from);
  if (goal === undefined) return;
  if (adjacent8(from, goal)) {
    halt(ctx, person);
    if (mark === undefined) setLabel(person, "taking them");
    return;
  }
  // Far off, the nearest side of the objective; a free tile is picked once close, so the party
  // does not split round it on the way in.
  const beside = standingBeside(ground, goal, from);
  const close = distance(from, goal) <= STAND_AND_SHOOT_TILES + 1;
  const ordered = close ? freeFirst(beside, freeOf(fight, person)) : beside;
  const to = ordered.find((t) => goTo(ctx, person, t));
  if (mark === undefined) setLabel(person, to === undefined ? "pinned" : "advancing");
}

/**
 * `hold`: the spot this holder takes, by their place among the holders who can shoot (a baton
 * waits at the head of the ramp: `holdTurn`).
 */
function holdSpot(fight: Fight, person: Actor): TileCoord {
  const { ground } = fight;
  const threat = ground.posts.target ?? ground.foot;
  const spots = coverSpots(ground, threat, 4);
  const holders = fight.expedition.party.filter((id) => {
    const p = fight.ctx.state.actors[id];
    return (
      p !== undefined &&
      p.combatant !== undefined &&
      canAct(p.combatant) &&
      inFight(p) &&
      shoots(fight, p)
    );
  });
  const index = holders.indexOf(person.id);
  const free = freeOf(fight, person);
  const mine = spots[index];
  if (mine !== undefined && free(mine)) return mine;
  return spots.find(free) ?? mine ?? ground.foot;
}

function holdTurn(fight: Fight, person: Actor, from: TileCoord, mark: Seen | undefined): void {
  const { ctx, ground } = fight;
  if (mark !== undefined) {
    // `takeCover`: a step or two to a spot in cover from what they shoot at, then `fire`.
    const range = weaponOf(fight, person)?.range ?? 1;
    if (!inCover(ground.berth, from, mark.tile)) {
      const free = freeOf(fight, person);
      const spot = spotSeeing(ground, from, mark.tile, range, HOLD_SHIFT_STEPS, free);
      if (spot !== undefined && inCover(ground.berth, spot, mark.tile) && goTo(ctx, person, spot)) {
        lowerAim(person);
        setLabel(person, "taking cover");
        return;
      }
    }
    halt(ctx, person);
    aimAt(ctx, person, mark.actor.id);
    setLabel(person, "firing");
    return;
  }
  lowerAim(person);
  if (!shoots(fight, person)) {
    // Nothing to hold the line with: a baton waits at the head of the ramp, out of the shooting,
    // until `hold` presses.
    const spot = rampHead(fight, person);
    const there = from.x === spot.x && from.y === spot.y;
    if (!there) goTo(ctx, person, spot);
    setLabel(person, there ? "holding the ramp" : "back to the ramp");
    return;
  }
  const spot = holdSpot(fight, person);
  const there = from.x === spot.x && from.y === spot.y;
  if (!there) goTo(ctx, person, spot);
  setLabel(person, there ? "in cover" : "taking cover");
}

/** Where a baton waits under `hold`: the ramp's top, or a free deck tile beside it. */
function rampHead(fight: Fight, person: Actor): TileCoord {
  const { ground } = fight;
  const free = freeOf(fight, person);
  if (free(ground.top)) return ground.top;
  const { x, y } = ground.top;
  const beside = [-1, 0, 1].flatMap((dy) => [-1, 0, 1].map((dx) => ({ x: x + dx, y: y + dy })));
  const aboardTile = (t: TileCoord) =>
    !standable(ground, t) && isStaticWalkable(ground.geometry, t.x, t.y);
  return beside.find((t) => aboardTile(t) && free(t)) ?? ground.top;
}

/** Can `person` hit anyone past arm's length? */
function shoots(fight: Fight, person: Actor): boolean {
  return (weaponOf(fight, person)?.range ?? 0) > 1;
}

function toFlank(fight: Fight, person: Actor, from: TileCoord, firing: boolean): void {
  const { ctx, ground, expedition } = fight;
  const post = ground.posts.flank;
  if (post === undefined || adjacent8(from, post)) {
    expedition.flankTick ??= ctx.tick;
    return;
  }
  // Round, not through: the route the cast sees least of (a seen tile costs as much as a
  // dozen steps), so the small group comes in by the flank's own door rather than the front one.
  const watched = watchedTiles(ground, watchers(fight));
  const reach = (t: TileCoord) => adjacent8(t, post);
  const path = cheapestPath(ground, from, reach, (t) => (isWatched(watched, t) ? SEEN_STEP : 0));
  const next = path === undefined ? post : (quietWaypoint(from, path) ?? post);
  goTo(ctx, person, next);
  if (!firing) setLabel(person, "going round");
}

function baitTurn(fight: Fight, person: Actor, from: TileCoord): void {
  const { ctx, ground } = fight;
  lowerAim(person);
  const guard = fight.people
    .filter((p) => !isParty(p) && combatantOf(p).disposition.part === "guard")
    .map((p) => tileOfActor(ctx.state, p))
    .filter((t): t is TileCoord => t !== undefined)
    .sort((a, b) => distance(a, from) - distance(b, from))[0];
  if (guard === undefined || adjacent8(from, guard)) {
    halt(ctx, person);
  } else {
    standingBeside(ground, guard, from).find((t) => goTo(ctx, person, t));
  }
  setLabel(person, "talking");
}

function creepTurn(fight: Fight, person: Actor, from: TileCoord): void {
  const { ctx, ground } = fight;
  lowerAim(person);
  const goal = objectiveTile(fight, from);
  if (goal === undefined) return;
  if (adjacent8(from, goal)) {
    halt(ctx, person);
    setLabel(person, "taking them");
    return;
  }
  const watched = watchedTiles(ground, watchers(fight));
  const reach = (t: TileCoord) => adjacent8(t, goal);
  const path =
    searchPath(ground, from, reach, { avoid: (t) => isWatched(watched, t) }) ??
    searchPath(ground, from, reach);
  const next = path === undefined ? undefined : quietWaypoint(from, path);
  if (next !== undefined) goTo(ctx, person, next);
  setLabel(person, "creeping in");
}

/**
 * A waypoint up to three tiles along the quiet route, but only as far as it runs straight: the
 * walker's own route to a waypoint round a bend may cut the corner across a watched tile.
 */
function quietWaypoint(from: TileCoord, path: readonly TileCoord[]): TileCoord | undefined {
  const first = path[0];
  if (first === undefined) return undefined;
  const dx = first.x - from.x;
  const dy = first.y - from.y;
  let at = first;
  for (const tile of path.slice(1, 3)) {
    if (tile.x - at.x !== dx || tile.y - at.y !== dy) break;
    at = tile;
  }
  return at;
}

/**
 * `rescue`: the nearest able party member goes for a down ally in sight and drags them out. Once
 * the objective is held, sight is not needed: the party is falling back and knows who it left,
 * and the fight cannot end with a crewmate down out of sight behind a wall (§rescue).
 */
function rescue(fight: Fight, person: Actor, from: TileCoord): boolean {
  const { ctx, ground } = fight;
  const fallingBack = fight.expedition.objectiveTick !== undefined;
  for (const fallen of fight.people) {
    const combatant = fallen.combatant;
    if (!isParty(fallen) || combatant?.state !== "down") continue;
    if (fallen.location.kind !== "onDeck" || !isOnDock(ctx.content, ctx.state, fallen.location)) {
      continue;
    }
    const at = tileOfActor(ctx.state, fallen);
    if (at === undefined || distance(at, ground.foot) <= AT_RAMP_TILES) continue;
    if (!fallingBack && !lineOfSight(ground.berth, from, at)) continue;
    if (nearestRescuer(fight, at) !== person.id) continue;
    lowerAim(person);
    if (adjacent8(from, at)) {
      pickUp(ctx, person, fallen);
      goTo(ctx, person, ground.foot);
      setLabel(person, `dragging ${fallen.name}`);
    } else {
      goTo(ctx, person, at);
      setLabel(person, `going for ${fallen.name}`);
    }
    return true;
  }
  return false;
}

/** The able party member nearest `at` who is not carrying anyone. */
function nearestRescuer(fight: Fight, at: TileCoord): ActorId | undefined {
  let best: { id: ActorId; d: number } | undefined;
  for (const p of fight.people) {
    if (!isParty(p) || !canAct(combatantOf(p)) || !inFight(p) || !onSite(fight.ctx, p)) continue;
    if (carriedBy(fight.ctx, p.id) !== undefined) continue;
    const tile = tileOfActor(fight.ctx.state, p);
    if (tile === undefined) continue;
    const d = distance(tile, at);
    if (best === undefined || d < best.d) best = { id: p.id, d };
  }
  return best?.id;
}

// ---------------------------------------------------------------------------------------------
// The cast
// ---------------------------------------------------------------------------------------------

function castTurn(fight: Fight, person: Actor, from: TileCoord, enemies: readonly Seen[]): void {
  const combatant = combatantOf(person);
  switch (combatant.disposition.part) {
    case "guard":
    case "ally":
      guardTurn(fight, person, from, enemies);
      return;
    case "target":
      targetTurn(fight, person, from, enemies);
      return;
    case "bystander":
      bystanderTurn(fight, person);
      return;
  }
}

/** The post `person` was put at (their spawn post, by name match), else where they stand. */
function postOf(fight: Fight, person: Actor, from: TileCoord): TileCoord {
  const { ground } = fight;
  const facing = person.combatant?.disposition.part;
  // A1's cast keeps no post id; the nearest post of their part's kind is theirs.
  const kind = facing === "bystander" ? "bystander" : facing === "target" ? "target" : "guard";
  let best: TileCoord | undefined;
  for (const post of ground.berth.dock.posts) {
    if (post.kind !== kind) continue;
    const tile = { x: post.tile.x - ground.berth.shipAt.x, y: post.tile.y - ground.berth.shipAt.y };
    if (best === undefined || distance(tile, from) < distance(best, from)) best = tile;
  }
  return best ?? from;
}

function guardTurn(fight: Fight, person: Actor, from: TileCoord, enemies: readonly Seen[]): void {
  const { ctx, ground, expedition } = fight;
  const combatant = combatantOf(person);
  if (expedition.phase !== "fight") {
    setLabel(person, "on watch");
    return;
  }
  const weapon = weaponOf(fight, person);
  const mark = markFor(fight, person, from, enemies);
  const devoted = combatant.disposition.loyalty >= 1 && combatant.state === "steady";
  if (weapon === undefined) {
    halt(ctx, person);
    setLabel(person, "keeping back");
    return;
  }
  if (mark !== undefined) {
    if (combatant.state === "wavering" && !inCover(ground.berth, from, mark.tile)) {
      const spot = spotSeeing(ground, from, mark.tile, weapon.range, 3, freeOf(fight, person));
      if (spot !== undefined && inCover(ground.berth, spot, mark.tile)) {
        goTo(ctx, person, spot);
        lowerAim(person);
        setLabel(person, "taking cover");
        return;
      }
    }
    shootAt(fight, person, mark, !devoted);
    if (devoted && mark.distance > STAND_AND_SHOOT_TILES) {
      const beside = freeFirst(standingBeside(ground, mark.tile, from), freeOf(fight, person));
      beside.find((t) => goTo(ctx, person, t));
    }
    return;
  }
  lowerAim(person);
  const nearest = enemies.find((s) => upright(combatantOf(s.actor)));
  if (weapon.range <= 1 && nearest !== undefined && (devoted || nearest.distance <= 4)) {
    const beside = freeFirst(standingBeside(ground, nearest.tile, from), freeOf(fight, person));
    beside.find((t) => goTo(ctx, person, t));
    setLabel(person, "closing in");
    return;
  }
  const post = postOf(fight, person, from);
  const party = nearestPartyTile(fight, from);
  if (combatant.state === "steady" && weapon.range > 1 && party !== undefined) {
    // `guardPassage`: cover the way in from a step or two off the post; ruling 2: with nobody
    // in sight `guardSearchAfterSeconds` after contact, go further to find a line to them.
    const lookAfter = configTicks(ctx.config, ctx.config.expedition.guardSearchAfterSeconds);
    const started = expedition.fightStartedTick ?? ctx.tick;
    const far = ctx.tick - started >= lookAfter;
    const spot = spotSeeing(
      ground,
      far ? from : post,
      party,
      weapon.range,
      far ? REPOSITION_STEPS : GUARD_STEPS,
      freeOf(fight, person),
    );
    if (spot !== undefined && goTo(ctx, person, spot)) {
      setLabel(person, far ? "moving up" : "covering the door");
      return;
    }
  }
  goTo(ctx, person, post);
  setLabel(person, "watching the door");
}

function nearestPartyTile(fight: Fight, from: TileCoord): TileCoord | undefined {
  let best: TileCoord | undefined;
  for (const p of fight.people) {
    if (!isParty(p) || !standingInFight(fight, p)) continue;
    const tile = tileOfActor(fight.ctx.state, p);
    if (tile !== undefined && (best === undefined || distance(tile, from) < distance(best, from))) {
      best = tile;
    }
  }
  return best;
}

function targetTurn(fight: Fight, person: Actor, from: TileCoord, enemies: readonly Seen[]): void {
  const { ctx, ground, expedition } = fight;
  const combatant = combatantOf(person);
  if (expedition.phase !== "fight") {
    setLabel(person, "at the bench");
    return;
  }
  if (combatant.disposition.wants === "blood" && armed(fight, person)) {
    guardTurn(fight, person, from, enemies);
    return;
  }
  const exit = ground.posts.exit;
  const beside = enemies.some((s) => adjacent8(s.tile, from) && presses(fight, s.actor));
  if (combatant.disposition.wants !== "out" || exit === undefined || beside) {
    halt(ctx, person);
    setLabel(person, beside ? "cornered" : "keeping still");
    return;
  }
  const started = expedition.fightStartedTick ?? ctx.tick;
  const boltAfter = configTicks(ctx.config, ctx.config.expedition.targetBoltsAfterSeconds);
  if (ctx.tick - started < boltAfter) {
    halt(ctx, person);
    setLabel(person, "keeping low");
    return;
  }
  goTo(ctx, person, exit);
  setLabel(person, "slipping away");
}

function bystanderTurn(fight: Fight, person: Actor): void {
  const { ctx, ground, expedition } = fight;
  const exit = ground.posts.exit;
  if (expedition.phase !== "fight" || exit === undefined) {
    setLabel(person, "minding their own business");
    return;
  }
  enterFight(ctx, person, "getting clear");
  goTo(ctx, person, exit);
}

// ---------------------------------------------------------------------------------------------
// Arrivals
// ---------------------------------------------------------------------------------------------

/** The cast at the exit leave; the broken party aboard are out; the carried are set down. */
function arrivals(fight: Fight): CombatTick {
  const { ctx, ground } = fight;
  let targetFled: string | undefined;
  for (const person of fight.people) {
    const combatant = person.combatant;
    if (combatant === undefined || ctx.state.actors[person.id] === undefined) continue;
    const at = tileOfActor(ctx.state, person);
    if (at === undefined) continue;
    if (isParty(person)) {
      if (combatant.state === "breaking" && aboard(ctx, ground, person)) {
        combatant.state = "fled";
        halt(ctx, person);
        setLabel(person, "aboard");
      }
      const carried = carriedBy(ctx, person.id);
      if (carried !== undefined && distance(at, ground.foot) <= AT_RAMP_TILES) {
        setDown(person, carried);
        if (carried.crew) addMemory(ctx, carried.id, person.id, "carriedMeOut");
      }
      continue;
    }
    const exit = ground.posts.exit;
    if (exit === undefined || !upright(combatant) || distance(at, exit) > AT_EXIT_TILES) continue;
    // Only a fight for the target ends when he gets away; going for an item, he is one more of the
    // cast leaving (§the-objective-and-resolution).
    const fled = combatant.disposition.part === "target" && fight.plan?.objective === "takeTarget";
    if (fled && fight.expedition.phase !== "resolved") targetFled = person.name;
    removeCast(ctx, person);
  }
  return targetFled === undefined ? {} : { targetFled };
}

/** A cast member leaves the site with what they carry. */
export function removeCast(ctx: StepCtx, person: Actor): void {
  halt(ctx, person);
  for (const item of Object.values(ctx.state.items)) {
    if (item.location.kind === "carriedBy" && item.location.actorId === person.id) {
      delete ctx.state.items[item.id];
      ctx.caches.dirty.inventory = true;
    }
  }
  releaseReservations(ctx.caches, person.id);
  person.movement = { kind: "stationary" };
  delete ctx.state.actors[person.id];
}
