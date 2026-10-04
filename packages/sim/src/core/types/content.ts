/**
 * Content definition interfaces (review §B: sim owns the interfaces it consumes; `packages/content`
 * owns Zod schemas asserted against them with `satisfies z.ZodType<Def>`).
 *
 * Definitions are static, immutable data. The kernel reads them through `World.content` and
 * never writes them. Per-game generated definitions live in `WorldState.defs.dynamic` and use the
 * same interfaces.
 *
 * Units: durations in seconds, speeds in tiles/second, power in kW, energy in kJ, heat in
 * normalised units where 1.0 is the machine's failure temperature. The kernel converts seconds
 * to ticks with ceil.
 */
import type { EdgeSide, Rotation, Seconds, TileCoord, TileEdge } from "./common";
import type {
  CrewDefId,
  DeckDefId,
  DockDefId,
  ItemDefId,
  LocalKey,
  MachineDefId,
  PortDefId,
  ScenarioDefId,
  TraitDefId,
} from "./ids";

// ---------------------------------------------------------------------------------------------
// Shared vocabularies (closed enums the kernel branches on)
// ---------------------------------------------------------------------------------------------

/** W0 decision: skills are a closed V1 set; adding one is a code change, not content. */
export const SKILLS = [
  "engineering",
  "electrical",
  "piloting",
  "cargo",
  "medical",
  "cooking",
] as const;
export type SkillId = (typeof SKILLS)[number];

/** W0 decision: skill levels are numbers in [0, 10]; an absent skill means 0. */
export type SkillLevels = Readonly<Partial<Record<SkillId, number>>>;

export const ROLE_TAGS = [
  "captain",
  "firstOfficer",
  "engineer",
  "pilot",
  "deckhand",
  "cook",
  "medic",
] as const;
export type RoleTag = (typeof ROLE_TAGS)[number];

/** Item behaviour tags. `tool` items are reusable; `consumable` ones are removed at the commit point. */
export const ITEM_TAGS = [
  "tool",
  "consumable",
  "food",
  "spare",
  "cargo",
  "medical",
  "container",
  /** Ship life §7: someone's own belongings; `UniqueItem.ownerId` says whose. */
  "personal",
] as const;
export type ItemTag = (typeof ITEM_TAGS)[number];

/** What a tool is good for. Recipes ask for a tool kind, not a specific item def. */
export const TOOL_KINDS = [
  "wrench",
  "multimeter",
  "welder",
  "diagnosticScanner",
  "handTruck",
] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

/** D47: the narrator's coarse price lever for `stockMarket`; `config.commerce.market.priceTiers` maps it. */
export const MARKET_PRICE_TIERS = ["cheap", "fair", "dear"] as const;
export type MarketPriceTier = (typeof MARKET_PRICE_TIERS)[number];

/** Cargo pricing class; `config.commerce.priceBands` is keyed by this. */
export const CARGO_CLASSES = ["general", "fragile", "perishable", "hazardous"] as const;
export type CargoClass = (typeof CARGO_CLASSES)[number];

/** Machine behaviour tags the planner/systems branch on (a bed is where you sleep, etc.). */
export const MACHINE_TAGS = [
  "bed",
  /** Ship life §7: the infirmary's bed; a place to be treated, never a sleep target. */
  "medBed",
  "stove",
  "messTable",
  "pilotStation",
  "navStation",
  "opsStation",
  "chair",
  "desk",
  "gamesTable",
  "vidScreen",
  "exerciseRig",
  "workbench",
  "console",
  "engine",
  "generator",
  "battery",
  "lifeSupport",
  "cooling",
  "rampControl",
] as const;
export type MachineTag = (typeof MACHINE_TAGS)[number];

/** Power allocation priority (SD §9.3); lower index = served first. */
export const POWER_PRIORITIES = [
  "lifeSupport",
  "criticalCooling",
  "propulsion",
  "domestic",
  "cargo",
] as const;
export type PowerPriority = (typeof POWER_PRIORITIES)[number];

/** Recipe step action kinds. Must be a subset of `ActionKind` (see work.ts). */
export const RECIPE_ACTIONS = [
  "inspect",
  "diagnose",
  "repair",
  "removeComponent",
  "installComponent",
  "test",
] as const;
export type RecipeActionKind = (typeof RECIPE_ACTIONS)[number];

/** How a symptom can be noticed (SD §13.2). */
export type SymptomChannel = "visual" | "audible" | "sensor";

// ---------------------------------------------------------------------------------------------
// Deck
// ---------------------------------------------------------------------------------------------

/**
 * D72: hull size classes. A deck fits inside its class box; a dock's berth is a class box, so any
 * ship of that class or smaller docks there (ship life §10).
 */
export const HULL_SIZE_CLASSES = ["S", "M", "L"] as const;
export type HullSizeClass = (typeof HULL_SIZE_CLASSES)[number];

/** D72: the box (width × height, tiles) each size class fits inside. */
export const HULL_SIZE_BOX: Readonly<
  Record<HullSizeClass, { readonly w: number; readonly h: number }>
