/**
 * Expeditions A1 (§8): the expedition system, phase `actions`, registered before work so it runs
 * after spatial and before `work.execute` (registration order within a phase). It owns the
 * phases, hands out the muster (`muster.ts`), runs the fight (`combat.ts`), and resolves it.
 *
 * **Phases.** `mustering` (with a plan: the party to the locker) → `walkingOut` once every party
 * member is armed (`partyMustered`) → `approach` once the leader stands on the site floor in the
 * fight (`approachTick`) → `fight` at contact → `resolved`. A party member on the site floor done
 * with the muster goes into the `fight` activity.
 *
 * **The objective** (held from `objectiveTick` on): `takeTarget` once a party member who presses
 * stands beside the target and no armed cast member who can fight is within four tiles with a line
 * to it (the target
 * surrenders and walks to the ramp with them; the cast take `morale.targetTaken`); `takeItem` the
 * same beside the loot post; `breakThem` once no armed cast member can fight. From then the party
 * falls back to the ramp foot, the down carried.
 *
 * **Resolution**, checked every tick: `targetFled` when the target leaves by the exit;
 * `targetTaken` once the objective is held and the party (the down carried or set down at the
 * ramp) and the target are at the ramp foot or aboard; `partyWithdrew` once a called-back party
 * is aboard (anyone down left behind); `partyRouted` once every party member is down, dead or
 * fled aboard without being called back; `timedOut` `maxFightSeconds` after contact, or
 * `maxApproachSeconds` (ruling 3) after the approach began with no contact, or (A2) that long
 * after an expedition that started itself on landing began with no plan adopted (no arrival card:
 * the menu had no two plans available).
 * `expeditionResolved` carries the tally (wounds and deaths per side since the start); the alert
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
import { addThought } from "../../core/thoughts";
import type { Actor } from "../../core/types/actor";
import type { EventDraft } from "../../core/types/events";
import type { ActorId } from "../../core/types/ids";
import type { StepCtx, System } from "../../core/types/pipeline";
import type { Expedition, ExpeditionOutcome } from "../../core/types/state";
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
import { settleErrand } from "./errand";
import { type Ground, aboard, distance, groundOf, onSite, tileOfActor } from "./ground";
import { adjacent8, lineOfSight } from "./los";
import { canAct, shiftResolve, upright, withdrawalDue } from "./morale";
import { handOutMuster } from "./muster";
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
        aftermath(ctx, ground);
        return;
      }
      if (ground === undefined) return;
      handOutMuster(ctx);
      advancePhase(ctx, expedition);
      if (expedition.phase === "mustering") {
        if (unplannedTooLong(ctx, expedition)) {
          const fight = fightOf(ctx, deps, ground);
          if (fight !== undefined) resolve(fight, "timedOut", undefined);
        }
        return;
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

function checkObjective(fight: Fight): void {
  const { ctx, expedition, plan } = fight;
  if (plan === undefined || expedition.objectiveTick !== undefined) return;
  if (expedition.withdrawTick !== undefined) return;
  if (expedition.phase !== "fight" && expedition.phase !== "approach") return;
  let held = false;
  if (plan.objective === "takeTarget") {
    const target = fight.people.find((p) => p.combatant?.disposition.part === "target");
    const at = target === undefined ? undefined : tileOfActor(ctx.state, target);
    const c = target?.combatant;
    if (target !== undefined && at !== undefined && c !== undefined && upright(c)) {
      held = pressedBeside(fight, at) && !guarded(fight, at);
      if (held) surrender(fight, target);
    }
  } else if (plan.objective === "takeItem") {
    const loot = fight.ground.posts.loot;
    held = loot !== undefined && pressedBeside(fight, loot) && !guarded(fight, loot);
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
  readonly woundsThem: number;
  readonly deadUs: number;
  readonly deadThem: number;
}

function tally(fight: Fight): Tally {
  const since = fight.expedition.startedTick;
  let woundsUs = 0;
  let woundsThem = 0;
  let deadUs = 0;
  let deadThem = 0;
  for (const p of fight.people) {
    const wounds = p.body.wounds.filter((w) => w.tick >= since).length;
    const dead = p.availability === "dead" ? 1 : 0;
    if (isParty(p)) {
      woundsUs += wounds;
      deadUs += dead;
    } else {
      woundsThem += wounds;
      deadThem += dead;
    }
  }
  return { woundsUs, woundsThem, deadUs, deadThem };
}

function resolve(fight: Fight, outcome: ExpeditionOutcome, fledName: string | undefined): void {
  const { ctx, expedition } = fight;
  const target = fight.people.find((p) => p.combatant?.disposition.part === "target");
  const targetName = fledName ?? target?.name;
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

/** The cast after the fight: the taken, the dead and the down are gone; the rest walk off. */
function castAfter(fight: Fight, person: Actor, outcome: ExpeditionOutcome): void {
  const c = person.combatant;
  if (c === undefined) return;
  const taken = outcome === "targetTaken" && c.disposition.part === "target";
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
function aftermath(ctx: StepCtx, ground: Ground | undefined): void {
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
  const leaving = Object.values(ctx.state.actors).filter((a) => a.combatant?.side === "them");
  if (leaving.length === 0) return;
  const travel = ctx.state.travel;
  if (travel.stage !== "docked" || travel.plannedDestinationId !== undefined) {
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
