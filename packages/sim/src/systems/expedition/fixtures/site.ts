/**
 * Expeditions A1 test fixture: the dockside world (`travel/fixtures-dock.ts`: the 12×8 crew deck
 * with two south ramps, docked at `TINY.port` with the spike's quay alongside) plus a landing
 * site, `SITE.port` near `TINY.port`, whose map is the same quay of `kind: "site"` with site posts
 * and a default cast, and a blaster and a baton in content. Bodies and the expedition are
 * registered beside spatial, travel, needs, work and the planner, as in the hosts.
 *
 * The site's posts, dock frame (deck = dock − (2,1)):
 *
 *   dx 0123456789ABCDEF
 *    8 ...............x   x = exit (15,8)
 *    9 ...b........g...   b = bystander (3,9); g = guard (12,9)
 *   10 f.....ccc.....g.   f = flank (0,10); g = second guard (14,10); ccc = crates (cover)
 *   11 ...........l.t..   l = loot (11,11); t = target (13,11)
 *
 * The real Boathouse lives in `@crew/content`, which the kernel's tests cannot import (`sim` has no
 * dependency on it, and its JSON sits outside this package's `rootDir`).
 */
import type { TestWorld } from "../../../core/fixtures/test-world";
import { TINY, tinyEffectiveConfig } from "../../../core/fixtures/tiny-content";
import { createKernel } from "../../../core/kernel";
import { createRegistry } from "../../../core/registry";
import type { Command } from "../../../core/types/commands";
import type {
  ConfigDef,
  ContentBundle,
  DockDef,
  ItemDef,
  MachineDef,
  PortDef,
  SiteCastEntryDef,
} from "../../../core/types/content";
import type {
  CommandId,
  DockDefId,
  ItemDefId,
  MachineDefId,
  PortDefId,
  ScenarioDefId,
} from "../../../core/types/ids";
import { registerPlannerDefaults } from "../../../planner/index";
import { registerBodies } from "../../bodies/index";
import { registerNeeds } from "../../needs/index";
import { QUAY } from "../../spatial/fixtures/dock";
import { registerSpatial } from "../../spatial/index";
import { docksideConfig, docksideContent } from "../../travel/fixtures-dock";
import { registerTravel } from "../../travel/index";
import { ALL_DERIVATIONS, CREW } from "../../work/fixtures/crew-deck";
import { registerWork } from "../../work/index";
import type { DamageFn } from "../combat";
import { registerExpedition } from "../index";
import { testDamage } from "./damage";

export const SITE = {
  port: "port.test.site" as PortDefId,
  dock: "dock.test.site" as DockDefId,
  blaster: "item.test.blaster" as ItemDefId,
  baton: "item.test.baton" as ItemDefId,
  locker: "machine.test.arms_locker" as MachineDefId,
  /** The arms locker on the crew deck's corridor, and the tile it is used from. */
  lockerTile: { x: 4, y: 5 },
  lockerUse: { x: 4, y: 6 },
} as const;

export const SITE_CAST: readonly SiteCastEntryDef[] = [
  {
    name: "Corran Vale",
    role: "keeper",
    look: "grey and wiry",
    part: "target",
    arms: "none",
    resolve: "steady",
    tie: "bound",
    wants: "out",
    post: "target",
  },
  {
    name: "Hesk Marrow",
    role: "hired hand",
    look: "big and bored",
    part: "guard",
    arms: "blaster",
    resolve: "steady",
    tie: "paid",
    wants: "money",
    post: "guard_east",
  },
  {
    name: "Darrow Finch",
    role: "nephew",
    look: "young",
    part: "guard",
    arms: "melee",
    resolve: "shaky",
    tie: "bound",
    wants: "out",
    post: "guard_far",
  },
  {
    name: "Old Pell",
    role: "net mender",
    look: "deaf, or pretending",
    part: "bystander",
    arms: "none",
    resolve: "shaky",
    tie: "paid",
    wants: "nothing",
    post: "bench",
  },
];

const SITE_DOCK: DockDef = {
  ...QUAY,
  id: SITE.dock,
  portId: SITE.port,
  name: "Test site",
  kind: "site",
  noticeRadius: 4,
  posts: [
    { key: "exit", kind: "exit", name: "the slipway", tile: { x: 15, y: 8 }, facing: "s" },
    { key: "bench", kind: "bystander", name: "the bench", tile: { x: 3, y: 9 }, facing: "n" },
    { key: "guard_east", kind: "guard", name: "the east end", tile: { x: 12, y: 9 }, facing: "w" },
    { key: "guard_far", kind: "guard", name: "the far end", tile: { x: 14, y: 10 }, facing: "w" },
    { key: "flank", kind: "flank", name: "the west end", tile: { x: 0, y: 10 }, facing: "e" },
    { key: "loot", kind: "loot", name: "the shelf", tile: { x: 11, y: 11 }, facing: "n" },
    { key: "target", kind: "target", name: "the bench", tile: { x: 13, y: 11 }, facing: "n" },
  ],
  defaultCast: SITE_CAST,
};

