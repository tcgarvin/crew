import type { TestWorld } from "../../core/fixtures/test-world";
/**
 * W3 test fixture (§reporting-damage): the galley fixture's ship
 * (`systems/galley/fixtures/galley-deck.ts`) with an intercom panel in each of its five rooms, and
 * helpers that stand in for the field and damage response, which are other streams': sounding the
 * alert, and damage raised by hand as the problems damage raises (`machineDamaged`, `hullScar`,
 * discovered).
 *
 *   x 0123456789ABCDEFG
 *   0 LLiSGIMssMMbbbBBB    i, I, … = panels; each is worked from the tile below it:
 *   1 LgLucGMTTMIeeeB@H    airlock (2,0)→(2,1), galley (5,0)→(5,1), mess (10,1)→(10,2),
 *   2 LLLGGGMssMMbbIBjv    bunkroom (13,2)→(13,3), bridge (15,2)→(15,3)
 *   3 LoLGPPMMMfReeQBBB
 *
 * Crew and the bill are the galley fixture's: a1 Bettina (cook), a2 Noor, a3 Mara (captain),
 * a4 Jax, a5 Tomas (engineer).
 */
import { allocateId } from "../../core/ids";
import { createKernel } from "../../core/kernel";
import { createRegistry } from "../../core/registry";
import type { TileCoord } from "../../core/types/common";
import type { ConfigDef, ContentBundle, MachineDef } from "../../core/types/content";
import type { CompartmentId, MachineDefId, MachineId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import type { HullScar } from "../../core/types/state";
import type { Problem } from "../../core/types/work";
import { registerPlannerDefaults } from "../../planner/index";
import { registerDamage } from "../damage/index";
import { damageTaskDerivations } from "../damage/tasks";
import { GALLEY, galleyConfig, galleyContent } from "../galley/fixtures/galley-deck";
import { registerGalley } from "../galley/index";
import { galleyTaskDerivations } from "../galley/tasks";
import { registerNeeds } from "../needs/index";
import { compartmentAt } from "../spatial/geometry";
import { registerSpatial } from "../spatial/index";
import { fixtureEffectiveConfig } from "../travel/fixtures";
import { registerTravel } from "../travel/index";
import { travelTaskDerivations } from "../travel/tasks";
import { registerWatch } from "../watch/index";
import { registerWork } from "../work/index";
import { registerIntercom } from "./index";

export const PANEL_DEF = "machine.intercom.test" as MachineDefId;

/** Each room's panel: where it is mounted and the tile it is worked from. */
export const PANELS = {
  airlock: { origin: { x: 2, y: 0 }, operate: { x: 2, y: 1 } },
  galley: { origin: { x: 5, y: 0 }, operate: { x: 5, y: 1 } },
  mess: { origin: { x: 10, y: 1 }, operate: { x: 10, y: 2 } },
  quarters: { origin: { x: 13, y: 2 }, operate: { x: 13, y: 3 } },
  bridge: { origin: { x: 15, y: 2 }, operate: { x: 15, y: 3 } },
} as const satisfies Record<string, { origin: TileCoord; operate: TileCoord }>;

export type Room = keyof typeof PANELS;

const PANEL: MachineDef = {
  id: PANEL_DEF,
  name: "Intercom",
  tags: ["comm"],
  footprint: [{ x: 0, y: 0 }],
  interactionPositions: [
    { key: "panel", offset: { x: 0, y: 1 }, purposes: ["operate"], capacity: 1 },
  ],
  power: { role: "none" },
  heat: { risePerSecond: 0, coolPerSecond: 0, derateAbove: 1 },
  operation: { requiresOperator: false },
  failure: { baseHazardPerSecond: 0, heatFactor: 0, wearPerSecond: 0 },
  faults: [],
  components: [],
};

export function intercomContent(config: ConfigDef = galleyConfig()): ContentBundle {
  const base = galleyContent(config);
  const deck = base.decks[GALLEY.deck];
  if (deck === undefined) throw new Error("galley fixture changed: no deck");
  return {
    ...base,
    decks: {
      [GALLEY.deck]: {
        ...deck,
        machines: [
          ...deck.machines,
          ...Object.entries(PANELS).map(([room, { origin }]) => ({
            key: `intercom_${room}`,
            machineDefId: PANEL_DEF,
            origin,
            rotation: 0 as const,
          })),
        ],
      },
    },
    machines: { ...base.machines, [PANEL_DEF]: PANEL },
    hash: "intercom-deck-v1",
  };
}

/**
 * Spatial, travel, needs, the watch, the galley, damage response (gate stubs until W2), the
 * intercom, work and the planner. No field: tests sound the alert and raise damage by hand.
 */
export function intercomWorld(seed = 5): TestWorld {
  const config = galleyConfig();
  const registry = createRegistry();
  registerSpatial(registry);
  registerTravel(registry);
  registerNeeds(registry);
  registerWatch(registry);
  registerGalley(registry);
  registerDamage(registry);
  registerIntercom(registry);
  registerWork(registry, {
    derivations: { ...travelTaskDerivations, ...galleyTaskDerivations, ...damageTaskDerivations },
  });
  registerPlannerDefaults(registry);
  const kernel = createKernel(registry);
  const world = kernel.createWorld(
    GALLEY.scenario,
    seed,
    intercomContent(config),
    fixtureEffectiveConfig(config),
  );
  return { registry, kernel, world };
}

/** The panel in `room`. */
export function panelIn(world: World, room: Room): MachineId {
  const panel = Object.values(world.state.machines).find(
    (m) => m.placementKey === `intercom_${room}`,
  );
  if (panel === undefined) throw new Error(`no panel in ${room}`);
  return panel.id;
}

/** The machine placed as `key` (e.g. the galley's `stove`). */
export function machineByKey(world: World, key: string): MachineId {
  const machine = Object.values(world.state.machines).find((m) => m.placementKey === key);
  if (machine === undefined) throw new Error(`no machine ${key}`);
  return machine.id;
}

/** The compartment `room` (the one its panel is mounted in). */
export function compartmentOf(world: World, room: Room): CompartmentId {
  const geometry = world.caches.nav.decks[GALLEY.deck];
  const { x, y } = PANELS[room].origin;
  const id = geometry === undefined ? undefined : compartmentAt(geometry, x + 0.5, y + 0.5);
  if (id === undefined) throw new Error(`no compartment ${room}`);
  return id;
}

/** The klaxon: the ship goes on alert now (the field system's job, W1). */
export function soundAlert(world: World): void {
  world.state.alert = { sinceTick: world.state.tick, cause: "field", reports: {} };
}

/** Kill a machine outright: dead to the eye (no output) and below the inoperable integrity. */
export function knockOut(world: World, machineId: MachineId): void {
  const machine = world.state.machines[machineId];
  if (machine === undefined) throw new Error(`no machine ${machineId}`);
  machine.integrity = 0;
  machine.output = 0;
}

function addProblem(world: World, problem: Omit<Problem, "id">): Problem {
  const id = allocateId(world.state, "problem");
  const raised = { ...problem, id } as Problem;
  world.state.work.problems[id] = raised;
  return raised;
}

/** A rock took `machineId` out: as damage response raises it (W2), discovered and essential. */
export function damageMachineByHand(world: World, machineId: MachineId): Problem {
  knockOut(world, machineId);
  return addProblem(world, {
    kind: "machineDamaged",
    payload: { machineId },
    owner: "damage",
    visibility: "discovered",
    dedupeKey: `machineDamaged:${machineId}`,
    status: "open",
    createdTick: world.state.tick,
    revision: 0,
    baseUrgency: "essentialOperation",
    location: { kind: "machine", machineId },
  } as Omit<Problem, "id">);
}

/** A small rock's scar at `tile` in `room`, charged to the hull, and its `hullScar` problem. */
export function scarByHand(world: World, room: Room, tile: TileCoord): Problem {
  const compartmentId = compartmentOf(world, room);
  const scar: HullScar = {
    id: allocateId(world.state, "scar"),
    fieldId: allocateId(world.state, "field"),
    tile,
    compartmentId,
    rock: "small",
    damage: 3,
    recovered: 0,
    patched: false,
    tick: world.state.tick,
  };
  world.state.hull.scars.push(scar);
  world.state.hull.integrity -= scar.damage;
  return addProblem(world, {
    kind: "hullScar",
    payload: { scarId: scar.id, compartmentId, tile },
    owner: "damage",
    visibility: "discovered",
    dedupeKey: `hullScar:${scar.id}`,
    status: "open",
    createdTick: world.state.tick,
    revision: 0,
    baseUrgency: "essentialOperation",
    location: { kind: "compartment", compartmentId },
  } as Omit<Problem, "id">);
}