> = {
  S: { w: 24, h: 14 },
  M: { w: 36, h: 20 },
  L: { w: 40, h: 24 },
};

/**
 * D72: what kind of hull a deck is. Orientation is not a field: the bow is always east (high x)
 * and the ramps always open on the south hull edge, which content validation enforces.
 */
export interface HullDef {
  /** Informational: "light_freighter". */
  readonly class: string;
  readonly sizeClass: HullSizeClass;
}

/**
 * One authored deck (SD §6.2–6.4). Geometry is static; dynamic per-tile state lives sparsely in
 * `WorldState.deck`.
 *
 * W0 decision: tiles are compact string rows. Each character is a compartment `symbol`
 * (declared in `compartments`) or a space for non-navigable void. Walls are implicit on every
 * edge between two different compartments and between floor and void (hull). Only doors,
 * openings (doorless gaps between compartments) and extra interior walls are listed explicitly.
 */
export interface DeckDef {
  readonly id: DeckDefId;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** `height` strings of exactly `width` characters. */
  readonly tiles: readonly string[];
  readonly compartments: readonly CompartmentDef[];
  readonly doors: readonly DoorPlacementDef[];
  /** Doorless passable gaps across an otherwise implicit compartment wall. */
  readonly openings: readonly TileEdge[];
  /** Extra walls inside a compartment. */
  readonly walls: readonly TileEdge[];
  readonly machines: readonly MachinePlacementDef[];
  readonly powerDomains: readonly PowerDomainDef[];
  /** Named floor regions: cargo stowage, galley counter, muster points. */
  readonly zones: readonly ZoneDef[];
  readonly docking: DockingInterfaceDef;
  readonly spawnPoints: readonly SpawnPointDef[];
  readonly hull: HullDef;
}

export interface CompartmentDef {
  readonly key: LocalKey;
  /** Single character used in `DeckDef.tiles`; must not be a space. */
  readonly symbol: string;
  readonly name: string;
  /** Semantic tags (`cargoHold`, `galley`, `quarters`, `bridge`, `engineering`). Tags alone grant no function. */
  readonly tags: readonly string[];
}

export interface DoorPlacementDef {
  readonly key: LocalKey;
  readonly edge: TileEdge;
  /** W0 decision: ramps are doors on a hull edge with kind `ramp`; they share the door state machine. */
  readonly kind: "interior" | "ramp";
  /** Power domain key driving the actuator; absent = unpowered (manual only). */
  readonly powerDomain?: LocalKey;
  readonly manualOperationSupported: boolean;
  readonly initialState: "open" | "closed";
}

export interface MachinePlacementDef {
  /** Unique within the deck; instances record it as `placementKey`. */
  readonly key: LocalKey;
  readonly machineDefId: MachineDefId;
  /** Tile the def's footprint offset (0,0) maps to. */
  readonly origin: TileCoord;
  readonly rotation: Rotation;
  readonly powerDomain?: LocalKey;
}

export interface PowerDomainDef {
  readonly key: LocalKey;
  readonly name: string;
}

export interface ZoneDef {
  readonly key: LocalKey;
  readonly name: string;
  /** e.g. `cargoStowage`, `muster`, `boarding`. */
  readonly tags: readonly string[];
  readonly tiles: readonly TileCoord[];
  /** The machine placement this zone serves (a `locker` names its bed). */
  readonly machineKey?: LocalKey;
}

/**
 * The ship's interface to a port when docked (SD §17.2). Cargo moves between a port external
 * store and the ship only across a ramp door that is open.
 */
export interface DockingInterfaceDef {
  readonly cargoRampDoorKey: LocalKey;
  readonly personnelRampDoorKey: LocalKey;
  /** Floor tiles just inside each ramp, where transferred items/people appear or leave. */
  readonly cargoTransferTiles: readonly TileCoord[];
  readonly personnelTransferTiles: readonly TileCoord[];
}

// ---------------------------------------------------------------------------------------------
// Dock maps (Dockside §3, docs/design/dockside.md)
// ---------------------------------------------------------------------------------------------

/** What a dock map tile is. Only `floor` is walkable, and only where no blocking prop stands. */
export const DOCK_TILE_KINDS = ["floor", "wall", "void"] as const;
export type DockTileKind = (typeof DOCK_TILE_KINDS)[number];

/** Where a local stands. The gate and warehouse door are the edge of the simulated world. */
export const DOCK_POST_KINDS = [
  "gate",
  "warehouseDoor",
  "marketStall",
  "kiosk",
  "loungeDoor",
  "bench",
] as const;
export type DockPostKind = (typeof DOCK_POST_KINDS)[number];

/** Freight on offer waits on `freightStaging`; a delivery is complete once it is all in `deliveryBay`. */
export const DOCK_AREA_KINDS = ["freightStaging", "deliveryBay"] as const;
export type DockAreaKind = (typeof DOCK_AREA_KINDS)[number];

