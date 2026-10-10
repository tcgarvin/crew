/**
 * Bodies (expeditions A1, docs/design/expeditions.md §7.1; SD §12.2): a whole body, a part's
 * function, the body's capacities, and the one formula that composes them with fatigue (plan call
 * 5). Pure; the bodies system and `applyDamage` (`systems/bodies/`) write bodies, needs and the
 * bodies system write capacities through `applyCapacities`, and the AgentView reads
 * `bodyCapacities` for `SelfView.body` (the planner may not import systems, so the formulas live
 * here).
 *
 * SD §12.2 names the aggregation but gives no numbers; A1's formulas, all here:
 *
 * - A part's function is `clamp(1 − damage / tolerance, 0, 1)`, where a part's damage is the sum
 *   of its open wounds' damage (`woundDamage`).
 * - Movement is the mean of the two leg chains' function, manipulation of the two arm chains' (a
 *   chain is the limb alone: no hands or feet yet). One `serious` leg wound (1.2 against 2) leaves
 *   that leg at 0.4 and movement at 0.7; two on one arm leave it at 0 and manipulation at 0.5.
 * - Consciousness is the weakest of the head's function, the blood term (blood above the death
 *   floor as a share of the way to full: `(blood − deadBelowBlood) / (1 − deadBelowBlood)`) and
 *   `1 − stun`, times the pain term `1 − pain / 2` (pain at 1 halves it). Two stun hits (0.5 each)
 *   put it at 0; it is back above a 0.3 floor once stun is down to 0.7.
 * - Death is a threshold, never a timer (SD §12.4): head or torso damage at or past tolerance, or
 *   blood below `deadBelowBlood`. Incapacity is consciousness or movement below its floor.
 * - A wound bleeds when it is a `blaster` `serious` or `grave` (`bleedsOnHit`), for
 *   `bleedStopsAfterSeconds` from its tick; then it heals, losing `healPerDay` of its severity's
 *   damage a day (a `serious` one is gone two days after it stops). A `stun` wound has no damage
 *   and closes when the body's stun is back to 0.
 *
 * A whole body is 1 across, so nothing changes until someone is hurt. Owner after the gate: W1 of
 * expeditions A1 (bodies).
 */
import type { Actor, Body, Capacities, Wound } from "./types/actor";
import type { DeepReadonly } from "./types/common";
import type { Tick } from "./types/common";
import {
  BODY_PARTS,
  type BodyPart,
  type ConfigDef,
  type DamageType,
  type WoundSeverity,
} from "./types/content";

type BodiesConfig = Pick<ConfigDef, "bodies">;
/** What the wound clock reads: the body's rates and the tick rate and day length. */
export type WoundClockConfig = Pick<ConfigDef, "bodies" | "time">;
/** What `applyCapacities` reads: fatigue's curve and the body's tolerances. */
export type CapacityConfig = Pick<ConfigDef, "bodies" | "urgency" | "movement">;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** A whole body: no damage, full blood, no pain or stun, no wounds. */
export function wholeBody(): Body {
  const parts = {} as Record<BodyPart, { damage: number }>;
  for (const part of BODY_PARTS) parts[part] = { damage: 0 };
  return { parts, blood: 1, pain: 0, stun: 0, wounds: [] };
}

/** SD §12.2: how well `part` works, in [0, 1]: `1 − damage / tolerance`. */
export function partFunction(
  body: DeepReadonly<Body>,
  part: BodyPart,
  config: BodiesConfig,
): number {
  const tolerance = config.bodies.tolerance[part];
  if (!(tolerance > 0)) return 0;
  return clamp01(1 - body.parts[part].damage / tolerance);
}

/** Blood above the death floor, as a share of the way from the floor to full: 1 whole, 0 dead. */
function bloodTerm(body: DeepReadonly<Body>, config: BodiesConfig): number {
  const floor = config.bodies.deadBelowBlood;
  return floor >= 1 ? 0 : clamp01((body.blood - floor) / (1 - floor));
}

/** The pain factor on consciousness: 1 painless, ½ at pain 1. */
function painTerm(body: DeepReadonly<Body>): number {
  return 1 - 0.5 * clamp01(body.pain);
}

/** SD §12.2: the body's own capacities, before fatigue (`applyCapacities` composes the two). */
export function bodyCapacities(body: DeepReadonly<Body>, config: BodiesConfig): Capacities {
  const fn = (part: BodyPart) => partFunction(body, part, config);
  const consciousness = clamp01(
    Math.min(fn("head"), bloodTerm(body, config), 1 - clamp01(body.stun)) * painTerm(body),
  );
  return {
    movement: clamp01((fn("leftLeg") + fn("rightLeg")) / 2),
    manipulation: clamp01((fn("leftArm") + fn("rightArm")) / 2),
    consciousness,
  };
}

/**
 * Bounded capacity curve for severe fatigue (W4a decision, `systems/needs/needs.ts`): above
 * `severeAbove`, movement and manipulation fall linearly from 1 to `floor` at fatigue 1.
 */
