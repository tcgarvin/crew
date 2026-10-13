/**
 * Medicine test fixture (§medicine): the bodies fixture's four-room ship
 * (`systems/bodies/fixtures/bodies-deck.ts`) docked at Alpha, with a medbay bed in the hold, med
 * kits in the stowage zone and medical skills on the crew. Spatial, needs, bodies, medical, work
 * (the wounded problem's derivation only) and the planner run; nothing hurts anyone but a test
 * (`woundNow`).
 *
 *   x 0123456789ABCDEF
 *   0 LLLMbHHHHEEEBNBB     M = medbay bed (3,0); b = bedside, its `use` position (4,0)
 *   1 LLLHHHHHHEEEBBBB
 *   2 rgLHHHHHHEXEBB@H
 *   3 LLLHHHHHHEEEBBBv
 *   4 LLLHHHHkHEEEBBBB     k = the kits' stowage tile (7,4)
 *
 * Crew, in actor order: a1 Jax (medical 1), a2 Mara (captain, medical 1), a3 Priya (medical 1),
 * a4 Bettina (medical 6, the ship's medic).
 */
import type { TestWorld } from "../../../core/fixtures/test-world";
import { createKernel } from "../../../core/kernel";
import { createRegistry } from "../../../core/registry";
import type { TileCoord } from "../../../core/types/common";
import type {
  ConfigDef,
  ContentBundle,
  ItemDef,
  MachineDef,
  ScenarioDef,
} from "../../../core/types/content";
import type { CrewDefId, ItemDefId, MachineDefId } from "../../../core/types/ids";
import type { World } from "../../../core/types/kernel";
import type { ProblemOfKind } from "../../../core/types/work";
import { registerPlannerDefaults } from "../../../planner/index";
import { BETTINA, bodiesContent } from "../../bodies/fixtures/bodies-deck";
import { registerBodies } from "../../bodies/index";
import { FIELD, fieldConfig } from "../../field/fixtures/field-deck";
import { registerNeeds } from "../../needs/index";
import { registerSpatial } from "../../spatial/index";
import { PORTS, fixtureEffectiveConfig } from "../../travel/fixtures";
import { registerWork } from "../../work/index";
import { registerMedical } from "../index";
import { medicalTaskDerivations } from "../tasks";

export { BETTINA };
export {
  JAX,
  MARA,
  PRIYA,
  actorOf,
  bodiesWorldViolations,
  stepCtxOf,
  woundNow,
} from "../../bodies/fixtures/bodies-deck";
export { ofType, runFor, runUntil, secondsOf } from "../../field/fixtures/field-deck";

export const MEDICAL = {
  bed: "machine.medical.bed" as MachineDefId,
  kit: "item.medical.kit" as ItemDefId,
} as const;

export const BED_TILE: TileCoord = { x: 3, y: 0 };
export const BEDSIDE: TileCoord = { x: 4, y: 0 };
export const KIT_TILE: TileCoord = { x: 7, y: 4 };

const bedDef: MachineDef = {
  id: MEDICAL.bed,
  name: "Medbay Bed",
  tags: ["medBed"],
  footprint: [{ x: 0, y: 0 }],
  interactionPositions: [
    { key: "bedside", offset: { x: 1, y: 0 }, purposes: ["use"], capacity: 1 },
  ],
  power: { role: "none" },
  heat: { risePerSecond: 0, coolPerSecond: 0, derateAbove: 1 },
  operation: { requiresOperator: false },
  failure: { baseHazardPerSecond: 0, heatFactor: 0, wearPerSecond: 0 },
  faults: [],
  components: [],
};

const kitDef: ItemDef = {
  id: MEDICAL.kit,
  name: "Med Kit",
  stacking: "stackable",
  maxStack: 5,
  tags: ["medical", "consumable"],
  toolKinds: [],
  mass: 1,
};

const MEDICAL_SKILL: Readonly<Record<CrewDefId, number>> = {
  [FIELD.jax]: 1,
  [FIELD.mara]: 1,
  [FIELD.priya]: 1,
  [FIELD.bettina]: 6,
};

export interface MedicalWorldOptions {
  /** Med kits stowed at `KIT_TILE` (default 3; 0 for none). */
  readonly kits?: number;
  /** Put the medbay bed in the hold (default true). */
  readonly bed?: boolean;
  /** Med kits the market at Alpha sells. */
  readonly kitStock?: { readonly count: number; readonly price: number };
  readonly medical?: Partial<ConfigDef["medical"]>;
}

export function medicalContent(options: MedicalWorldOptions = {}): ContentBundle {
  const base = bodiesContent();
  const deck = base.decks[FIELD.deck];
  const scenario: ScenarioDef | undefined = base.scenarios[FIELD.scenario];
  const alpha = base.ports[PORTS.a];
  if (deck === undefined || scenario === undefined || alpha === undefined) {
    throw new Error("bodies fixture changed");
  }
  const kits = options.kits ?? 3;
  const bed = { key: "medbed", machineDefId: MEDICAL.bed, origin: BED_TILE, rotation: 0 as const };
  const crew = Object.fromEntries(
    Object.entries(base.crew).map(([id, def]) => [
      id,
      { ...def, skills: { ...def.skills, medical: MEDICAL_SKILL[id as CrewDefId] ?? 0 } },
    ]),
  );
  return {
    ...base,
    decks: {
      ...base.decks,
      [FIELD.deck]: {
        ...deck,
        machines: options.bed === false ? deck.machines : [...deck.machines, bed],
      },
    },
    machines: { ...base.machines, [MEDICAL.bed]: bedDef },
    items: { ...base.items, [MEDICAL.kit]: kitDef },
    crew,
    ports: {
      ...base.ports,
      [PORTS.a]: {
        ...alpha,
        market:
          options.kitStock === undefined
            ? alpha.market
            : [...alpha.market, { itemDefId: MEDICAL.kit, ...options.kitStock }],
      },
    },
    scenarios: {
      [FIELD.scenario]: {
        ...scenario,
        startingItems:
          kits === 0 ? [] : [{ itemDefId: MEDICAL.kit, count: kits, zoneKey: "stowage" }],
      },
    },
    hash: "medical-deck-v1",
  };
}

/** Spatial, needs, bodies, medical, work and the planner on the bodies fixture's ship, docked. */
export function medicalWorld(options: MedicalWorldOptions = {}): TestWorld {
  const base = fieldConfig();
  const config: ConfigDef = { ...base, medical: { ...base.medical, ...options.medical } };
  const registry = createRegistry();
  registerSpatial(registry);
  registerNeeds(registry);
  registerBodies(registry);
  registerMedical(registry);
  registerWork(registry, { derivations: medicalTaskDerivations });
  registerPlannerDefaults(registry);
  const kernel = createKernel(registry);
  const world = kernel.createWorld(
    FIELD.scenario,
    7,
    medicalContent(options),
    fixtureEffectiveConfig(config),
  );
  return { registry, kernel, world };
}

/** `medical` units aboard (on the floor or in hand). */
export function kitsAboard(world: World): number {
  return Object.values(world.state.items)
    .filter((i) => i.defId === MEDICAL.kit && i.location.kind !== "inExternalStore")
    .reduce((n, i) => n + (i.stacking === "stack" ? i.count : 1), 0);
}

/** Every `crewWounded` problem, any status. */
export function woundedProblems(world: World): ProblemOfKind<"crewWounded">[] {
  return Object.values(world.state.work.problems).filter(
    (p): p is ProblemOfKind<"crewWounded"> => p.kind === "crewWounded",
  );
}
