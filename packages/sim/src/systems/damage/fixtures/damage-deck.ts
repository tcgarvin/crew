/**
 * W2 test fixture (slice 5): the slice-4 lounge deck with what damage response needs, and rocks
 * thrown by hand (`strike`) so the stream's tests never wait on the field (W1).
 *
 *   x 0123456789ABCDEFGHIJKL   rooms by column: A airlock 0-1, L lounge 2-8, Y gym 9-11,
 *   0 AALLLLLLLYYYQQQQKKKBBB   Q bunkroom 12-15, K captain's cabin 16-18, B bridge 19-21
 *
 * Added to the lounge deck: a workbench (11,0) in the gym, worked from (11,1); the welder torch in
 * the gym's stores (11,4); the captain's chair (19,0) on the bridge, sat at (19,1); two patch kits
 * in each of the five lockers (`kits: false` leaves them out); hull plating and patch kits sold at
 * the home port when `plating` and `kitStock` are given. Everything else (rooms, crew, interests, the 600 s day of two watches,
 * docked at the home port) is the lounge fixture's, except the bill: Red = Mara (captain, the
 * officer of the watch), Noor, Tomas (the engineer, engineering 5) and Bettina stand watch 0;
 * White = Jax and Dane watch 1.
 *
 * The world runs spatial, travel, needs, the watch, recreation, damage response, work (travel's
 * and damage's derivations) and the planner; no field system, so the field and the alert stay
 * as a test sets them.
 */
import type { TestWorld } from "../../../core/fixtures/test-world";
import { integrityFromScars } from "../../../core/hull";
import { allocateId } from "../../../core/ids";
import { createKernel } from "../../../core/kernel";
import { createRegistry } from "../../../core/registry";
import type { TileCoord } from "../../../core/types/common";
import type {
  ConfigDef,
  ContentBundle,
  ItemDef,
  MachineDef,
  RockSize,
  WatchBillDef,
} from "../../../core/types/content";
import type { EventDraft } from "../../../core/types/events";
import type {
  ActorId,
  CompartmentId,
  ItemDefId,
  MachineDefId,
  MachineId,
  ScarId,
} from "../../../core/types/ids";
import type { World } from "../../../core/types/kernel";
import type { ActiveField } from "../../../core/types/state";
import { compartmentByKey } from "../../../core/world";
import { registerPlannerDefaults } from "../../../planner/index";
import { registerNeeds } from "../../needs/index";
import {
  LOUNGE,
  loungeConfig,
  loungeContent,
  loungeStepCtx,
} from "../../recreation/fixtures/lounge-deck";
import { registerRecreation } from "../../recreation/index";
import { compartmentAt } from "../../spatial/geometry";
import { registerSpatial } from "../../spatial/index";
import { PORTS, fixtureEffectiveConfig } from "../../travel/fixtures";
import { registerTravel } from "../../travel/index";
import { travelTaskDerivations } from "../../travel/tasks";
import { registerWatch } from "../../watch/index";
import { writeFact } from "../../work/facts";
import { registerWork } from "../../work/index";
import { registerDamage } from "../index";
import { onImpact } from "../machines";
import { damageTaskDerivations } from "../tasks";

export const DAMAGE = {
  workbench: "machine.damage.workbench" as MachineDefId,
  chair: "machine.damage.chair" as MachineDefId,
  welder: "item.damage.welder_torch" as ItemDefId,
  kit: "item.damage.patch_kit" as ItemDefId,
  plating: "item.damage.hull_plating" as ItemDefId,
} as const;

export const BENCH_TILE: TileCoord = { x: 11, y: 0 };
export const BENCH_SEAT: TileCoord = { x: 11, y: 1 };
export const STORES: TileCoord = { x: 11, y: 4 };
export const CHAIR_SEAT: TileCoord = { x: 19, y: 1 };
export const LOUNGE_FLOOR: TileCoord = { x: 6, y: 2 };
export const LOCKER_TILES: readonly TileCoord[] = [12, 13, 14, 15]
  .map((x) => ({ x, y: 4 }))
  .concat([{ x: 18, y: 0 }]);

export const DAMAGE_BILL: WatchBillDef = {
  sections: [
    { key: "red", members: [LOUNGE.mara, LOUNGE.noor, LOUNGE.tomas, LOUNGE.bettina] },
    { key: "white", members: [LOUNGE.jax, LOUNGE.dane] },
  ],
  dayworkers: [],
};