/** Set dressing on the dock floor; the renderer draws each kind procedurally. */
export const DOCK_PROP_KINDS = [
  "crates",
  "container",
  "crane",
  "hullSection",
  "planter",
  "conveyor",
  "bollard",
  "lamp",
  "barrels",
  "rock",
] as const;
export type DockPropKind = (typeof DOCK_PROP_KINDS)[number];

/** Drawn over the deck, semi-transparent where it crosses the ship (Dockside §2.3, layer 7). */
export const DOCK_FOREGROUND_KINDS = [
  "bayWall",
  "gantry",
  "terminalEdge",
  "awning",
  "rockWall",
] as const;
export type DockForegroundKind = (typeof DOCK_FOREGROUND_KINDS)[number];

/** A tile rectangle in the dock map's frame: `w` × `h` tiles from (x, y). */
export interface DockRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * CSS hex colours (`#rrggbb`). `sky` is required when the port's `setting` is `planet` and absent
 * for a `station`.
 */
export interface DockPaletteDef {
  readonly floor: string;
  readonly wall: string;
  readonly accent: string;
  readonly sky?: string;
}

export interface DockPostDef {
  readonly key: LocalKey;
  readonly kind: DockPostKind;
  /** What the inspector and narrator call it: "the queue-board kiosk". */
  readonly name: string;
  /** The floor tile a local stands on. */
  readonly tile: TileCoord;
  /** Which way someone at the post faces. */
  readonly facing: EdgeSide;
}

export interface DockAreaDef {
  readonly key: LocalKey;
  readonly kind: DockAreaKind;
  /** Every tile is walkable floor. */
  readonly rect: DockRect;
}

export interface DockPropDef {
  readonly key: LocalKey;
  readonly kind: DockPropKind;
  readonly rect: DockRect;
  /** Drawing orientation only; `rect` is the tiles the prop covers. */
  readonly rot: Rotation;
  /** A blocking prop's tiles are not walkable, whatever the legend says beneath it. */
  readonly blocking: boolean;
}

export interface DockForegroundDef {
  readonly kind: DockForegroundKind;
  readonly rect: DockRect;
}

/**
 * A port's dock map (Dockside §3.1, D72): `packages/content/data/docks/<port>.json`. Coordinates
 * are in the map's own tile frame. `berth` is a size-class box, authored `void`, that any ship of
 * that class or smaller docks in: the ship's place is not authored but derived
 * (`berthPlacement` in `core/docks.ts`: flush to the box's south edge, the quay side, and centred
 * across it). The sim grafts the map onto the ship's deck there (`systems/spatial/dock.ts`), so
 * with the ship at dock tile `p`, dock tile (x, y) is deck tile (x − p.x, y − p.y). Walkable dock
 * floor is a `floor` tile under no blocking prop (`dockFloorMask` in `core/docks.ts`; content
 * validation applies the same rule). Whether it is a station or a planet is the port's `setting`
 * (D61: the dock does not repeat it).
 *
 * Ramp landings are not listed: each ramp door lands on the dock tile across its hull edge, and
 * both content validation and the nav builder require that tile to be walkable floor.
 */
export interface DockDef {
  readonly id: DockDefId;
  readonly portId: PortDefId;
  readonly name: string;
  readonly palette: DockPaletteDef;
  readonly width: number;
  readonly height: number;
  /** `height` rows of `width` characters, each a key of `legend`. */
  readonly rows: readonly string[];
  readonly legend: Readonly<Record<string, DockTileKind>>;
  /** D72: the box a docked ship lies in: its top-left dock tile and its size class. */
  readonly berth: DockBerthDef;
  readonly posts: readonly DockPostDef[];
  readonly areas: readonly DockAreaDef[];
  readonly props: readonly DockPropDef[];
  readonly foreground: readonly DockForegroundDef[];
  /** One line the narrator sees about the place. */
  readonly ambience: string;
}

/** D72: a dock's berth box: `HULL_SIZE_BOX[sizeClass]` tiles from `origin`, all `void`. */
export interface DockBerthDef {
  readonly origin: TileCoord;
  readonly sizeClass: HullSizeClass;
}

export interface SpawnPointDef {
  readonly key: LocalKey;
  readonly tile: TileCoord;
  readonly tags: readonly ("crew" | "passenger" | "cargo")[];
}

// ---------------------------------------------------------------------------------------------
// Machines
// ---------------------------------------------------------------------------------------------

/** A machine type (SD §9.1). Instances reference it by `defId`. */
export interface MachineDef {
  readonly id: MachineDefId;
  readonly name: string;
  readonly tags: readonly MachineTag[];
  /** Occupied tiles relative to the placement origin at rotation 0. Must include (0,0). */
  readonly footprint: readonly TileCoord[];
  /** Where a worker/user stands, relative to origin at rotation 0; must be outside the footprint. */
  readonly interactionPositions: readonly InteractionPositionDef[];
  readonly power: MachinePowerDef;
  readonly heat: MachineHeatDef;
  readonly operation: MachineOperationDef;
  readonly failure: MachineFailureDef;
  /** Small fault catalog (SD §9.1). Narrator `scheduleFault` may only name keys listed here. */
  readonly faults: readonly FaultDef[];
  /** Replaceable component slots. */
  readonly components: readonly ComponentSlotDef[];
  /** Routine inspection. Absent = never scheduled. */
  readonly maintenance?: MaintenanceDef;
}

