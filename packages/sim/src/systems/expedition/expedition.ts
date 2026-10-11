/**
 * Expeditions A1 (§8): the expedition system, phase `actions`, registered before work so it runs
 * after spatial and before `work.execute` (registration order within a phase). It owns the
 * phases, hands out the muster (`muster.ts`), runs the fight (`combat.ts`), and resolves it.
 *
 * **Phases.** `mustering` (with a plan: the party to the locker) → `walkingOut` once every party
 * member is armed (`partyMustered`) → `approach` once the leader stands on the site floor in the
 * fight (`approachTick`) → `fight` at contact → `resolved`. A party member on the site floor done
 * with the muster goes into the `fight` activity. D105 `seen`: contact comes the first tick a party
 * member stands on the site floor, while mustering too; the fight then runs from `mustering`
 * straight to `fight` (no `partyMustered`, no approach), the rest arming and walking out into it,
 * and a party called back before they are armed leaves them aboard (`standDown`).
 *
 * **The objective** (held from `objectiveTick` on): `takeTarget` once a party member who presses
 * stands beside the target and no armed cast member who can fight is within four tiles with a line
 * to it (the target
 * surrenders and walks to the ramp with them; the cast take `morale.targetTaken`); `takeItem` the
 * same beside the loot post, where the presser takes the errand's item in hand (`pickUpLoot`) and
 * the target is left alone; `breakThem` once no armed cast member can fight. From then the party
 * falls back to the ramp foot, the down carried. D105: got in `unseen` and before contact, no
 * guard guards the objective and none takes the shock of it.
 *
 * **Resolution**, checked every tick: `targetFled` when the target leaves by the exit under
 * `takeTarget` (going for an item, he is one more of the cast leaving);
 * `targetTaken` once the objective is held and the party (the down carried or set down at the
 * ramp) and the target are at the ramp foot or aboard; `partyWithdrew` once a called-back party
 * is aboard (anyone down left behind); `partyRouted` once every party member is down, dead or
 * fled aboard without being called back; `timedOut` `maxFightSeconds` after contact, or
 * `maxApproachSeconds` (ruling 3) after the approach began with no contact, or (A2) that long
 * after an expedition that started itself on landing began with no plan adopted (no arrival card:
 * the menu had no two plans available).
 * `expeditionResolved` carries the tally (wounds and deaths per side since the start) and names the
 * target (an item errand's thing by the errand's name); the alert
 * stands down `alertClearSeconds` later; thoughts and memories (`heldTheLine` at a taking for
 * those who never broke, `ranFromAFight` for those who broke, `foughtBeside` pairwise among the
 * living, `leftMeBehind` from a down party member left on the floor about the leader); the party
 * leaves the fight (the planner has them again); the taken target, the dead and the down of the
 * cast are removed (A1: the narrator says what then in A2); the rest of the cast walk off by the
 * exit and are removed there, or all at once when the ship plans her lift-off (a course planned,
 * or under way): the scene ends when she lifts, and nobody of the cast is brought aboard.
 *
 * **A2.** Set down at a site for an errand, the expedition starts itself (`landedForErrand`,
 * `start.ts`); the turn card (`cards.ts`) is queued the tick the fight first turns, after the
 * tick's checks and only when it does not resolve then.
 *
 * Owner after the gate: W2 of expeditions A2.
 */
import { configTicks } from "../../core/clock";
import { findItemDef } from "../../core/defs";
import { isOnDock } from "../../core/docks";
import { addThought } from "../../core/thoughts";
import type { Actor } from "../../core/types/actor";
import type { EventDraft } from "../../core/types/events";
import type { ActorId } from "../../core/types/ids";
import type { StepCtx, System } from "../../core/types/pipeline";
import type { Expedition, ExpeditionOutcome } from "../../core/types/state";
import { shipDeckId } from "../../core/world";
import { type DamageResult, type Hit, applyDamage } from "../bodies/damage";
import { addMemory } from "../social/relationships";
import { abortActivity } from "../work/execute";
import { enterFight, goTo, heldWeapon, inFight, setDown, setLabel } from "./actions";
import { queueTurnCard } from "./cards";
import {
  AT_RAMP_TILES,
  type CombatDeps,
  type Fight,
  checkContact,
  fightOf,
  presses,
  removeCast,
  runCombat,
  shaken,
  surrender,
} from "./combat";
import { pickUpLoot, settleErrand } from "./errand";
import { type Ground, aboard, distance, groundOf, onSite, tileOfActor } from "./ground";
import { adjacent8, lineOfSight } from "./los";
import { canAct, shiftResolve, upright, withdrawalDue } from "./morale";
import { handOutMuster, lockerTiles } from "./muster";
import { landedForErrand } from "./start";