const SITE_PORT: PortDef = {
  id: SITE.port,
  name: "The Test Site",
  setting: "station",
  kind: "site",
  nearPortId: TINY.port,
  description: "A site.",
  character: "A site.",
  castSeed: [],
  externalStores: [],
  market: [],
  jobTemplates: [],
  routes: [{ toPortId: TINY.port, distance: 10 }],
};

const weapon = (id: ItemDefId, kind: "blaster" | "baton"): ItemDef => ({
  id,
  name: kind === "blaster" ? "Blaster" : "Baton",
  stacking: "unique",
  maxStack: 1,
  tags: ["weapon"],
  toolKinds: [],
  mass: 1,
  weapon:
    kind === "blaster"
      ? {
          kind,
          range: 8,
          aimSeconds: 1.2,
          hit: 0.55,
          severity: "serious",
          damageType: "blaster",
          stun: true,
        }
      : {
          kind,
          range: 1,
          aimSeconds: 0.6,
          hit: 0.7,
          severity: "serious",
          damageType: "blunt",
          stun: false,
        },
});

const LOCKER: MachineDef = {
  id: SITE.locker,
  name: "Arms Locker",
  tags: ["armsLocker"],
  footprint: [{ x: 0, y: 0 }],
  interactionPositions: [{ key: "use", offset: { x: 0, y: 1 }, purposes: ["use"], capacity: 1 }],
  power: { role: "none" },
  heat: { risePerSecond: 0, coolPerSecond: 0, derateAbove: 1 },
  operation: { requiresOperator: false },
  failure: { baseHazardPerSecond: 0, heatFactor: 0, wearPerSecond: 0 },
  faults: [],
  components: [],
};

/** The crew deck with the arms locker, and both crew scenarios with three blasters and two batons. */
function armed(base: ContentBundle): Pick<ContentBundle, "decks" | "scenarios"> {
  const decks = Object.fromEntries(
    Object.entries(base.decks).map(([id, deck]) => [
      id,
      {
        ...deck,
        machines: [
          ...deck.machines,
          { key: "arms_locker", machineDefId: SITE.locker, origin: SITE.lockerTile, rotation: 0 },
        ],
        zones: [
          ...deck.zones,
          {
            key: "arms",
            name: "Arms locker",
            tags: ["armsLocker"],
            tiles: [SITE.lockerTile],
            machineKey: "arms_locker",
          },
        ],
      },
    ]),
  ) as ContentBundle["decks"];
  const scenarios = Object.fromEntries(
    Object.entries(base.scenarios).map(([id, scenario]) => [
      id,
      {
        ...scenario,
        startingItems: [
          ...scenario.startingItems,
          { itemDefId: SITE.blaster, count: 3, zoneKey: "arms" },
          { itemDefId: SITE.baton, count: 2, zoneKey: "arms" },
        ],
      },
    ]),
  ) as ContentBundle["scenarios"];
  return { decks, scenarios };
}

export function siteContent(config: ConfigDef = docksideConfig()): ContentBundle {
  const base = docksideContent(config);
  return {
    ...base,
    ...armed(base),
    machines: { ...base.machines, [SITE.locker]: LOCKER },
    ports: { ...base.ports, [SITE.port]: SITE_PORT },
    docks: { ...base.docks, [SITE.dock]: SITE_DOCK },
    items: {
      ...base.items,
      [SITE.blaster]: weapon(SITE.blaster, "blaster"),
      [SITE.baton]: weapon(SITE.baton, "baton"),
    },
    hash: "site-v1",
  };
}

export interface SiteWorldOptions {
  readonly config?: ConfigDef;
  /** Crew of two (Mara and Jon, the default) or of eight. */
  readonly scenario?: ScenarioDefId;
  readonly seed?: number;
  /** The damage entry point; the test double (`fixtures/damage.ts`) unless given. */
  readonly applyDamage?: DamageFn;
}

/**
 * The dockside world with the site in content, bodies and the expedition registered (the
 * expedition with the damage double until W1's `applyDamage` lands).
 */
export function siteWorld(opts: SiteWorldOptions = {}): TestWorld {
  const config = opts.config ?? docksideConfig();
  const registry = createRegistry();
  registerSpatial(registry);
  registerTravel(registry);
  registerNeeds(registry);
  registerBodies(registry);
  registerExpedition(registry, { applyDamage: opts.applyDamage ?? testDamage });
  registerWork(registry, { derivations: ALL_DERIVATIONS });
  registerPlannerDefaults(registry);
  const kernel = createKernel(registry);
  const world = kernel.createWorld(
    opts.scenario ?? CREW.scenario2,
    opts.seed ?? 11,
    siteContent(config),
    tinyEffectiveConfig(config),
  );
  return { registry, kernel, world };
}

let n = 0;

/** Enqueue `command` as the scenario. */
export function send(test: TestWorld, command: Omit<Command, "id" | "source">) {
  n += 1;
  return test.kernel.enqueueCommand(test.world, {
    ...command,
    id: `cmd:site:${n}` as CommandId,
    source: "scenario",
  } as Command);
}