export function fatigueCapacity(fatigue: number, severeAbove: number, floor: number): number {
  if (fatigue <= severeAbove || severeAbove >= 1) return 1;
  const t = clamp01((fatigue - severeAbove) / (1 - severeAbove));
  return clamp01(1 - (1 - clamp01(floor)) * t);
}

/** Call 5: the capacities `actor` should have now, from fatigue and the body. */
export function capacitiesOf(
  actor: DeepReadonly<Pick<Actor, "needs" | "body">>,
  config: CapacityConfig,
): Capacities {
  const fatigue = fatigueCapacity(
    actor.needs.fatigue,
    config.urgency.needSurvivalAbove,
    config.movement.fatigueSpeedFloor,
  );
  const body = bodyCapacities(actor.body, config);
  return {
    movement: fatigue * body.movement,
    manipulation: fatigue * body.manipulation,
    consciousness: body.consciousness,
  };
}

/**
 * Call 5: write `actor.capacities` from fatigue and the body: `movement = fatigueCapacity ×
 * bodyMovement`, `manipulation = fatigueCapacity × bodyManipulation`, `consciousness =
 * bodyConsciousness`. The one writer of capacities (needs for crew it steps, the bodies system for
 * everyone else).
 */
export function applyCapacities(
  actor: Pick<Actor, "needs" | "body" | "capacities">,
  config: CapacityConfig,
): void {
  const next = capacitiesOf(actor, config);
  const capacities = actor.capacities;
  if (capacities.movement !== next.movement) capacities.movement = next.movement;
  if (capacities.manipulation !== next.manipulation) capacities.manipulation = next.manipulation;
  if (capacities.consciousness !== next.consciousness) {
    capacities.consciousness = next.consciousness;
  }
}

/**
 * SD §12.4: is this body dead? Head or torso damage at or past tolerance, or blood below
 * `deadBelowBlood`: thresholds, never a timer.
 */
export function isDeadBy(body: DeepReadonly<Body>, config: BodiesConfig): boolean {
  const { tolerance, deadBelowBlood } = config.bodies;
  return (
    body.parts.head.damage >= tolerance.head ||
    body.parts.torso.damage >= tolerance.torso ||
    body.blood < deadBelowBlood
  );
}

/** Why a living body is incapacitated, if it is. */
export type IncapacityCause = "blood" | "pain" | "movement" | "stun";

/**
 * SD §12.4: why this body cannot go on, or undefined if it can: consciousness below
 * `incapacitatedBelow.consciousness` (put down to whichever of blood, stun or pain weighs most;
 * head damage counts as pain), else movement below `incapacitatedBelow.movement`.
 */
export function incapacityOf(
  body: DeepReadonly<Body>,
  config: BodiesConfig,
): IncapacityCause | undefined {
  const floors = config.bodies.incapacitatedBelow;
  const capacities = bodyCapacities(body, config);
  if (capacities.consciousness < floors.consciousness) {
    const blood = bloodTerm(body, config);
    const stun = 1 - clamp01(body.stun);
    if (blood <= stun && blood < 1) return "blood";
    if (stun < 1) return "stun";
    return "pain";
  }
  if (capacities.movement < floors.movement) return "movement";
  return undefined;
}

/** A fresh wound of this type and severity bleeds: a `blaster` `serious` or `grave`. */
export function bleedsOnHit(type: DamageType, severity: WoundSeverity): boolean {
  return type === "blaster" && (severity === "serious" || severity === "grave");
}

/**
 * The tick a wound stops bleeding on its own and starts to heal: `bleedStopsAfterSeconds` after
 * it was made for one that bled, at once for one that never did. (First aid, phase B, will stop a
 * bleed early and must record when; A1's bleeds only stop on this clock.)
 */
export function woundHealsFromTick(
  wound: DeepReadonly<Pick<Wound, "tick" | "type" | "severity">>,
  config: WoundClockConfig,
): Tick {
  if (!bleedsOnHit(wound.type, wound.severity)) return wound.tick;
  return wound.tick + config.bodies.bleedStopsAfterSeconds[wound.severity] * config.time.tickRate;
}

/**
 * The damage `wound` still does at `tick`: its severity's full damage until it starts to heal,
 * then less by `healPerDay` of that a day, down to 0. A `stun` wound does none.
 */
export function woundDamage(
  wound: DeepReadonly<Pick<Wound, "tick" | "type" | "severity">>,
  tick: Tick,
  config: WoundClockConfig,
): number {
  if (wound.type === "stun") return 0;
  const full = config.bodies.severityDamage[wound.severity];
  const healingTicks = Math.max(0, tick - woundHealsFromTick(wound, config));
  const days = healingTicks / config.time.tickRate / config.time.daySeconds;
  return Math.max(0, full * (1 - config.bodies.healPerDay * days));
}