/** The objective is held only with no armed cast able to fight this close and in sight of it. */
const GUARDED_TILES = 4;

/** The expedition system, its damage entry point injectable (tests use a double until W1). */
export function makeExpeditionSystem(deps: CombatDeps): System {
  return {
    name: "expedition.expedition",
    phase: "actions",
    run(ctx) {
      // A2 call 12: set down at a site for an errand, the expedition starts itself.
      const last = ctx.state.expedition;
      if (last === undefined || last.phase === "resolved") landedForErrand(ctx);
      const expedition = ctx.state.expedition;
      if (expedition === undefined) return;
      const ground = groundOf(ctx);
      if (expedition.phase === "resolved") {
        aftermath(ctx, expedition, ground);
        return;
      }
      if (ground === undefined) return;
      handOutMuster(ctx);
      advancePhase(ctx, expedition);
      standDown(ctx, expedition);
      if (expedition.phase === "mustering") {
        const mustering = fightOf(ctx, deps, ground);
        if (mustering === undefined) return;
        if (unplannedTooLong(ctx, expedition)) {
          resolve(mustering, "timedOut", undefined);
          return;
        }
        // D105 `seen`: the first of the party on the site floor is contact though the rest are
        // still mustering, and the fight runs from then.
        checkContact(mustering);
        if (!fightBegun(expedition)) return;
      }
      const fight = fightOf(ctx, deps, ground);
      if (fight === undefined) return;
      const tick = runCombat(fight);
      checkContact(fight);
      checkWithdrawal(fight);
      checkObjective(fight);
      const outcome = tick.targetFled !== undefined ? "targetFled" : outcomeNow(fight);
      if (outcome !== undefined) resolve(fight, outcome, tick.targetFled);
      // A2 call 15: the turn card, the tick the fight first turns (and goes on).
      else queueTurnCard(fight);
    },
  };
}

export const expeditionSystem: System = makeExpeditionSystem({
  applyDamage: (ctx: StepCtx, actorId: ActorId, hit: Hit): DamageResult =>
    applyDamage(ctx, actorId, hit),
});

// ---------------------------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------------------------

function partyActors(ctx: StepCtx, expedition: Expedition): Actor[] {
  return expedition.party
    .map((id) => ctx.state.actors[id])
    .filter((a): a is Actor => a !== undefined);
}

function advancePhase(ctx: StepCtx, expedition: Expedition): void {
  if (expedition.plan === undefined) return;
  const party = partyActors(ctx, expedition);
  if (expedition.phase === "mustering" && party.every((a) => a.combatant !== undefined)) {
    expedition.phase = "walkingOut";
    const armed = party.filter((a) => heldWeapon(ctx, a) !== undefined).map((a) => a.id);
    ctx.emit({
      type: "partyMustered",
      subjectIds: party.map((a) => a.id),
      causeIds: [],
      source: "sim",
      payload: { party: party.map((a) => a.id), armed },
    });
  }
  for (const actor of party) {
    const combatant = actor.combatant;
    if (combatant === undefined || !canAct(combatant) || inFight(actor)) continue;
    if (actor.availability !== "available" || !onSite(ctx, actor)) continue;
    const activity = actor.activity;
    if (activity.kind === "personal" && activity.activity === "muster") continue;
    enterFight(ctx, actor, "ashore");
  }
  if (expedition.phase !== "walkingOut") return;
  const leader = ctx.state.actors[expedition.leaderId];
  const leading = leader !== undefined && inFight(leader) && onSite(ctx, leader);
  const anyone = party.some((a) => inFight(a) && onSite(ctx, a));
  if (leading || (anyone && (leader === undefined || leader.availability !== "available"))) {
    expedition.phase = "approach";
    expedition.approachTick = ctx.tick;
  }
}

/** Has contact come (read through a call: `checkContact` moves the phase on)? */
function fightBegun(expedition: Readonly<Expedition>): boolean {
  return expedition.phase === "fight";
}

/**
 * Called back while some of the party are still on the muster (a fight that began during it, D105
 * `seen`, or one still walking down): they stop it. Whoever is not armed yet stays aboard and never
 * went (`outcomeNow`); an armed one already on the site floor runs for the ship with the rest.
 */