export interface InteractionPositionDef {
  readonly key: LocalKey;
  readonly offset: TileCoord;
  /** Which uses this spot serves. */
  readonly purposes: readonly ("operate" | "repair" | "use")[];
  /** Max simultaneous occupants (SD §6.4 worker capacity). */
  readonly capacity: number;
}

export type MachinePowerDef =
  | { readonly role: "none" }
  | {
      readonly role: "consumer";
      readonly drawKw: number;
      readonly priority: PowerPriority;
      /** Below full power: output scales down (`derate`) or the machine stops (`off`). */
      readonly partialPower: "derate" | "off";
    }
  | { readonly role: "generator"; readonly supplyKw: number }
  | {
      readonly role: "battery";
      readonly capacityKj: number;
      readonly maxChargeKw: number;
      readonly maxDischargeKw: number;
    };

/**
 * Normalised heat model. Temperature 0 = ambient, 1 = failure point.
 * W0 decision: one scalar temperature per machine; cooling loops (SD §9.4) are deferred.
 */
export interface MachineHeatDef {
  /** Temperature rise per second at full output. 0 for machines that do not heat. */
  readonly risePerSecond: number;
  /** Passive fall per second toward ambient. */
  readonly coolPerSecond: number;
  /** Above this the machine derates linearly to 0 at 1.0. */
  readonly derateAbove: number;
}

export interface MachineOperationDef {
  /** Needs a crew member at an `operate` position to run (e.g. pilot station). */
  readonly requiresOperator: boolean;
  readonly operatorSkill?: SkillRequirement;
}

/** SD §9.2: hazard integrated against a sampled threshold. */
export interface MachineFailureDef {
  /** Base hazard per second while operating. */
  readonly baseHazardPerSecond: number;
  /** Multiplier on hazard at temperature 1.0 (linear from 1.0 at ambient). */
  readonly heatFactor: number;
  /** Condition lost per second of operation. */
  readonly wearPerSecond: number;
}

export interface FaultDef {
  readonly key: LocalKey;
  readonly name: string;
  /** Relative weight when the hazard fires and a fault type is drawn. */
  readonly weight: number;
  readonly effect: FaultEffect;
  /** What an observer can notice before diagnosis. */
  readonly symptom: { readonly key: LocalKey; readonly channel: SymptomChannel };
  readonly repair: RepairRecipe;
}

export type FaultEffect =
  | { readonly kind: "inoperable" }
  | { readonly kind: "derate"; readonly outputFactor: number }
  | { readonly kind: "overheat"; readonly extraRisePerSecond: number };

/**
 * Ordered stages of a repair (SD §14.4). Progress belongs to the fault, so a second worker
 * resumes at the same stage. Diagnosis is not a step here: it is its own task that turns a
 * `machineSymptom` problem into a `machineFault` problem.
 */
export interface RepairRecipe {
  readonly steps: readonly RecipeStep[];
}

export interface RecipeStep {
  readonly key: LocalKey;
  readonly action: RecipeActionKind;
  readonly workSeconds: Seconds;
  readonly skill?: SkillRequirement;
  readonly tools: readonly ToolKind[];
  /** Removed at the end of this step (the commit point, SD §8.2). */
  readonly consumes: readonly ItemCount[];
  /** Which interaction-position purpose the worker must stand at. */
  readonly at: "operate" | "repair" | "use";
}

export interface ComponentSlotDef {
  readonly slot: LocalKey;
  readonly itemDefId: ItemDefId;
}

export interface MaintenanceDef {
  readonly intervalSeconds: Seconds;
  readonly inspect: RecipeStep;
  /** Condition restored by a completed inspection, clamped to 1. */
  readonly conditionRestored: number;
}

export interface SkillRequirement {
  readonly skill: SkillId;
  readonly min: number;
}

export interface ItemCount {
  readonly itemDefId: ItemDefId;
  readonly count: number;
}

// ---------------------------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------------------------

/** SD §8.1: unique entities for distinctive things, stacks for interchangeable stock. */
export interface ItemDef {
  readonly id: ItemDefId;
  readonly name: string;
  readonly stacking: "unique" | "stackable";
  /** Max count per stack; 1 for unique items. */
  readonly maxStack: number;
  readonly tags: readonly ItemTag[];
  /** Tool kinds this item satisfies (only meaningful with the `tool` tag). */
  readonly toolKinds: readonly ToolKind[];
  /** kg per unit. Drives carry load. */
  readonly mass: number;
  /** Present on items that can be freight. */
  readonly cargoClass?: CargoClass;
  /** Hunger removed per unit eaten (only with the `food` tag). */
  readonly nutrition?: number;
  /**
   * D65: units of freight it carries at once (only on a `handTruck` tool, which must have it). A
   * crew member pushing it moves that many crates per trip instead of one in their hands.
   */
  readonly capacityUnits?: number;
}