const still = {
  power: { role: "none" },
  heat: { risePerSecond: 0, coolPerSecond: 0, derateAbove: 1 },
  operation: { requiresOperator: false },
  failure: { baseHazardPerSecond: 0, heatFactor: 0, wearPerSecond: 0 },
  faults: [],
  components: [],
} as const;

const MACHINES: Record<MachineDefId, MachineDef> = {
  [DAMAGE.workbench]: {
    id: DAMAGE.workbench,
    name: "Workbench",
    tags: ["workbench"],
    footprint: [{ x: 0, y: 0 }],
    interactionPositions: [
      { key: "bench", offset: { x: 0, y: 1 }, purposes: ["use", "repair"], capacity: 1 },
    ],
    ...still,
  },
  [DAMAGE.chair]: {
    id: DAMAGE.chair,
    name: "Captain's Chair",
    tags: ["chair"],
    footprint: [{ x: 0, y: 0 }],
    interactionPositions: [{ key: "seat", offset: { x: 0, y: 1 }, purposes: ["use"], capacity: 1 }],
    ...still,
  },
};

const ITEMS: Record<ItemDefId, ItemDef> = {
  [DAMAGE.welder]: {
    id: DAMAGE.welder,
    name: "Welder Torch",
    stacking: "unique",
    maxStack: 1,
    tags: ["tool"],
    toolKinds: ["welder"],
    mass: 3,
  },
  [DAMAGE.kit]: {
    id: DAMAGE.kit,
    name: "Patch Kit",
    stacking: "stackable",
    maxStack: 10,
    tags: ["consumable", "patchKit"],
    toolKinds: [],
    mass: 2,
  },
  [DAMAGE.plating]: {
    id: DAMAGE.plating,
    name: "Hull Plating",
    stacking: "stackable",
    maxStack: 5,
    tags: ["consumable", "plating"],
    toolKinds: [],
    mass: 12,
  },
};

export interface DamageContentOptions {
  /** Two patch kits in each locker (default true). */
  readonly kits?: boolean;
  /** Hull plating on the home port's market. */
  readonly plating?: { readonly count: number; readonly price: number };
  /** Patch kits on the home port's market (§plating-and-kits-at-port). */
  readonly kitStock?: { readonly count: number; readonly price: number };
}

export function damageContent(
  config: ConfigDef = loungeConfig(),
  options: DamageContentOptions = {},
): ContentBundle {
  const base = loungeContent(config, { bill: DAMAGE_BILL });
  const deck = base.decks[LOUNGE.deck];
  const scenario = base.scenarios[LOUNGE.scenario];
  const home = base.ports[PORTS.a];
  if (deck === undefined || scenario === undefined || home === undefined) {
    throw new Error("lounge fixture changed");
  }
  const lockers = deck.zones.filter((z) => z.tags.includes("locker")).map((z) => z.key);
  const kits =
    options.kits === false
      ? []
      : lockers.map((zoneKey) => ({ itemDefId: DAMAGE.kit, count: 2, zoneKey }));
  return {
    ...base,
    decks: {
      [LOUNGE.deck]: {
        ...deck,
        machines: [
          ...deck.machines,
          { key: "workbench", machineDefId: DAMAGE.workbench, origin: BENCH_TILE, rotation: 0 },
          { key: "chair", machineDefId: DAMAGE.chair, origin: { x: 19, y: 0 }, rotation: 0 },
        ],
        zones: [...deck.zones, { key: "stores", name: "Stores", tags: [], tiles: [STORES] }],
      },
    },
    machines: { ...base.machines, ...MACHINES },
    items: { ...base.items, ...ITEMS },
    ports: {
      ...base.ports,
      [PORTS.a]: {
        ...home,
        market:
          options.plating === undefined && options.kitStock === undefined
            ? home.market
            : [
                ...(options.plating === undefined
                  ? []
                  : [{ itemDefId: DAMAGE.plating, ...options.plating }]),
                ...(options.kitStock === undefined
                  ? []
                  : [{ itemDefId: DAMAGE.kit, ...options.kitStock }]),
              ],
      },
    },
    scenarios: {
      [LOUNGE.scenario]: {
        ...scenario,
        startingItems: [
          ...scenario.startingItems,
          { itemDefId: DAMAGE.welder, count: 1, zoneKey: "stores" },
          ...kits,
        ],
      },
    },
    hash: "damage-deck-v1",
  };
}