function standDown(ctx: StepCtx, expedition: Expedition): void {
  if (expedition.withdrawTick === undefined) return;
  for (const actor of partyActors(ctx, expedition)) {
    if (!onMuster(actor)) continue;
    stopMuster(ctx, actor);
    if (actor.combatant !== undefined && onSite(ctx, actor)) enterFight(ctx, actor, "running");
  }
}

function onMuster(actor: Actor): boolean {
  const muster = (intent: Actor["pendingIntent"]) =>
    intent?.kind === "personal" && intent.activity === "muster";
  const activity = actor.activity;
  return (
    muster(actor.pendingIntent) || (activity.kind === "personal" && activity.activity === "muster")
  );
}

/**
 * A2: an expedition that started itself on landing and has had no plan for `maxApproachSeconds`
 * (the menu offered no two plans, so no arrival card) gives up rather than hold the ship there.
 * While the arrival card is up the world is halted, so this never runs out under it.
 */
function unplannedTooLong(ctx: StepCtx, expedition: Expedition): boolean {
  if (expedition.jobId === undefined || expedition.plan !== undefined) return false;
  const limit = configTicks(ctx.config, ctx.config.expedition.maxApproachSeconds);
  return ctx.tick - expedition.startedTick >= limit;
}

/** §8.3 `withdrawWhen`, checked every tick in the fight. */
function checkWithdrawal(fight: Fight): void {
  const { ctx, expedition, plan } = fight;
  if (expedition.phase !== "fight" || expedition.withdrawTick !== undefined) return;
  if (plan === undefined || !withdrawalDue(ctx.state, expedition, plan.withdrawWhen, ctx.config)) {
    return;
  }
  orderWithdrawal(ctx);
}

/**
 * §8.3 `withdrawWhen`, or the captain's order: every party member still fighting breaks for the
 * ship, and `partyWithdrew` says so once.
 */
export function orderWithdrawal(
  ctx: Pick<StepCtx, "state" | "emit" | "tick">,
  cause: Pick<EventDraft, "causeIds" | "source"> = { causeIds: [], source: "sim" },
): void {
  const expedition = ctx.state.expedition;
  if (expedition === undefined || expedition.withdrawTick !== undefined) return;
  expedition.withdrawTick = ctx.tick;
  for (const id of expedition.party) {
    const combatant = ctx.state.actors[id]?.combatant;
    if (combatant === undefined) continue;
    if (combatant.state === "steady" || combatant.state === "wavering") {
      combatant.state = "breaking";
    }
  }
  ctx.emit({
    type: "partyWithdrew",
    subjectIds: [...expedition.party],
    ...cause,
    payload: {},
  });
}

// ---------------------------------------------------------------------------------------------
// The objective
// ---------------------------------------------------------------------------------------------

const isParty = (a: Actor) => a.combatant?.side === "us";

/**
 * Is `tile` under an armed cast member's eye: one who can fight, within `GUARDED_TILES` with a
 * line to it? A guard who steps back into cover still guards what he can see.
 */
function guarded(fight: Fight, tile: { x: number; y: number }): boolean {
  return fight.people.some((p) => {
    const c = p.combatant;
    if (c === undefined || c.side !== "them" || !canAct(c)) return false;
    if (heldWeapon(fight.ctx, p) === undefined) return false;
    const at = tileOfActor(fight.ctx.state, p);
    if (at === undefined || distance(at, tile) > GUARDED_TILES) return false;
    return lineOfSight(fight.ground.berth, at, tile);
  });
}

/** A party member going for the objective who stands beside `tile`. */
function pressedBeside(fight: Fight, tile: { x: number; y: number }): boolean {
  return fight.people.some((p) => {
    if (!presses(fight, p) || !onSite(fight.ctx, p)) return false;
    const at = tileOfActor(fight.ctx.state, p);
    return at !== undefined && adjacent8(at, tile);
  });
}

/**
 * D105: the party got in unseen (`Expedition.notice`) and nobody has made contact yet: no guard is
 * looking, so none guards the objective, and none feels it taken.
 */
function unnoticed(fight: Fight): boolean {
  return fight.expedition.notice === "unseen" && fight.expedition.phase === "approach";
}