// ---------------------------------------------------------------------------------------------
// Crew and traits
// ---------------------------------------------------------------------------------------------

/**
 * A crew member (or NPC) template. The kernel instantiates an `Actor` from it.
 * W0 decision: `traits` absent = sampled procedurally at world creation from the `setup` stream.
 */
export interface CrewDef {
  readonly id: CrewDefId;
  readonly name: string;
  readonly roleTags: readonly RoleTag[];
  readonly skills: SkillLevels;
  readonly traits?: readonly TraitDefId[];
  readonly startingInventory: readonly ItemCount[];
  /** Key into `config.shifts.shifts`. */
  readonly shift: LocalKey;
  /** One line of flavour for the inspector and narrator digest. */
  readonly bio: string;
  /**
   * D38: how this person talks and how they handle the captain, two or three sentences. Not what
   * they want (that surfaces as narrator threads). The narrator writes them in it.
   */
  readonly voice: string;
}

/** Things a trait may scale. Each modifier is a multiplier (1 = no effect). */
export const TRAIT_MODIFIERS = [
  "hungerRate",
  "fatigueRate",
  "comfortRate",
  "socialRate",
  "workSpeed",
  "walkSpeed",
] as const;
export type TraitModifierKey = (typeof TRAIT_MODIFIERS)[number];

/** W0 decision: traits are data (a bundle table) holding bounded multipliers, not code. */
export interface TraitDef {
  readonly id: TraitDefId;
  readonly name: string;
  readonly modifiers: Readonly<Partial<Record<TraitModifierKey, number>>>;
  /** Traits that cannot co-occur with this one during sampling. */
  readonly excludes: readonly TraitDefId[];
}

// ---------------------------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------------------------

/** Dockside §3.3: what kind of place a port is, which decides how arrival looks. */
export const PORT_SETTINGS = ["station", "planet"] as const;
export type PortSetting = (typeof PORT_SETTINGS)[number];

export interface PortDef {
  readonly id: PortDefId;
  readonly name: string;
  /** Dockside §3.3: a station (bay and berth) or a planet (descent, pad). Presentation only. */
  readonly setting: PortSetting;
  /** One line for lists and the capabilities block. */
  readonly description: string;
  /**
   * Passengers spec §2.4: two or three sentences on what kind of people are here, what they
   * want and what the place is known for. The narrator reads it; the kernel never does.
   */
  readonly character: string;
  /**
   * Passengers spec §2.4: two or three named recurring locals the narrator can bring back. Not
   * actors; a passenger spawned here takes a name from the people table, not from this list.
   */
  readonly castSeed: readonly CastSeedDef[];
  readonly externalStores: readonly ExternalStoreDef[];
  /**
   * D47: what the port sells. Seeds `WorldState.markets[portId]` at world creation; the live
   * stock (and the price, once the narrator restocks) is state, so this is the opening position,
   * not truth. A line with `count: 0` still carries the port's price for that item.
   */
  readonly market: readonly MarketLineDef[];
  /**
   * Offline job templates (W6, D40): the null narrator draws from these when it answers an
   * `captainAshore` hook. Pay is not authored: it comes from price bands.
   */
  readonly jobTemplates: readonly JobTemplateDef[];
  /**
   * W0 decision: distance is "transit seconds at nominal propulsion" (D10: time is a knob).
   * Symmetry is checked at L2, not assumed.
   */
  readonly routes: readonly { readonly toPortId: PortDefId; readonly distance: Seconds }[];
}

/** A recurring local at a port, for the narrator's continuity (passengers spec §2.4). */
export interface CastSeedDef {
  readonly name: string;
  readonly role: string;
  /** One sentence: what they are like or what they are after. */
  readonly note: string;
  /** Dockside §5.2: the key of the post on this port's dock map where they stand when you land. */
  readonly post?: LocalKey;
}

export interface ExternalStoreDef {
  readonly key: LocalKey;
  readonly name: string;
  readonly kind: "warehouse" | "market" | "lounge";
}

/** D47: one item a port's market sells; `price` is integer credits per unit. */
export interface MarketLineDef {
  readonly itemDefId: ItemDefId;
  readonly count: number;
  readonly price: number;
}

export interface JobTemplateDef {
  readonly key: LocalKey;
  readonly issuer: string;
  readonly toPortId: PortDefId;
  readonly cargo: readonly {
    readonly itemDefId: ItemDefId;
    readonly countMin: number;
    readonly countMax: number;
  }[];
  /** Relative weight when the null narrator draws a template. */
  readonly weight: number;
}

// ---------------------------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------------------------

/**
 * A starting setup for `createWorld`. W0 decision: scenarios are content (a bundle table), so the
 * default game and headless test fixtures share one path.
 */
