/**
 * Expeditions A1 (W2's real-content fixture for the fight's tests): the default game on the full
 * registry, set down at the Boathouse at tick 0 with a plan, run until the expedition resolves,
 * and the fight's tally read back. The sim's own tests cannot import `@crew/content`, so the
 * Boathouse fights live here.
 *
 * The damage entry point is the real `applyDamage` once bodies land (W1); until then (the gate's
 * stub throws `NotImplementedError`) a double that wounds by the config's tables and thresholds.
 */
import {
  type ActorId,
  type CommandId,
  type DamageResult,
  type Hit,
  type KernelRegistry,
  NotImplementedError,
  type PortDefId,
  type SiteCastEntryDef,
  type StepCtx,
  type World,
  allocateId,
  applyCapacities,
  applyDamage,
  commerceTaskDerivations,
  createKernel,
  createRegistry,
  damageTaskDerivations,
  dirtTaskDerivations,
  equipmentStages,
  equipmentTaskDerivation,
  galleyTaskDerivations,
  incapacityOf,
  isDeadBy,
  registerBodies,
  registerCabins,
  registerCommerce,
  registerDamage,
  registerDirt,
  registerEquipmentSystems,
  registerExpedition,
  registerField,
  registerGalley,
  registerIntercom,
  registerNeeds,
  registerPlannerDefaults,
  registerRecreation,
  registerSocial,
  registerSpatial,
  registerTravel,
  registerWatch,
  registerWork,
  travelTaskDerivations,
} from "@crew/sim";
import { loadPacingContent } from "./pacing";

export const BOATHOUSE = "port.boathouse" as PortDefId;

type DamageFn = (ctx: StepCtx, actorId: ActorId, hit: Hit) => DamageResult;

const PARTS = ["head", "torso", "leftArm", "rightArm", "leftLeg", "rightLeg"] as const;

/** Until W1's `applyDamage` lands: wounds by rule, down or dead by the body's thresholds. */
const doubleDamage: DamageFn = (ctx: StepCtx, actorId: ActorId, hit: Hit): DamageResult => {
  const actor = ctx.state.actors[actorId];
  if (actor === undefined) throw new Error(`no actor ${actorId}`);
  const bodies = ctx.config.bodies;
  const table = hit.type === "stun" ? bodies.stunPartTable : bodies.partTable;
  const total = PARTS.reduce((sum, p) => sum + table[p], 0);
  const draw = ctx.rng.keyedFloat("failures", `fightDouble:${actorId}`, ctx.tick) * total;
  let acc = 0;
  const drawn = PARTS.find((p) => {
    acc += table[p];
    return draw < acc;
  });
  const part = hit.part ?? drawn ?? "torso";
  const woundId = allocateId(ctx.state, "wound");
  if (hit.type === "stun") actor.body.stun = Math.min(1, actor.body.stun + bodies.stunPerHit);
  else {
    actor.body.parts[part].damage += bodies.severityDamage[hit.severity];
    actor.body.pain = Math.min(1, actor.body.pain + bodies.severityPain[hit.severity]);
  }
  actor.body.wounds.push({
    id: woundId,
    part,
    severity: hit.severity,
    type: hit.type,
    bleeding: false,
    tick: ctx.tick,
  });
  applyCapacities(actor, ctx.config);
  const died = isDeadBy(actor.body, ctx.config);
  const down = !died && incapacityOf(actor.body, ctx.config) !== undefined;
  if (died || down) {
    actor.availability = died ? "dead" : "incapacitated";
    actor.activity = { kind: "idle" };
    actor.movement = { kind: "stationary" };
  }
  return { woundId, part, incapacitated: down, died };
};

/**
 * The double while the gate's stub is in (it throws `NotImplementedError` whatever it is given),
 * else undefined: the real entry point, which refuses a probe with no world in its own way.
 */
function damageEntry(): DamageFn | undefined {
  try {
    applyDamage(undefined as unknown as StepCtx, "a0" as ActorId, {
      severity: "graze",
      type: "blunt",
    });
  } catch (error) {
    return error instanceof NotImplementedError ? doubleDamage : undefined;
  }
  throw new Error("applyDamage accepted a probe with no world");
}

/** `createPacingRegistry`'s order, with the expedition's damage entry point chosen above. */
export function fightRegistry(): KernelRegistry {
  const registry = createRegistry();
  registerSpatial(registry);
  registerEquipmentSystems(registry);
  registerDirt(registry);
  registerTravel(registry);
  registerField(registry);
  registerCommerce(registry);
  registerNeeds(registry);
  registerBodies(registry);
  registerWatch(registry);
  registerGalley(registry);
  registerRecreation(registry);
  registerSocial(registry);
  registerCabins(registry);
  registerDamage(registry);
  registerIntercom(registry);
  const applyDamageNow = damageEntry();
  registerExpedition(registry, applyDamageNow === undefined ? {} : { applyDamage: applyDamageNow });
  registerWork(registry, {
    derivations: {
      ...equipmentTaskDerivation,
      ...travelTaskDerivations,
      ...commerceTaskDerivations,
      ...galleyTaskDerivations,
      ...dirtTaskDerivations,
      ...damageTaskDerivations,
    },
    stages: equipmentStages,
  });
  registerPlannerDefaults(registry);
  return registry;
}