function checkObjective(fight: Fight): void {
  const { ctx, expedition, plan } = fight;
  if (plan === undefined || expedition.objectiveTick !== undefined) return;
  if (expedition.withdrawTick !== undefined) return;
  if (expedition.phase !== "fight" && expedition.phase !== "approach") return;
  const open = (tile: { x: number; y: number }) => unnoticed(fight) || !guarded(fight, tile);
  let held = false;
  if (plan.objective === "takeTarget") {
    const target = fight.people.find((p) => p.combatant?.disposition.part === "target");
    const at = target === undefined ? undefined : tileOfActor(ctx.state, target);
    const c = target?.combatant;
    if (target !== undefined && at !== undefined && c !== undefined && upright(c)) {
      held = pressedBeside(fight, at) && open(at);
      if (held) surrender(fight, target);
    }
  } else if (plan.objective === "takeItem") {
    const loot = fight.ground.posts.loot;
    held = loot !== undefined && pressedBeside(fight, loot) && open(loot);
    if (held) pickUpLoot(fight);
  } else {
    held =
      expedition.phase === "fight" &&
      !fight.people.some(
        (p) =>
          !isParty(p) &&
          p.combatant !== undefined &&
          canAct(p.combatant) &&
          heldWeapon(ctx, p) !== undefined,
      );
  }
  if (!held) return;
  expedition.objectiveTick = ctx.tick;
  if (unnoticed(fight)) return;
  const morale = ctx.config.expedition.morale;
  for (const p of fight.people) {
    const c = p.combatant;
    if (c === undefined || c.side !== "them" || !canAct(c)) continue;
    shaken(fight, p, morale.targetTaken);
  }
}

// ---------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------

/** At the ramp foot, or aboard. */
function home(fight: Fight, actor: Actor): boolean {
  if (aboard(fight.ctx, fight.ground, actor)) return true;
  const at = tileOfActor(fight.ctx.state, actor);
  return at !== undefined && distance(at, fight.ground.foot) <= AT_RAMP_TILES;
}

function outcomeNow(fight: Fight): ExpeditionOutcome | undefined {
  const { ctx, expedition } = fight;
  const party = partyActors(ctx, expedition);
  const ticks = (seconds: number) => configTicks(ctx.config, seconds);
  const e = ctx.config.expedition;
  if (expedition.phase === "approach" || expedition.phase === "fight") {
    const out = party.every((a) => {
      const s = a.combatant?.state;
      // Not armed when the party was called back (`standDown`): they never went.
      if (s === undefined) return expedition.withdrawTick !== undefined;
      return s === "down" || s === "dead" || s === "fled";
    });
    if (party.length > 0 && out) {
      if (expedition.withdrawTick !== undefined) return "partyWithdrew";
      if (expedition.phase === "fight") return "partyRouted";
    }
    if (expedition.objectiveTick !== undefined && returned(fight, party)) return "targetTaken";
  }
  if (expedition.phase === "fight") {
    const since = expedition.fightStartedTick ?? ctx.tick;
    if (ctx.tick - since >= ticks(e.maxFightSeconds)) return "timedOut";
  }
  if (expedition.phase === "approach" && expedition.approachTick !== undefined) {
    if (ctx.tick - expedition.approachTick >= ticks(e.maxApproachSeconds)) return "timedOut";
  }
  return undefined;
}

/** Everyone (and the taken target) back at the ramp, the down brought in. */
function returned(fight: Fight, party: readonly Actor[]): boolean {
  for (const actor of party) {
    const s = actor.combatant?.state;
    if (s === "dead" || s === "fled") continue;
    if (actor.location.kind === "carriedBy") continue;
    if (!home(fight, actor)) return false;
  }
  if (fight.plan?.objective !== "takeTarget") return true;
  const target = fight.people.find((p) => p.combatant?.disposition.part === "target");
  return target === undefined || home(fight, target);
}

interface Tally {
  readonly woundsUs: number;
  readonly hurtUs: number;
  readonly woundsThem: number;
  readonly deadUs: number;
  readonly deadThem: number;
}

function tally(fight: Fight): Tally {
  const since = fight.expedition.startedTick;
  let woundsUs = 0;
  let hurtUs = 0;
  let woundsThem = 0;
  let deadUs = 0;
  let deadThem = 0;
  for (const p of fight.people) {
    const wounds = p.body.wounds.filter((w) => w.tick >= since).length;
    const dead = p.availability === "dead" ? 1 : 0;
    if (isParty(p)) {
      woundsUs += wounds;
      if (wounds > 0 && dead === 0) hurtUs += 1;
      deadUs += dead;
    } else {
      woundsThem += wounds;
      deadThem += dead;
    }
  }
  return { woundsUs, hurtUs, woundsThem, deadUs, deadThem };
}