export interface ScenarioDef {
  readonly id: ScenarioDefId;
  readonly name: string;
  readonly deckId: DeckDefId;
  readonly startPortId: PortDefId;
  /** Crew to instantiate; each is placed at a `crew` spawn point in order. */
  readonly crew: readonly CrewDefId[];
  /** Integer credits. */
  readonly startingMoney: number;
  /** Loose ship stores placed in a zone. */
  readonly startingItems: readonly (ItemCount & { readonly zoneKey: LocalKey })[];
  /** Fault keys present at start, for fixtures: `{placementKey, faultKey}`. */
  readonly initialFaults: readonly {
    readonly placementKey: LocalKey;
    readonly faultKey: LocalKey;
  }[];
}

// ---------------------------------------------------------------------------------------------
// Config (all tunables; PLAN §5: none hardcoded in sim)
// ---------------------------------------------------------------------------------------------

/**
 * Every tunable number. Validated by Zod in `packages/content`, canonicalised and hashed at build
 * time, and embedded in full in each save (SD §20.1). Adding a field is a content change plus a
 * sim change; there are no defaults inside the kernel.
 */
export interface ConfigDef {
  readonly time: {
    /** Ticks per sim-second. SD §5.1 default 20. */
    readonly tickRate: number;
  };
  readonly movement: {
    readonly walkSpeed: number;
    /** Extra seconds when two crew pass in a corridor (SD §7.4). */
    readonly passDelaySeconds: Seconds;
    /** Wait before re-routing around a blocked tile. */
    readonly blockedRerouteSeconds: Seconds;
    /** Speed multiplier floor from fatigue at fatigue 1.0. */
    readonly fatigueSpeedFloor: number;
    /** Speed multiplier per kg carried, floored at `loadSpeedFloor`. */
    readonly loadSpeedPerKg: number;
    readonly loadSpeedFloor: number;
  };
  readonly doors: {
    readonly openSeconds: Seconds;
    readonly closeSeconds: Seconds;
    readonly autoCloseAfterSeconds: Seconds;
    readonly manualOpenSeconds: Seconds;
    /**
     * Dockside §2.6 (D58): a powered ramp is a heavy plate, so it travels (open or shut) in this
     * time instead of `openSeconds`/`closeSeconds`. Still passable only once fully open.
     */
    readonly rampOpenSeconds: Seconds;
  };
  readonly needs: {
    /**
     * W0 decision: needs are deficits in [0, 1]; 0 = fully satisfied, 1 = critical.
     * Rates are per sim-second before trait multipliers.
     */
    readonly hungerPerSecond: number;
    readonly fatiguePerSecondAwake: number;
    readonly fatiguePerSecondWorking: number;
    readonly fatigueRecoveryPerSecondAsleep: number;
    readonly comfortPerSecond: number;
    readonly comfortRecoveryPerSecondResting: number;
    readonly socialPerSecond: number;
    readonly socialRecoveryPerSecondChatting: number;
    /** Deficit above which a personal activity becomes a routine candidate. */
    readonly seekThreshold: number;
    readonly mealSeconds: Seconds;
    readonly sleepMinSeconds: Seconds;
    /** Wake when fatigue falls below this. */
    readonly wakeBelow: number;
    /**
     * Integration 2 addition: initial need deficits for spawned crew are drawn uniformly from
     * these inclusive ranges on the `setup` stream, so the first minutes have motion.
     */
    readonly initialRange: Readonly<
      Record<
        "hunger" | "fatigue" | "comfort" | "social",
        { readonly min: number; readonly max: number }
      >
    >;
  };
  readonly work: {
    /** SD §5.3: ordinary reconsideration cadence, staggered by actor. */
    readonly reconsiderEveryTicks: number;
    readonly switchCooldownSeconds: Seconds;
    readonly claimLeaseSeconds: Seconds;
    /** SD §15.3 step 5 quantisation bucket. */
    readonly timeBucketSeconds: Seconds;
    readonly retryBackoffSeconds: Seconds;
    /** Skill gained per second of successful work, per level gap (SD §11.2: conservative). */
    readonly skillGainPerSecond: number;
    /** Work speed multiplier per skill level above the requirement. */
    readonly workSpeedPerSkillLevel: number;
  };
  readonly urgency: {
    /** Need deficit at which a personal need moves to `essentialOperation`. */
    readonly needEssentialAbove: number;
    /** Need deficit at which it moves to `immediateSurvival`. */
    readonly needSurvivalAbove: number;
    /** Machine temperature at which its fault/symptom work moves to `containment`. */
    readonly heatContainmentAbove: number;
    readonly heatSurvivalAbove: number;
    /** Seconds of age after which a routine obligation outranks younger ones in class. */
    readonly routineAgingSeconds: Seconds;
  };
  readonly equipment: {
    /** Global hazard multiplier for tuning sweeps. */
    readonly hazardScale: number;
    /** Integrity lost per second above temperature 1.0. */
    readonly overheatDamagePerSecond: number;
    /** Condition below which a `maintenanceDue` problem is raised regardless of interval. */
    readonly maintenanceConditionBelow: number;
    /**
     * D35: integrity below this derates output linearly (factor 1 here, 0 at
     * `integrityInoperableBelow`). Above it integrity does not affect output.
     */
    readonly integrityDerateBelow: number;
    /** D35: integrity below this makes the machine inoperable until a repair restores it. */
    readonly integrityInoperableBelow: number;
  };
  readonly power: {
    readonly priorityOrder: readonly PowerPriority[];
  };
  readonly travel: {
    readonly prepareDepartureSeconds: Seconds;
    readonly undockSeconds: Seconds;
    readonly departSeconds: Seconds;
    readonly approachSeconds: Seconds;
    readonly dockSeconds: Seconds;
    /** Route progress per second at full engine output, in the same units as `PortDef.routes.distance`. */
    readonly nominalSpeed: number;
    /**
     * W6 addition: `TaskDerivationTable` planner-ranking estimate (SD §15.3) for a `staffStation`
     * task; staffing has no accumulated work, so 0 (present-or-not) is the usual value.
     */
    readonly staffEstimateSeconds: Seconds;
    /**
     * D36: an `engine`/`generator` machine whose output is below this while departure is planned
     * counts as impaired, and the departure gate asks the captain before leaving.
     */
    readonly departureMinOutput: number;
    /**
     * D61: how long departure prep calls people on the dock to come aboard before the dock crew
     * bring up whoever is still there, so a departure is never held forever by someone who
     * cannot (or will not) walk back.
     */
    readonly recallAboardSeconds: Seconds;
    /** D66: how often a local standing at their post steps to a neighbouring tile and back. */
    readonly localShuffleSeconds: Seconds;
    /**
     * D66: how long a dock hand's carting errand may take before the old instant behaviour (D63)
     * does it instead, with a `dockHandGaveUp` event, so nothing waits forever on a blocked walk.
     */
    readonly dockHandGiveUpSeconds: Seconds;
    /**
     * D70: how long the captain and someone on the dock talk before that person's card comes up
     * ("talking with Fenwick Adair").
     */
    readonly talkSeconds: Seconds;
    /**
     * D70: how long the captain is out through the gate: to see someone in the port beyond it
     * before their card comes up, or for a look round when nothing was on offer.
     */
    readonly gateVisitSeconds: Seconds;
    /**
     * D70: how long a card may wait to be delivered in person (the captain walking over, or the
     * speaker walking to the ramp) before it comes up anyway, so no card waits forever on a walk.
     */
    readonly cardDeliveryGiveUpSeconds: Seconds;
  };
  readonly commerce: {
    /**
     * Credits per unit distance per cargo unit, inclusive band. Narrator `offerJob` pay must fit.
     * `passenger` (passengers-and-galaxy §3.4) is per unit of path distance for one fare, doubled
     * for a round trip; luggage adds nothing.
     */
    readonly priceBands: Readonly<
      Record<CargoClass | "passenger", { readonly min: number; readonly max: number }>
    >;
    readonly jobOfferTtlSeconds: Seconds;
    /**
     * W6 addition: flat integer credits charged on arrival at a port (SD §17.3 "simple running
     * costs"), so money can go down even on an uneventful loop. 0 = no fee.
     */
    readonly dockingFee: number;
    /** W6 addition: `TaskDerivationTable` planner-ranking estimate for a `haul` task (SD §15.3). */
    readonly haulEstimateSeconds: Seconds;
    /**
     * How long after a declined or expired offer at a port before the narrator is asked again
     * there (the `captainAshore` hook, D40).
     */
    readonly reofferSeconds: Seconds;
    /**
     * Cap on total cargo units per job, clamped at offer time so a haul made of individually
     * spawned crates (one item per unit, see `jobs.ts` `acceptJob`) stays a short trip rather than
     * a long single-actor slog.
     */
    readonly maxCratesPerJob: number;
    /** Passengers-and-galaxy §3.3: how long a round-trip passenger stays ashore. */
    readonly passage: {
      /** `returnsAtTick` is drawn uniformly in [min, max] seconds after going ashore. */
      readonly ashoreSecondsMin: Seconds;
      readonly ashoreSecondsMax: Seconds;
      /** Not back this long after going ashore: the overdue card ("Wait for them" / "Leave"). */
      readonly overdueSeconds: Seconds;
    };
    /** D47: the parts market. */
    readonly market: {
      /** Multipliers over a port's content price for the narrator's `stockMarket` price tiers. */
      readonly priceTiers: Readonly<Record<MarketPriceTier, number>>;
      /** Most units one `stockMarket` command may put on a market. */
      readonly maxStockPerCommand: number;
      /** Per-unit price for an item no port's content market lists, when the narrator stocks it. */
      readonly defaultPrice: number;
      /** Seconds a crew member spends at the counter before a purchase commits. */
      readonly buySeconds: Seconds;
    };
  };
  readonly narrator: {
    /** Quiet-too-long hook fires after this many seconds without a narrative event. */
    readonly quietTooLongSeconds: Seconds;
    /**
     * D66: the `stageDock` hook is raised this long (as a distance at `travel.nominalSpeed`)
     * before the end of the route; transit holds at the end until it is answered.
     */
    readonly approachHookLeadSeconds: Seconds;
    readonly maxSpawnsPerCommand: number;
    /** Upper bound on `scheduleFault` window length. */
    readonly maxFaultWindowSeconds: Seconds;
    /** Narrator budget (review §D.3), refilled to these values every `budgetRefillSeconds`. */
    readonly spawnBudget: number;
    readonly faultBudget: number;
    readonly budgetRefillSeconds: Seconds;
    /**
     * W6 addition: `SimEvent["type"]` names (kept as plain strings so `content.ts` need not
     * depend on `core/types/events`) whose `narrative`-significance occurrence raises the
     * `notableEvent` hook the following tick. Empty = never.
     */
    readonly hookOnEvents: readonly string[];
  };
  readonly host: {
    /** D14: max sim-seconds the worker may run ahead of the viewer. */
    readonly runAheadCapSeconds: Seconds;
    /** How much view-time history the inspector snapshot ring keeps. */
    readonly snapshotRingSeconds: Seconds;
    readonly snapshotEverySeconds: Seconds;
    readonly localSaveEverySeconds: Seconds;
    readonly remoteSaveEverySeconds: Seconds;
    readonly frameEveryTicks: number;
  };
  readonly shifts: {
    /**
     * W0 decision: shifts are cyclic work windows over a fixed cycle; outside a window the actor
     * is off duty (still eligible for emergencies, SD §11.4).
     */
    readonly cycleSeconds: Seconds;
    readonly shifts: readonly {
      readonly key: LocalKey;
      readonly workWindows: readonly (readonly [Seconds, Seconds])[];
    }[];
  };
  /** W4a addition: ambient chat (PLAN §6 W4a item 5). */
  readonly social: {
    /** Max tile distance between two crew for an ambient conversation. */
    readonly chatRadiusTiles: number;
    /** Min seconds between two conversations involving the same person. */
    readonly chatCooldownSeconds: Seconds;
    /** Templates with `{a}` (speaker) and `{b}` (listener) placeholders. */
    readonly templateLines: readonly string[];
  };
  readonly events: {
    readonly tickerMaxEntries: number;
    /** Max events retained in the trace ring buffer. */
    readonly traceRingSize: number;
  };
}