export interface DamageWorldOptions extends DamageContentOptions {
  readonly config?: ConfigDef;
  readonly seed?: number;
}

export function damageWorld(options: DamageWorldOptions = {}): TestWorld {
  const config = options.config ?? loungeConfig();
  const registry = createRegistry();
  registerSpatial(registry);
  registerTravel(registry);
  registerNeeds(registry);
  registerWatch(registry);
  registerRecreation(registry);
  registerDamage(registry);
  registerWork(registry, { derivations: { ...travelTaskDerivations, ...damageTaskDerivations } });
  registerPlannerDefaults(registry);
  const kernel = createKernel(registry);
  const world = kernel.createWorld(
    LOUNGE.scenario,
    options.seed ?? 5,
    damageContent(config, options),
    fixtureEffectiveConfig(config),
  );
  return { registry, kernel, world };
}

/** The compartment id of a room by key (throws for an unknown key). */
export function room(world: World, key: string): CompartmentId {
  const id = compartmentByKey(world.state, key as never);
  if (id === undefined) throw new Error(`no compartment ${key}`);
  return id;
}

/** The machine instance placed as `placementKey`. */
export function machineAt(world: World, placementKey: string): MachineId {
  const machine = Object.values(world.state.machines).find((m) => m.placementKey === placementKey);
  if (machine === undefined) throw new Error(`no machine placed as ${placementKey}`);
  return machine.id;
}

/** Sound the alert (what the field does when the helm sights rocks or the first one hits). */
export function soundAlert(world: World): void {
  world.state.alert = { sinceTick: world.state.tick, cause: "field", reports: {} };
}

/** The leg's field, made active if the test has none yet. */
function fieldOf(world: World): ActiveField {
  const state = world.state;
  if (state.field !== undefined) return state.field;
  const field: ActiveField = {
    id: allocateId(state, "field"),
    severity: "heavy",
    detection: "rolled",
    startsAtTick: state.tick,
    phase: { kind: "active", enteredTick: state.tick, endsAtProgress: 1 },
    impacts: 0,
    stuckImpacts: 0,
    hullLost: 0,
    scripted: [],
  };
  state.field = field;
  return field;
}

export interface Strike {
  readonly scarId: ScarId;
  readonly compartmentId: CompartmentId;
  readonly drafts: readonly EventDraft[];
}

/**
 * A rock on `tile`, as the field charges it: the hull loses `damage`, a scar on the tile, the
 * field's count and `lastImpactTick`, then damage response's `onImpact` (at the next tick's
 * context, like a system run).
 */
export function strike(
  world: World,
  tile: TileCoord,
  damage = 8,
  rock: RockSize = "large",
): Strike {
  const state = world.state;
  const geometry = world.caches.nav.decks[LOUNGE.deck];
  const compartmentId =
    geometry === undefined ? undefined : compartmentAt(geometry, tile.x, tile.y);
  if (compartmentId === undefined) throw new Error(`(${tile.x},${tile.y}) is in no compartment`);
  const field = fieldOf(world);
  const { ctx, drafts } = loungeStepCtx(world);
  const scarId = allocateId(state, "scar");
  state.hull.scars.push({
    id: scarId,
    fieldId: field.id,
    tile: { ...tile },
    compartmentId,
    rock,
    damage,
    recovered: 0,
    patched: false,
    tick: ctx.tick,
  });
  state.hull.integrity = integrityFromScars(state.hull);
  field.impacts += 1;
  field.hullLost += damage;
  field.lastImpactTick = ctx.tick;
  onImpact(ctx, {
    fieldId: field.id,
    scarId,
    compartmentId,
    tile,
    tiles: [tile],
  });
  return { scarId, compartmentId, drafts };
}

/**
 * What the intercom (W3) does, for these tests: every crew member aboard hears of every open
 * damage problem, as `report` evidence from `fromId`.
 */
export function broadcastDamage(world: World, fromId: ActorId): void {
  const source = {
    tick: world.state.tick,
    sourceId: fromId,
    evidence: "report",
    certainty: "reported",
  } as const;
  for (const problem of Object.values(world.state.work.problems)) {
    if (problem.owner !== "damage" || problem.status !== "open") continue;
    for (const actor of Object.values(world.state.actors)) {
      if (!actor.crew || actor.passenger === true) continue;
      const value = { problemId: problem.id, revision: problem.revision };
      writeFact(actor, problem.id, "problem", value, source);
    }
  }
}