/**
 * Whom or what the expedition was for, as `expeditionResolved` names it: an item errand's thing by
 * the errand's name ("the strongbox papers"), else the target who got away, else the cast's target.
 */
function resolvedTargetName(fight: Fight, fledName: string | undefined): string | undefined {
  const { ctx, expedition } = fight;
  const errand =
    expedition.jobId === undefined ? undefined : ctx.state.jobs[expedition.jobId]?.errand;
  if (errand?.kind === "fetchItem") return errand.targetName;
  const target = fight.people.find((p) => p.combatant?.disposition.part === "target");
  return fledName ?? target?.name;
}

function resolve(fight: Fight, outcome: ExpeditionOutcome, fledName: string | undefined): void {
  const { ctx, expedition } = fight;
  const targetName = resolvedTargetName(fight, fledName);
  const from = expedition.fightStartedTick ?? expedition.approachTick ?? expedition.startedTick;
  const counts = tally(fight);
  expedition.phase = "resolved";
  expedition.resolvedTick = ctx.tick;
  expedition.outcome = outcome;
  ctx.emit({
    type: "expeditionResolved",
    subjectIds: fight.people.map((p) => p.id),
    causeIds: [],
    source: "sim",
    locationRef: { kind: "port", portId: expedition.siteId },
    payload: {
      siteId: expedition.siteId,
      outcome,
      ...(targetName === undefined ? {} : { targetName }),
      seconds: (ctx.tick - from) / ctx.config.time.tickRate,
      shots: expedition.shots,
      ...counts,
      ...(expedition.notice === undefined ? {} : { notice: expedition.notice }),
    },
  });
  const alert = ctx.state.alert;
  if (alert?.cause === "fight") {
    alert.clearsAtTick =
      ctx.tick + configTicks(ctx.config, ctx.config.expedition.alertClearSeconds);
  }
  afterTheFight(fight, outcome);
  // A2 call 5: before the cast loop, which removes a taken target (the captive is spawned anew).
  settleErrand(fight, outcome);
  for (const person of fight.people) {
    if (ctx.state.actors[person.id] === undefined) continue;
    if (isParty(person)) leaveFight(ctx, person);
    else castAfter(fight, person, outcome);
  }
  for (const id of expedition.party) {
    const actor = ctx.state.actors[id];
    if (actor !== undefined) stopMuster(ctx, actor);
  }
}

/**
 * Whoever is still on the muster when the fight ends stops: its `arm` step would make them a
 * combatant after the fight, aboard a ship that may be lifting off.
 */
function stopMuster(ctx: StepCtx, actor: Actor): void {
  const muster = (intent: Actor["pendingIntent"]) =>
    intent?.kind === "personal" && intent.activity === "muster";
  if (muster(actor.pendingIntent)) {
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete actor.pendingIntent;
  }
  const activity = actor.activity;
  if (activity.kind === "personal" && activity.activity === "muster") {
    abortActivity(ctx, actor, "cancelled");
  }
}

/** Thoughts and memories of the fight (§11). */
function afterTheFight(fight: Fight, outcome: ExpeditionOutcome): void {
  const { ctx, expedition } = fight;
  const morale = ctx.config.expedition.morale;
  const party = partyActors(ctx, expedition);
  const has = (key: string) => key in ctx.content.thoughts;
  for (const actor of party) {
    const c = actor.combatant;
    if (c === undefined || actor.availability === "dead") continue;
    const ran = (c.state === "breaking" || c.state === "fled") && c.resolve < morale.breakBelow;
    if (ran && has("ranFromAFight")) addThought(ctx, actor, "ranFromAFight");
    if (!ran && outcome === "targetTaken" && has("heldTheLine") && canAct(c)) {
      addThought(ctx, actor, "heldTheLine");
    }
  }
  // Only those who went: a party picked without a plan never mustered.
  const living = party.filter(
    (a) => a.availability !== "dead" && a.crew && a.combatant !== undefined,
  );
  for (const a of living) {
    for (const b of living) if (a.id !== b.id) addMemory(ctx, a.id, b.id, "foughtBeside");
  }
  const leader = ctx.state.actors[expedition.leaderId];
  for (const actor of living) {
    if (actor.combatant?.state !== "down" || actor.location.kind === "carriedBy") continue;
    if (leader === undefined || leader.id === actor.id || home(fight, actor)) continue;
    addMemory(ctx, actor.id, leader.id, "leftMeBehind");
  }
}