// ---------------------------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------------------------

/**
 * Everything static the kernel needs, keyed by definition ID. Built and validated by
 * `packages/content`; `hash` is the SHA-256 of the canonical bundle (computed at build time, not
 * by the kernel) and is recorded in saves as `contentHash`.
 *
 * W0 decision: the bundle also carries `traits` and `scenarios` tables beyond the six def kinds.
 */
/**
 * D25 (2026-09-30): who offers work, for the null narrator's offline offers (`data/people/`). Names
 * are drawn from the shared lists; roles, organisations and extra pitch lines are per port, so
 * the people at a mining outpost sound like it. Pitch lines take `{cargo}`, `{from}` and `{to}`
 * placeholders and never mention pay (D24).
 */
export interface PeopleTableDef {
  readonly givenNames: readonly string[];
  readonly familyNames: readonly string[];
  /** Pitch lines usable at any port. */
  readonly pitches: readonly string[];
  /** How people say each cargo class in a pitch or on a card ("fragile equipment"), lower case. */
  readonly cargoWords: Readonly<Record<CargoClass, string>>;
  readonly ports: Readonly<
    Record<
      PortDefId,
      {
        readonly roles: readonly string[];
        readonly orgs: readonly string[];
        readonly pitches: readonly string[];
      }
    >
  >;
}

export interface ContentBundle {
  readonly decks: Readonly<Record<DeckDefId, DeckDef>>;
  readonly machines: Readonly<Record<MachineDefId, MachineDef>>;
  readonly items: Readonly<Record<ItemDefId, ItemDef>>;
  readonly crew: Readonly<Record<CrewDefId, CrewDef>>;
  readonly traits: Readonly<Record<TraitDefId, TraitDef>>;
  readonly ports: Readonly<Record<PortDefId, PortDef>>;
  readonly scenarios: Readonly<Record<ScenarioDefId, ScenarioDef>>;
  /**
   * D25 name table. Optional so hand-built test bundles need not carry one; without it the null
   * narrator falls back to the template's `issuer` as the person's name.
   */
  readonly people?: PeopleTableDef;
  /**
   * Dockside §3: dock maps by id, at most one per port. Optional so hand-built test bundles need
   * not carry any; a port without one keeps the transfer-tile behaviour.
   */
  readonly docks?: Readonly<Record<DockDefId, DockDef>>;
  readonly config: ConfigDef;
  readonly hash: string;
}
