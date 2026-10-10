/**
 * Expeditions A1 W1 test fixture (§7.1): the field fixture's four-room ship (airlock, hold,
 * engineering, bridge; `systems/field/fixtures/field-deck.ts`) docked at Alpha, with its four crew
 * whole, needs still, and a blaster in content. Spatial, needs, bodies, work and the planner run;
 * travel, the field and the watch do not, so nothing hurts anyone but a test.
 *
 * Crew, in actor order: a1 Jax, a2 Mara (captain), a3 Priya, a4 Bettina, standing in the hold.
 * `woundNow` wounds someone by hand through `applyDamage`, outside a tick, as the combat system
 * would inside one.
 */
import { rebuildItemIndexes } from "../../../core/caches";
import { createDefLookup } from "../../../core/defs";
import type { TestWorld } from "../../../core/fixtures/test-world";
import { allocateId } from "../../../core/ids";
import { bodyViolations, checkInvariants } from "../../../core/invariants";
import { createKernel } from "../../../core/kernel";
import { createRegistry } from "../../../core/registry";
import { createRngApi } from "../../../core/rng";
import type { Actor } from "../../../core/types/actor";
import type { ConfigDef, ContentBundle, ItemDef } from "../../../core/types/content";
import type { EventDraft } from "../../../core/types/events";
import type { ActorId, ItemDefId, ItemId } from "../../../core/types/ids";
import type { World } from "../../../core/types/kernel";
import type { StepCtx } from "../../../core/types/pipeline";
import { registerPlannerDefaults } from "../../../planner/index";
import {
  BETTINA,
  FIELD,
  JAX,
  MARA,
  PRIYA,
  fieldConfig,
  fieldContent,
} from "../../field/fixtures/field-deck";
import { registerNeeds } from "../../needs/index";
import { registerSpatial } from "../../spatial/index";
import { spatialViolations } from "../../spatial/invariants";
import { fixtureEffectiveConfig } from "../../travel/fixtures";
import { registerWork } from "../../work/index";
import { type DamageResult, type Hit, applyDamage } from "../damage";
import { registerBodies } from "../index";

export { BETTINA, JAX, MARA, PRIYA };
export { ofType, runFor, runUntil, secondsOf } from "../../field/fixtures/field-deck";

export const BLASTER = "item.bodies.blaster" as ItemDefId;

const blasterDef: ItemDef = {
  id: BLASTER,
  name: "Blaster",
  stacking: "unique",
  maxStack: 1,
  tags: ["weapon"],
  toolKinds: [],
  mass: 1,
  weapon: {
    kind: "blaster",
    range: 8,
    aimSeconds: 1.2,
    hit: 0.55,
    severity: "serious",
    damageType: "blaster",
    stun: true,
  },
};

export function bodiesContent(): ContentBundle {
  const base = fieldContent(fieldConfig(), 9);
  return { ...base, items: { ...base.items, [BLASTER]: blasterDef }, hash: "bodies-deck-v1" };
}

export interface BodiesWorldOptions {
  readonly seed?: number;
  /** Over the default bundle's bodies config (`FIXTURE_BODIES`), e.g. faster healing. */
  readonly bodies?: Partial<ConfigDef["bodies"]>;
  /** A shorter ship's day, for tests that wait out healing and thoughts. Default 3600 s. */
  readonly daySeconds?: number;
}

/** Spatial, needs, bodies, work and the planner on the field fixture's ship, docked. */
export function bodiesWorld(options: BodiesWorldOptions = {}): TestWorld {
  const base = fieldConfig();
  const config: ConfigDef = {
    ...base,
    time: { ...base.time, daySeconds: options.daySeconds ?? base.time.daySeconds },
    bodies: { ...base.bodies, ...options.bodies },
  };
  const registry = createRegistry();
  registerSpatial(registry);
  registerNeeds(registry);
  registerBodies(registry);
  registerWork(registry);
  registerPlannerDefaults(registry);
  const kernel = createKernel(registry);
  const world = kernel.createWorld(
    FIELD.scenario,
    options.seed ?? 7,
    bodiesContent(),
    fixtureEffectiveConfig(config),
  );
  return { registry, kernel, world };
}

/** A step context on `world` for the coming tick, collecting what it emits. */
export function stepCtxOf(world: World): { ctx: StepCtx; drafts: EventDraft[] } {
  const drafts: EventDraft[] = [];
  const ctx = {
    state: world.state,
    caches: world.caches,
    content: world.content,
    defs: createDefLookup(world.content, world.state),
    config: world.config.values,
    rng: createRngApi(world.state),
    tick: world.state.tick + 1,
    elapsedTicks: 1,
    dirty: world.caches.dirty,
    emit: (draft: EventDraft) => {
      drafts.push(draft);
    },
  } satisfies StepCtx;
  return { ctx, drafts };
}

/** Wound `actorId` by hand, now (as of the coming tick). */
export function woundNow(
  world: World,
  actorId: ActorId,
  hit: Hit,
): { result: DamageResult; drafts: EventDraft[] } {
  const { ctx, drafts } = stepCtxOf(world);
  return { result: applyDamage(ctx, actorId, hit), drafts };
}

/** Put a blaster in `actorId`'s hands. */
export function handBlaster(world: World, actorId: ActorId): ItemId {
  const id = allocateId(world.state, "item");
  world.state.items[id] = {
    id,
    defId: BLASTER,
    stacking: "unique",
    condition: 1,
    location: { kind: "carriedBy", actorId },
  };
  world.caches.dirty.inventory = true;
  rebuildItemIndexes(world.state, world.caches.index);
  return id;
}

export function actorOf(world: World, id: ActorId): Actor {
  const actor = world.state.actors[id];
  if (actor === undefined) throw new Error(`no actor ${id}`);
  return actor;
}

/** Core, spatial and body invariants. */
export function bodiesWorldViolations(world: World): string[] {
  return [...checkInvariants(world.state), ...spatialViolations(world), ...bodyViolations(world)];
}