/** A party member out of the fight: set down if carried, the planner has them again. */
function leaveFight(ctx: StepCtx, actor: Actor): void {
  if (actor.location.kind === "carriedBy") {
    const carrier = ctx.state.actors[actor.location.actorId];
    if (carrier !== undefined) setDown(carrier, actor);
  }
  if (inFight(actor)) abortActivity(ctx, actor, "cancelled");
  // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
  delete actor.combatant;
}

/**
 * The cast after the fight: the taken, the dead and the down are gone; the rest walk off. Only a
 * plan that goes for the target takes him: going for an item, he walks off with the rest.
 */
function castAfter(fight: Fight, person: Actor, outcome: ExpeditionOutcome): void {
  const c = person.combatant;
  if (c === undefined) return;
  const taken =
    outcome === "targetTaken" &&
    c.disposition.part === "target" &&
    fight.plan?.objective === "takeTarget";
  const gone = !upright(c) && c.state !== "surrendered";
  if (taken || gone || person.availability !== "available") {
    removeCast(fight.ctx, person);
    return;
  }
  walkOff(fight.ctx, fight.ground, person);
}

function walkOff(ctx: StepCtx, ground: Ground | undefined, person: Actor): void {
  const c = person.combatant;
  if (c === undefined) return;
  c.state = "fled";
  // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
  delete c.aim;
  const exit = ground?.posts.exit;
  if (exit !== undefined && goTo(ctx, person, exit)) setLabel(person, "leaving");
}

/**
 * After resolution: the cast walk off and go at the exit, or all go at once when the ship plans
 * her lift-off (the departure prep would carry anyone still on the floor aboard); the alert stands
 * down when due.
 */
/**
 * §the-muster: as the ship plans her lift-off, the arms the party took from the locker go back
 * into it, wherever they ended up (in hand, dropped on the site's floor, carried aboard); the
 * cast's weapons left on the ground stay there with them. Why: nobody puts a weapon back on their
 * own, and the muster arms only from the locker, so every fight would empty it.
 */
function stowArms(ctx: StepCtx, expedition: Expedition): void {
  const arms = expedition.arms;
  const tiles = lockerTiles(ctx.state, ctx.content);
  const deckId = shipDeckId(ctx.state);
  if (arms !== undefined && tiles.length > 0) {
    arms.forEach((id, index) => {
      const item = ctx.state.items[id];
      const tile = tiles[index % tiles.length];
      if (item === undefined || tile === undefined) return;
      item.location = { kind: "onDeck", deckId, x: tile.x + 0.5, y: tile.y + 0.5 };
    });
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete expedition.arms;
    ctx.caches.dirty.inventory = true;
  }
  for (const item of Object.values(ctx.state.items)) {
    if (!isOnDock(ctx.content, ctx.state, item.location)) continue;
    if (findItemDef(ctx.content, ctx.state, item.defId)?.weapon === undefined) continue;
    delete ctx.state.items[item.id];
    ctx.caches.dirty.inventory = true;
  }
}

function aftermath(ctx: StepCtx, expedition: Expedition, ground: Ground | undefined): void {
  const alert = ctx.state.alert;
  if (
    alert?.cause === "fight" &&
    alert.clearsAtTick !== undefined &&
    alert.clearsAtTick <= ctx.tick
  ) {
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete ctx.state.alert;
    ctx.emit({
      type: "alertCleared",
      subjectIds: [],
      causeIds: [],
      source: "sim",
      payload: { cause: "fight" },
    });
  }
  const travel = ctx.state.travel;
  const liftingOff = travel.stage !== "docked" || travel.plannedDestinationId !== undefined;
  if (liftingOff) stowArms(ctx, expedition);
  const leaving = Object.values(ctx.state.actors).filter((a) => a.combatant?.side === "them");
  if (leaving.length === 0) return;
  if (liftingOff) {
    for (const person of leaving) removeCast(ctx, person);
    return;
  }
  const exit = ground?.posts.exit;
  for (const person of leaving) {
    const at = tileOfActor(ctx.state, person);
    const there = exit === undefined || at === undefined || distance(at, exit) <= 1;
    const stuck = person.movement.kind !== "moving" && !there;
    if (there || (stuck && (exit === undefined || !goTo(ctx, person, exit)))) {
      removeCast(ctx, person);
    }
  }
}