/** One fight's record. */
export interface FightRecord {
  readonly plan: string;
  readonly seed: number;
  readonly outcome: string;
  /** Seconds from the start command to contact (undefined: never noticed). */
  readonly toContact?: number;
  /** Seconds from contact (or the approach) to resolution, as `expeditionResolved` says. */
  readonly seconds: number;
  readonly shotsUs: number;
  readonly shotsThem: number;
  readonly woundsUs: number;
  readonly woundsThem: number;
  readonly deadUs: number;
  readonly deadThem: number;
  readonly downUs: number;
  /** The objective was held before anyone noticed the party. */
  readonly quiet: boolean;
  readonly fled: readonly string[];
  readonly surrendered: readonly string[];
  readonly lines: readonly string[];
  readonly world: World;
}

/** The default cast's variants (the plan's "The Boathouse"). */
export function castVariant(
  base: readonly SiteCastEntryDef[],
  variant: "default" | "shaky" | "hard",
): readonly SiteCastEntryDef[] {
  if (variant === "default") return base;
  return base.map((entry) => {
    if (entry.part !== "guard") return entry;
    if (variant === "shaky") return { ...entry, resolve: "shaky", tie: "paid" };
    return { ...entry, resolve: "hard", tie: "devoted", arms: "blaster" };
  });
}

/** Run one fight at the Boathouse under `plan` to its resolution (or `capSeconds`). */
export function runFight(
  plan: string,
  seed: number,
  options: { readonly cast?: "default" | "shaky" | "hard"; readonly capSeconds?: number } = {},
): FightRecord {
  const { bundle, config, scenarioId } = loadPacingContent();
  const kernel = createKernel(fightRegistry());
  const world = kernel.createWorld(scenarioId, seed, bundle, config);
  const site = bundle.docks?.["dock.boathouse" as keyof typeof bundle.docks];
  const cast = castVariant(site?.defaultCast ?? [], options.cast ?? "default");
  const started = kernel.enqueueCommand(world, {
    id: `cmd:fight:${seed}` as CommandId,
    source: "scenario",
    kind: "scenarioStartExpedition",
    payload: { siteId: BOATHOUSE, plan, cast },
  });
  if (started.status !== "accepted") throw new Error(`start refused: ${JSON.stringify(started)}`);
  const rate = world.config.values.time.tickRate;
  const cap = Math.round((options.capSeconds ?? 400) * rate);
  let contactTick: number | undefined;
  let resolved:
    | {
        seconds: number;
        outcome: string;
        woundsUs: number;
        woundsThem: number;
        deadUs: number;
        deadThem: number;
      }
    | undefined;
  let shotsUs = 0;
  let shotsThem = 0;
  let acks = 0;
  const fled: string[] = [];
  const surrendered: string[] = [];
  const lines: string[] = [];
  const party = new Set<string>();
  for (let t = 0; t < cap && resolved === undefined; ) {
    const result = kernel.advance(world, 20);
    t += Math.max(1, result.ticksAdvanced);
    for (const event of result.events) {
      if (event.type === "expeditionStarted") for (const id of event.payload.party) party.add(id);
      if (event.type === "expeditionContact") contactTick = event.tick;
      if (event.type === "shotFired") {
        if (party.has(event.payload.byActorId)) shotsUs += 1;
        else shotsThem += 1;
      }
      if (event.type === "combatantBroke" && event.payload.side === "them") {
        const name = world.state.actors[event.payload.actorId]?.name ?? event.payload.actorId;
        (event.payload.how === "fled" ? fled : surrendered).push(name);
      }
      if (event.significance !== "trace") lines.push(`${event.tick} ${event.type}`);
      if (event.type === "expeditionResolved") {
        resolved = event.payload;
      }
    }
    const hookId = world.state.narrator.pendingHook?.id;
    if (hookId !== undefined) {
      acks += 1;
      kernel.enqueueCommand(world, {
        id: `cmd:fight:ack:${acks}` as CommandId,
        source: "system",
        kind: "acknowledgeHook",
        payload: { hookId },
      });
    }
  }
  const members = [...party].map((id) => world.state.actors[id as ActorId]);
  const expedition = world.state.expedition;
  const objective = expedition?.objectiveTick;
  const contact = expedition?.fightStartedTick;
  return {
    plan,
    seed,
    outcome: resolved?.outcome ?? "unresolved",
    ...(contactTick === undefined ? {} : { toContact: contactTick / rate }),
    seconds: resolved?.seconds ?? Number.NaN,
    shotsUs,
    shotsThem,
    woundsUs: resolved?.woundsUs ?? 0,
    woundsThem: resolved?.woundsThem ?? 0,
    deadUs: resolved?.deadUs ?? 0,
    deadThem: resolved?.deadThem ?? 0,
    quiet: objective !== undefined && (contact === undefined || objective < contact),
    downUs: members.filter((a) => a?.availability === "incapacitated").length,
    fled,
    surrendered,
    lines,
    world,
  };
}
