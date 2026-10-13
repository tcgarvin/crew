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
import type { Interests, Values } from "./actor";
import type { Days, EdgeSide, Rotation, Seconds, TileCoord, TileEdge } from "./common";
import type {
  ActivityDefId,
  CrewDefId,
  DeckDefId,
  DockDefId,
  ItemDefId,
  LocalKey,
  MachineDefId,
  PortDefId,
  ScenarioDefId,
  TopicDefId,
  TraitDefId,
} from "./ids";
import type { ProblemKind } from "./work";

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
  /** Expeditions A1 (§7.2): handling a weapon and oneself in a fight; hit chance and resolve. */
  "fighting",
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
  /**
   * §galley-provisions: a crate the galley cooks from (`galley.servingsPerCrate` servings each);
   * not `food`.
   */
  "provisions",
  /** §cooking-and-serving: a cooked serving (also `food`); carries `Item.meal` once served. */
  "meal",
  /** Slice 4: something to read off the shelf (`ActivityDef.requires`). */
  "book",
  /** Slice 4: something to play (the harmonica); `personal` too, so it is someone's. */
  "instrument",
  /** Slice 4: a baked snack (also `food`), eaten where found; never `meal`. */
  "treat",
  /**
   * Slice 5 (§patching-and-plating): one patch for one hull scar underway (`patchHull` consumes
   * one).
   */
  "patchKit",
  /**
   * Slice 5 (§patching-and-plating): a hull plate, fitted over a scar at port (`plateHull` consumes
   * one).
   */
  "plating",
  /** Expeditions A1 (§7.2): a weapon (`ItemDef.weapon`); only a weapon carries the tag. */
  "weapon",
] as const;
export type ItemTag = (typeof ITEM_TAGS)[number];

/** What a tool is good for. Recipes ask for a tool kind, not a specific item def. */
export const TOOL_KINDS = [
  "wrench",
  "multimeter",
  "welder",
  "diagnosticScanner",
  "handTruck",
  /** §mop-trips: the mop a `cleanCompartment` task needs. */
  "mop",
] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

/**
 * §market-lever: the narrator's coarse price lever for `stockMarket`;
 * `config.commerce.market.priceTiers` maps it.
 */
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
  /**
   * Slice 5 (§intercom-and-reporting): an intercom panel, where a report is made to the whole ship.
   */
  "comm",
  /** Expeditions A1 (§7.2): the arms locker, where the party arms before going ashore. */
  "armsLocker",
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

/**
 * §thoughts: the thoughts the sim can give someone, a closed set because each is raised by sim code
 * (a long watch, a clean pass at the helm). Content gives each its label, value and duration
 * (`ContentBundle.thoughts`, every key required).
 */
export const THOUGHT_KEYS = [
  "stoodLongWatch",
  "doubleWatch",
  "helmCleanPass",
  "helmScrape",
  /** §eating: ate a `good` meal. */
  "ateWell",
  /** §eating: ate a `poor` meal. */
  "burntDinner",
  /** §eating: ate `food` with no `meal` on it (a ration pack). */
  "ateRationPack",
  /** §room-tiers: ate in a room at the `dirty` tier; `ateInFilthyMess` at `filthy` (two keys). */
  "ateInDirtyMess",
  "ateInFilthyMess",
  /** Slice 4: contest outcomes (`ActivityDef.thoughts.win`/`lose`). */
  "wonContest",
  "lostContest",
  /** Slice 4: a losing streak at `social.rivalry.streakFor`; `refId` is the winner. */
  "keepsBeatingMe",
  /** Slice 4: a bond outcome, or `joined` a session. */
  "goodCompany",
  /** Slice 4: a debate within `social.debate.agreeWithin`. */
  "spiritedTalk",
  /** Slice 4: a debate beyond `social.debate.argueBeyond`; `refId` is the other. */
  "argued",
  /** Slice 4: a bystander to a debate who does not like debate. */
  "gotLectured",
  /** Slice 4: a performance heard by a music-liker / a music-disliker. */
  "enjoyedMusic",
  "hatedTheNoise",
  /** Slice 4: a sparring knock (`ActivityDef.risk`). */
  "sparringBruise",
  /** Slice 4: woke in one's own cabin / in a bunkroom someone kept awake. */
  "ownCabin",
  "noisyBunkroom",
  /** Slice 4: crew with no berth, refreshed by the cabins system. */
  "noBunkOfMyOwn",
  /** Slice 4: seated beside the captain at the captain's table. */
  "satWithTheCaptain",
  /** Slice 4: a `privateTalk`, warm / stern. */
  "heardOut",
  "dressedDown",
  /** Slice 4: ate a `treat`-tagged item. */
  "ateATreat",
  /** Slice 5: a rock came through the tile they stood on (no bodies yet: a fright, not a wound). */
  "nearMiss",
  /** Expeditions A1 (§11): a shot of theirs killed someone. */
  "killedSomeone",
  /** Expeditions A1 (§11): saw a crewmate wounded in a fight (stacks). */
  "sawCrewHurt",
  /** Expeditions A1 (§11): stood their ground through a fight the party won. */
  "heldTheLine",
  /** Expeditions A1 (§11): broke and ran in a fight. */
  "ranFromAFight",
  /** Expeditions A1 (§11): carrying an open wound (kept while one is open). */
  "wounded",
  /** §repair: finished a fault's repair. */
  "fixedIt",
  /** §cooking-and-serving: served a `good` meal (the cook). */
  "cookedWell",
  /** §outcomes: a baking session put treats on the counter (the baker). */
  "bakedForTheCrew",
  /** §group-sessions: a hosted session collapsed with too few (the host). */
  "nobodyJoinedIn",
  /** §mop-trips: mopped a room back to clean (`roomCleaned`, the mopper). */
  "squaredAway",
  /**
   * §memory-levers (D106): story-sized thoughts only the narrator gives (`giveThought`); nothing in
   * the sim raises them. `worriedAbout` and `grieving` name someone (`refId`).
   */
  "worriedAbout",
  "grieving",
  "shaken",
  "heartened",
] as const;
export type ThoughtKey = (typeof THOUGHT_KEYS)[number];

/** §thought-and-reveal-levers: the thoughts nothing but the narrator's `giveThought` raises. */
export const NARRATOR_THOUGHT_KEYS = [
  "worriedAbout",
  "grieving",
  "shaken",
  "heartened",
] as const satisfies readonly ThoughtKey[];

/**
 * §memories: what one person remembers about another, each a closed key raised by sim code (a chat,
 * a game, an argument, a private talk). Config gives each its opinion, duration and stack limit
 * (`social.memories`, every key required); affinity is compatibility plus the live memories.
 */
export const MEMORY_KEYS = [
  /** An ambient chat that went well / that rubbed the wrong way (`social.chatSour`). */
  "chatted",
  "rubbedWrong",
  /** A contest or bond played together (`ActivityDef.memories.together`). */
  "goodTime",
  /** A contest lost to them (`ActivityDef.memories.loserToWinner`). */
  "beatMe",
  /** A losing run at `social.rivalry.streakFor` or more against them. */
  "keepsBeatingMe",
  /** A debate within `social.debate.agreeWithin` / beyond `argueBeyond`. */
  "goodTalk",
  "argued",
  /** Heard them perform, liking the activity. */
  "playedForMe",
  /** The captain's table, both ways. */
  "sharedATable",
  /** A `privateTalk`: the crew member's warm / stern memory, and the captain's warm one. */
  "heardMeOut",
  "dressedMeDown",
  "talkedItThrough",
  /** Expeditions A1 (§11): fought beside them, both ways, among the party. */
  "foughtBeside",
  /** Expeditions A1 (§11): they dragged me out of the fight. */
  "carriedMeOut",
  /** Expeditions A1 (§11): they left me on the floor. */
  "leftMeBehind",
  /**
   * §memory-levers (D106): story-sized memories only the narrator plants (`plantMemory`,
   * `fallOut`), each big enough to carry a pair past "close to" / "at odds with" on its own.
   */
  "betrayedMe",
  "savedMyLife",
  "wrongedOverSomeone",
  "madeItRight",
] as const;
export type MemoryKey = (typeof MEMORY_KEYS)[number];

/** §memory-levers: the memories only the narrator plants; the sim's own code never raises them. */
export const NARRATOR_MEMORY_KEYS = [
  "betrayedMe",
  "savedMyLife",
  "wrongedOverSomeone",
  "madeItRight",
] as const satisfies readonly MemoryKey[];
export type NarratorMemoryKey = (typeof NARRATOR_MEMORY_KEYS)[number];

/** §memories: one kind of memory (`ConfigDef.social.memories`). */
export interface MemoryDef {
  /** Lower-case phrase from the rememberer's side: "a good chat", "an argument". */
  readonly label: string;
  /** Whole-number contribution to affinity while it lasts; never 0. */
  readonly opinion: number;
  readonly durationDays: Days;
  /** At most this many held about one person; one more refreshes the oldest instead. */
  readonly stackLimit: number;
}

/**
 * §room-tiers: how dirty a room is, from its cells (`systems/dirt/grid.ts` `tierOf`, with
 * hysteresis on the way down). `WorldState.dirt.tiers` holds the last tier written per room.
 */
export const DIRT_TIERS = ["clean", "untidy", "dirty", "filthy"] as const;
export type DirtTier = (typeof DIRT_TIERS)[number];

/**
 * §cooking-and-serving: how good a served meal is: the cook's cooking skill against
 * `galley.goodCookingAbove` / `poorCookingBelow`, dropped a step by a galley at `dirty` or worse.
 * Fixed on the item at the serve (`Item.meal`).
 */
export const MEAL_QUALITIES = ["poor", "plain", "good"] as const;
export type MealQuality = (typeof MEAL_QUALITIES)[number];

/**
 * §debris-fields-and-ion-storms: kinds of navigation hazard the narrator's `scheduleHazard` may
 * place on a leg. The kernel rolls them all the same way; display names live in `core/render.ts`.
 * The asteroid belt is not one: it is `scheduleField`, a field the ship crosses.
 */
export const HAZARD_KINDS = ["debrisField", "ionStorm"] as const;
export type HazardKind = (typeof HAZARD_KINDS)[number];

/**
 * §forced-faults-and-hazards (D106): the outcomes of a hazard's roll the narrator may decide
 * outright (`scheduleHazard.outcome`); `unattended` is the empty helm's, never chosen.
 */
export const FORCED_HAZARD_OUTCOMES = ["clean", "scrape", "delay"] as const;
export type ForcedHazardOutcome = (typeof FORCED_HAZARD_OUTCOMES)[number];

/**
 * §scheduling-a-field: how hard an asteroid field is (`ConfigDef.field.severities`: rate,
 * large-rock share and length). The helm's detection check reads `hazards.difficulty` at
 * easy/hard/brutal.
 */
export const FIELD_SEVERITIES = ["light", "heavy", "brutal"] as const;
export type FieldSeverity = (typeof FIELD_SEVERITIES)[number];

/**
 * §sighting-and-the-alert: how a field is noticed: `rolled` by the helm-stander's piloting check
 * before it starts, `unseen` at the first impact whatever the helm does.
 */
export const FIELD_DETECTIONS = ["rolled", "unseen"] as const;
export type FieldDetection = (typeof FIELD_DETECTIONS)[number];

/** §rock-impacts: a `small` rock hits one tile; a `large` one the tile and its eight neighbours. */
export const ROCK_SIZES = ["small", "large"] as const;
export type RockSize = (typeof ROCK_SIZES)[number];

/**
 * §machines-in-the-blast: what a rock does to a machine with a tile in its blast
 * (`ConfigDef.field.machineEffects` weights): nothing, integrity down a little or a lot, integrity
 * to zero, or one of its faults.
 */
export const MACHINE_EFFECTS = ["none", "graze", "damage", "knockout", "fault"] as const;
export type MachineEffect = (typeof MACHINE_EFFECTS)[number];

/**
 * Slice 4: what people like doing off watch (`Actor.interests`, `ActivityDef.interest`). A closed
 * set because the planner scores activities by it; every tag is some activity's interest.
 */
export const INTEREST_TAGS = [
  "cards",
  "boardgames",
  "vids",
  "debate",
  "music",
  "exercise",
  "sparring",
  "reading",
  "tinkering",
  "cooking",
  "stargazing",
  "gossip",
] as const;
export type InterestTag = (typeof INTEREST_TAGS)[number];

/**
 * Slice 4: how a group activity ends (`systems/social/outcomes.ts` `resolveOutcome`): a winner,
 * a bond all round, a debate on a topic, a performance for the room, or nothing.
 */
export const ACTIVITY_OUTCOMES = ["contest", "bond", "debate", "perform", "none"] as const;
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number];

// ---------------------------------------------------------------------------------------------
// Deck
// ---------------------------------------------------------------------------------------------

/**
 * §orientation-and-size: hull size classes. A deck fits inside its class box; a dock's berth is a
 * class box, so any ship of that class or smaller docks there (ship life §10).
 */
export const HULL_SIZE_CLASSES = ["S", "M", "L"] as const;
export type HullSizeClass = (typeof HULL_SIZE_CLASSES)[number];

/** §orientation-and-size: the box (width × height, tiles) each size class fits inside. */
export const HULL_SIZE_BOX: Readonly<
  Record<HullSizeClass, { readonly w: number; readonly h: number }>
> = {
  S: { w: 24, h: 14 },
  M: { w: 36, h: 20 },
  L: { w: 40, h: 24 },
};

/**
 * §orientation-and-size: what kind of hull a deck is. Orientation is not a field: the bow is always
 * east (high x) and the ramps always open on the south hull edge, which content validation
 * enforces.
 */
export interface HullDef {
  /** Informational: "light_freighter". */
  readonly class: string;
  readonly sizeClass: HullSizeClass;
  /** §the-hull-bar: the hull bar's full value in hull points (100 for a light freighter). */
  readonly max: number;
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
  /**
   * How a sentence names the room, article and all, lower case: "engineering" where "the" would
   * read wrong. Absent, it is "the" and the lowercased name ("the cargo hold"); see `roomPhrase`.
   */
  readonly phrase?: string;
  /**
   * Semantic tags (`cargoHold`, `galley`, `quarters`, `bridge`, `engineering`). Tags alone grant no
   * function.
   */
  readonly tags: readonly string[];
}

export interface DoorPlacementDef {
  readonly key: LocalKey;
  readonly edge: TileEdge;
  /**
   * W0 decision: ramps are doors on a hull edge with kind `ramp`; they share the door state
   * machine.
   */
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

/**
 * What a dock map tile is. Only `floor` is walkable, and only where no blocking prop stands.
 * Expeditions A1 (§4, call 8): `cover` is never walked (a solid thing someone can crouch behind)
 * and blocks a line of fire unless it is beside either end of it (`core/sites.ts`).
 */
export const DOCK_TILE_KINDS = ["floor", "wall", "void", "cover"] as const;
export type DockTileKind = (typeof DOCK_TILE_KINDS)[number];

/**
 * Where a local stands. The gate and warehouse door are the edge of the simulated world.
 * Expeditions A1 (§4): the site kinds: where the `target` stands (and the `loot` lies), the cast's
 * `guard` spots, the `exit` a breaking cast member runs for, a `flank` approach, and `bystander`
 * spots. Either map kind may carry any post kind; nothing reads a post it does not know (call 10).
 */
export const DOCK_POST_KINDS = [
  "gate",
  "warehouseDoor",
  "marketStall",
  "kiosk",
  "loungeDoor",
  "bench",
  "target",
  "guard",
  "loot",
  "exit",
  "flank",
  "bystander",
] as const;
export type DockPostKind = (typeof DOCK_POST_KINDS)[number];

/** Expeditions A1 (§4): a port's dock (absent `kind`) or a site's landing ground. */
export const DOCK_KINDS = ["dock", "site"] as const;
export type DockKind = (typeof DOCK_KINDS)[number];

/**
 * Freight on offer waits on `freightStaging`; a delivery is complete once it is all in
 * `deliveryBay`.
 */
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
 * A port's dock map (Dockside §3.1, §dock-map-content): `packages/content/data/docks/<port>.json`.
 * Coordinates are in the map's own tile frame. `berth` is a size-class box, authored `void`, that
 * any ship of that class or smaller docks in: the ship's place is not authored but derived
 * (`berthPlacement` in `core/docks.ts`: flush to the box's south edge, the quay side, and centred
 * across it). The sim grafts the map onto the ship's deck there (`systems/spatial/dock.ts`), so
 * with the ship at dock tile `p`, dock tile (x, y) is deck tile (x − p.x, y − p.y). Walkable dock
 * floor is a `floor` tile under no blocking prop (`dockFloorMask` in `core/docks.ts`; content
 * validation applies the same rule). Whether it is a station or a planet is the port's `setting`
 * (§dock-alongside: the dock does not repeat it).
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
  /** §ship-placement: the box a docked ship lies in: its top-left dock tile and its size class. */
  readonly berth: DockBerthDef;
  readonly posts: readonly DockPostDef[];
  readonly areas: readonly DockAreaDef[];
  readonly props: readonly DockPropDef[];
  readonly foreground: readonly DockForegroundDef[];
  /** One line the narrator sees about the place. */
  readonly ambience: string;
  /**
   * §footfall-and-boots: how much a step on this dock's floor loads a crew member's boots (0 a
   * clean deck plate, 1 a muddy field), scaled by `config.dirt.dockGrimePerStep`; the boots shed it
   * on the ship's floor afterwards. In [0, 1].
   */
  readonly grime: number;
  /**
   * §dirt-deposits: whether the air here settles on the deck near an open ramp while docked (0
   * none, 1 a dust storm), scaled by `config.dirt.airborneDustPerDay` and capped per visit. In [0,
   * 1]; a station (no sky) authors 0.
   */
  readonly airborneDust: number;
  /** Expeditions A1 (§4): `site` for a landing site's map; absent is a port's dock. */
  readonly kind?: DockKind;
  /**
   * Expeditions A1 (§4): tiles at which the cast notice an approaching party (required on a
   * site, positive).
   */
  readonly noticeRadius?: number;
  /**
   * Expeditions A1 (§5.3): the cast the sim places when nobody stages the site (site only;
   * `SITE_LIMITS` caps it).
   */
  readonly defaultCast?: readonly SiteCastEntryDef[];
}

// ---------------------------------------------------------------------------------------------
// Sites and the cast (expeditions A1, §5)
// ---------------------------------------------------------------------------------------------

/** §5.2: what part someone plays at a site. */
export const CAST_PARTS = ["target", "guard", "bystander", "ally"] as const;
export type CastPart = (typeof CAST_PARTS)[number];

/** §5.2: what they carry: nothing, a baton, or a blaster. */
export const CAST_ARMS = ["none", "melee", "blaster"] as const;
export type CastArms = (typeof CAST_ARMS)[number];

/** §5.2: how much it takes to break them (`config.expedition.resolveTiers`). */
export const RESOLVE_TIERS = ["shaky", "steady", "hard"] as const;
export type ResolveTier = (typeof RESOLVE_TIERS)[number];

/** §5.2: their loyalty to the target. */
export const TIE_TIERS = ["paid", "bound", "devoted"] as const;
export type TieTier = (typeof TIE_TIERS)[number];

/** §5.2: what a parley could offer them (A2); `nothing` for a bystander. */
export const WANTS_TIERS = ["money", "out", "blood", "nothing"] as const;
export type WantsTier = (typeof WANTS_TIERS)[number];

/**
 * §5.1, §5.2: one person at a site, as authored (`DockDef.defaultCast`) or staged
 * (`scenarioStartExpedition.cast`). Spawned as an actor (`crew: false`) at `post`, a post of the
 * part's kind on the site map (a `target` at a `target` post, a `guard` at a `guard`, a `bystander`
 * at a `bystander`, an `ally` at a `guard` or `bystander` post).
 */
export interface SiteCastEntryDef {
  readonly name: string;
  /** Lower case: "boat-shed keeper"; becomes the generated crew def's `bio`. */
  readonly role: string;
  /** One line of how they look. */
  readonly look: string;
  readonly part: CastPart;
  readonly arms: CastArms;
  readonly resolve: ResolveTier;
  /** Ignored for the target and bystanders; authored all the same. */
  readonly tie: TieTier;
  readonly wants: WantsTier;
  readonly post: LocalKey;
}

/**
 * §5.2: the kernel's caps on a site's cast (beside `STAGING_LIMITS`): people, armed people, targets
 * and allies.
 */
export const SITE_LIMITS = { people: 6, armed: 3, targets: 1, allies: 1 } as const;

/** §berth-boxes: a dock's berth box: `HULL_SIZE_BOX[sizeClass]` tiles from `origin`, all `void`. */
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
  /**
   * Where a worker/user stands, relative to origin at rotation 0; must be outside the footprint.
   */
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

/** Expeditions A1 (§12.2 of SD, §7.1): body parts, wound severities and damage types. */
export const BODY_PARTS = ["head", "torso", "leftArm", "rightArm", "leftLeg", "rightLeg"] as const;
export type BodyPart = (typeof BODY_PARTS)[number];

export const WOUND_SEVERITIES = ["graze", "serious", "grave"] as const;
export type WoundSeverity = (typeof WOUND_SEVERITIES)[number];

export const DAMAGE_TYPES = ["blaster", "blunt", "stun"] as const;
export type DamageType = (typeof DAMAGE_TYPES)[number];

/** §accidents-aboard: the ways someone is hurt aboard outside a fight. */
export const ACCIDENT_HAZARDS = ["hotWork", "slip", "thrown"] as const;
export type AccidentHazard = (typeof ACCIDENT_HAZARDS)[number];

/**
 * Expeditions A1 (§7.2): what a weapon does. `range` in tiles, `aimSeconds` from the decision to
 * the shot, `hit` the base chance in (0, 1], `severity`/`damageType` of a hit; `stun` says it has
 * a stun setting (a `fire: stun` plan hits with `stun` instead).
 */
export interface WeaponDef {
  readonly kind: "blaster" | "baton";
  readonly range: number;
  readonly aimSeconds: Seconds;
  readonly hit: number;
  readonly severity: WoundSeverity;
  readonly damageType: "blaster" | "blunt";
  readonly stun: boolean;
}

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
   * §hand-truck-trips: units of freight it carries at once (only on a `handTruck` tool, which must
   * have it). A crew member pushing it moves that many crates per trip instead of one in their
   * hands.
   */
  readonly capacityUnits?: number;
  /** Expeditions A1 (§7.2): present exactly on a `weapon`-tagged item. */
  readonly weapon?: WeaponDef;
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
  /** One line of flavour for the inspector and narrator digest. */
  readonly bio: string;
  /**
   * §crew-lines: how this person talks and how they handle the captain, two or three sentences. Not
   * what they want (that surfaces as narrator threads). The narrator writes them in it.
   */
  readonly voice: string;
  /**
   * Slice 4: what they like and dislike doing off watch. Absent, they are generated at spawn
   * (`core/interests.ts` `generateInterests`, the `setup` stream).
   */
  readonly interests?: Interests;
  /** Slice 4: where they stand on the three value axes. Absent, generated with `interests`. */
  readonly values?: Values;
}

/** Things a trait may scale. Each modifier is a multiplier (1 = no effect). */
export const TRAIT_MODIFIERS = [
  "hungerRate",
  "fatigueRate",
  "comfortRate",
  "socialRate",
  "workSpeed",
  "walkSpeed",
  /** Slice 4: scales `needs.recreationPerDay` (`loner` 0.8). */
  "recreationRate",
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
// Thoughts (§thoughts)
// ---------------------------------------------------------------------------------------------

/**
 * §mood-and-work-speed: what a thought is worth. Mood is the clamped sum of a person's live
 * thoughts' values; a thought lasts `durationDays` from when it was had. A non-stacking thought had
 * again refreshes the one already held; a stacking one is held once per occasion.
 */
export interface ThoughtDef {
  readonly key: ThoughtKey;
  /** Lower-case phrase for the inspector and digest: "stood a long watch". */
  readonly label: string;
  /** Contribution to mood, in [-1, 1]. */
  readonly value: number;
  readonly durationDays: Days;
  readonly stacks: boolean;
}

// ---------------------------------------------------------------------------------------------
// Off watch (slice 4)
// ---------------------------------------------------------------------------------------------

/**
 * Slice 4: one place an activity can happen, matched against the ship's deck by tag. Exactly one
 * of `machineTag` (stand at one of the machine's `use` positions), `zoneTag` (a free tile of a
 * zone carrying the tag) or `compartmentTag` (a free floor tile of a compartment carrying it).
 * `own` restricts a machine to the actor's berth compartment (reading at one's own desk).
 */
export interface VenueDef {
  readonly machineTag?: MachineTag;
  readonly zoneTag?: string;
  readonly compartmentTag?: string;
  readonly own?: true;
}

/** Slice 4: the needs an activity restores, as the total over its `durationDays`. */
export type ActivityRestores = Readonly<
  Partial<Record<"recreation" | "social" | "comfort", number>>
>;

/**
 * Slice 4: an off-watch activity (`data/activities/`). `venue` is an ordered list of
 * alternatives; the first present on the deck wins. `restores` and `fatigueCost` are totals over
 * `durationDays`, applied per tick while it runs, so an interrupted game restores in proportion.
 * `solo` is how a group activity is played alone when nobody joins (absent: the host gives up).
 * `thoughts` names keys of the closed `THOUGHT_KEYS` set, never new ones.
 */
export interface ActivityDef {
  readonly id: ActivityDefId;
  /** Present-tense label while it runs: "playing cards". */
  readonly label: string;
  /** Label while the host waits for others: "waiting for a game of cards". */
  readonly waitingLabel: string;
  readonly interest: InterestTag;
  readonly venue: readonly VenueDef[];
  readonly participants: { readonly min: number; readonly max: number };
  readonly durationDays: Days;
  readonly restores: ActivityRestores;
  /** Fatigue added over `durationDays` (exercise, sparring). */
  readonly fatigueCost?: number;
  readonly solo?: {
    readonly label: string;
    readonly durationDays: Days;
    readonly restores: ActivityRestores;
  };
  readonly outcome: ActivityOutcome;
  readonly thoughts?: Readonly<
    Partial<Record<"win" | "lose" | "joined" | "listened" | "listenedDislike", ThoughtKey>>
  >;
  /**
   * §memories: memories at the end. `together`: a contest's members pairwise, both ways; a bond's
   * members who like the activity, toward each other member. `loserToWinner`: each loser.
   */
  readonly memories?: {
    readonly together?: MemoryKey;
    readonly loserToWinner?: MemoryKey;
  };
  /** A debate's (or a vid's) topics, one picked per session. */
  readonly topics?: readonly TopicDefId[];
  readonly skillGain?: { readonly skill: SkillId; readonly perDay: number };
  /** Per member, per session: the chance of a knock (`sparringBruise`, `tookAKnock`). */
  readonly risk?: { readonly injuryChance: number };
  /** Dirt deposited at the venue tile at the end (`depositDirt`). */
  readonly dirt?: number;
  /** An item fetched first and put back after: a `book` off the shelf, one's own `instrument`. */
  readonly requires?: { readonly itemTag: ItemTag; readonly own?: true };
  /** Items spawned on the first tile of a zone carrying `zoneTag` at the end (baking). */
  readonly produces?: {
    readonly itemDefId: ItemDefId;
    readonly count: number;
    readonly zoneTag: string;
  };
  /** Offered only in transit (stargazing). */
  readonly transitOnly?: true;
  /** Not offered while a public problem of one of these kinds is open (baking vs dinner). */
  readonly blockedByProblems?: readonly ProblemKind[];
}

/**
 * Slice 4: something a debate is about. `weights` in [-1, 1] per value axis; a member's stance is
 * the dot product with their `values` (`core/interests.ts` `stanceOn`).
 */
export interface TopicDef {
  readonly id: TopicDefId;
  /** Lower case, for the ticker: "the Guild", "faith". */
  readonly label: string;
  readonly weights: {
    readonly orderFreedom: number;
    readonly faithReason: number;
    readonly loyaltyAmbition: number;
  };
}

// ---------------------------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------------------------

/** Dockside §3.3: what kind of place a port is, which decides how arrival looks. */
export const PORT_SETTINGS = ["station", "planet"] as const;
export type PortSetting = (typeof PORT_SETTINGS)[number];

/**
 * Expeditions A1 (§3.1, call 1): a port, or a site: a landing that sells nothing, reached from its
 * `nearPortId`. A port never lists a site in its routes (content L2), so in A1 nothing sails there;
 * the expedition starts there by `scenarioStartExpedition`.
 */
export const PORT_KINDS = ["port", "site"] as const;
export type PortKind = (typeof PORT_KINDS)[number];

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
   * §port-markets: what the port sells. Seeds `WorldState.markets[portId]` at world creation; the
   * live stock (and the price, once the narrator restocks) is state, so this is the opening
   * position, not truth. A line with `count: 0` still carries the port's price for that item.
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
  /** Expeditions A1 (§3.1): `site` for a landing site; absent is a port. */
  readonly kind?: PortKind;
  /** Expeditions A1 (§3.1): the port a site lies near (its one route); site only. */
  readonly nearPortId?: PortDefId;
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

/** §port-markets: one item a port's market sells; `price` is integer credits per unit. */
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
 * §sections-and-dayworkers: who stands which watch. Section `i` has the watch while
 * `watchOfDay(tick) === i`, so the order of `sections` is the order the watches come round; a
 * section beyond `config.time.watchesPerDay` never stands one (content validation requires exactly
 * that many). Dayworkers keep `config.watches.dayworkerOnWatches`. Crew in the scenario but in
 * neither list (and anyone who joins later) are dayworkers.
 */
export interface WatchBillDef {
  readonly sections: readonly WatchSectionDef[];
  readonly dayworkers: readonly CrewDefId[];
}

export interface WatchSectionDef {
  /** "red", "white", "blue": the ticker capitalises it ("White section has the watch"). */
  readonly key: LocalKey;
  readonly members: readonly CrewDefId[];
}

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
  /**
   * §sections-and-dayworkers: the watch bill. Absent in small test fixtures, where `createWorld`
   * generates one (`core/watch-bill.ts`); content validation decides when authored content may omit
   * it.
   */
  readonly watchBill?: WatchBillDef;
}

/**
 * §ambient-chat: when a gated chat line may come up. `paidDockingFee`: the ship lies docked at a
 * port where she paid the docking fee.
 */
export type ChatLineCondition = "paidDockingFee";

/**
 * §ambient-chat: one chat template, with `{a}` (speaker) and `{b}` (listener) placeholders; the
 * object form joins the pool only while its `when` holds.
 */
export type ChatLineDef = string | { readonly line: string; readonly when: ChatLineCondition };

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
    /**
     * §the-ships-day: sim-seconds in one ship's day. Every `Days` knob and per-day rate is
     * converted through this where it is read (`core/clock.ts`), so changing it rescales the
     * routine while physical motion (walking, doors, docking stages) keeps its speed.
     */
    readonly daySeconds: Seconds;
    /** §the-ships-day: watches in one ship's day; a watch is `daySeconds / watchesPerDay`. */
    readonly watchesPerDay: number;
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
     * Dockside §2.6 (§dock-drawing): a powered ramp is a heavy plate, so it travels (open or shut)
     * in this time instead of `openSeconds`/`closeSeconds`. Still passable only once fully open.
     */
    readonly rampOpenSeconds: Seconds;
  };
  readonly needs: {
    /*
     * W0 decision: needs are deficits in [0, 1]; 0 = fully satisfied, 1 = critical.
     * §the-ships-day: rates are deficit per ship's day before trait multipliers, converted to per
     * second where read (`perDayToPerSecond`). A rate of 1 fills an empty need in one day; a
     * recovery rate `r` clears a full deficit in `1 / r` of a day.
     */
    /**
     * About 1 a day: a 0.25-nutrition ration offsets a quarter of it, so about four meals a day.
     */
    readonly hungerPerDay: number;
    /** About 2/3 a day awake and idle: rested to `seekThreshold` 0.5 in three quarters of a day. */
    readonly fatiguePerDayAwake: number;
    /** About 1 a day while on a task, half again the idle rate. */
    readonly fatiguePerDayWorking: number;
    /**
     * About 4.25 a day asleep, `(1 − wakeBelow) / sleepDays`: one `sleepDays` sleep clears a
     * day's fatigue, so one sleep a day suffices.
     */
    readonly fatigueRecoveryPerDayAsleep: number;
    /** About 2/3 a day: from comfortable to `seekThreshold` 0.5 in three quarters of a day. */
    readonly comfortPerDay: number;
    /** About 20 a day resting: a full deficit is cleared in 0.05 day. */
    readonly comfortRecoveryPerDayResting: number;
    /** About 1/2 a day: from content to `seekThreshold` 0.5 in about a day, so a chat a day. */
    readonly socialPerDay: number;
    /** About 10 a day chatting: a full deficit is cleared in 0.1 day. */
    readonly socialRecoveryPerDayChatting: number;
    /**
     * Slice 4: boredom per day (0.6: the seek threshold in a bit under a day). Activities restore
     * it (`ActivityDef.restores.recreation`).
     */
    readonly recreationPerDay: number;
    /** Deficit above which a personal activity becomes a routine candidate. */
    readonly seekThreshold: number;
    /** §the-ships-day: how long a meal takes, in days (0.0125 day is 15 s of a 1200 s day). */
    readonly mealDays: Days;
    /**
     * §the-ships-day: the shortest sleep, in days, before waking below `wakeBelow` ends it (0.2 day
     * is a fifth of the day, 240 s of a 1200 s day: ship life §2's one full sleep a day).
     */
    readonly sleepDays: Days;
    /** Wake when fatigue falls below this. */
    readonly wakeBelow: number;
    /**
     * §sleep-timing: bedtime. In one's sleep watch (the watch after one's own) anyone with
     * fatigue above this turns in, so a day's tiredness is slept off in the same window every
     * day; set so a full sleep's recovery cannot reach it again within the window (no second
     * nap), and a day awake always passes it.
     */
    readonly bedtimeAbove: number;
    /**
     * Integration 2 addition: initial need deficits for spawned crew are drawn uniformly from
     * these inclusive ranges on the `setup` stream, so the first minutes have motion.
     */
    readonly initialRange: Readonly<
      Record<
        "hunger" | "fatigue" | "comfort" | "social" | "recreation",
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
    /**
     * Skill gained per day of successful work, per level gap (SD §11.2: conservative).
     * §the-ships-day: 0.24 is a quarter of a level per day of practice. Unread until slice 2's helm
     * practice.
     */
    readonly skillGainPerDay: number;
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
    /**
     * Age in days after which a routine obligation is anyone's: a plate for the helm goes to the
     * cook or a dayworker before (§mess-call).
     */
    readonly routineAgingDays: Days;
    /**
     * Age in days after which a dirty room is anyone's on duty to mop; before it only the roles
     * that keep the room (`cleaningRolesFor`) do. Longer than `routineAgingDays`, so a dirty
     * corridor is the deckhand's for most of a watch and not the whole crew's after ninety
     * seconds (§mop-trips).
     */
    readonly cleaningAgingDays: Days;
  };
  readonly equipment: {
    /** Global hazard multiplier for tuning sweeps. */
    readonly hazardScale: number;
    /** Integrity lost per second above temperature 1.0. */
    readonly overheatDamagePerSecond: number;
    /** Condition below which a `maintenanceDue` problem is raised regardless of interval. */
    readonly maintenanceConditionBelow: number;
    /**
     * §maintenance-due: condition below which the `maintenanceDue` problem is essential rather than
     * routine, so the watch's engineer services a machine before it wears out instead of after the
     * nearer chores. Below `maintenanceConditionBelow`.
     */
    readonly maintenanceEssentialBelow: number;
    /**
     * §integrity: integrity below this derates output linearly (factor 1 here, 0 at
     * `integrityInoperableBelow`). Above it integrity does not affect output.
     */
    readonly integrityDerateBelow: number;
    /** §integrity: integrity below this makes the machine inoperable until a repair restores it. */
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
    /**
     * Route progress per second at full engine output, in the same units as
     * `PortDef.routes.distance`.
     */
    readonly nominalSpeed: number;
    /**
     * W6 addition: `TaskDerivationTable` planner-ranking estimate (SD §15.3) for a `staffStation`
     * task; staffing has no accumulated work, so 0 (present-or-not) is the usual value.
     */
    readonly staffEstimateSeconds: Seconds;
    /**
     * §departure-gate: an `engine`/`generator` machine whose output is below this while departure
     * is planned counts as impaired, and the departure gate asks the captain before leaving.
     */
    readonly departureMinOutput: number;
    /**
     * §limping: share of `nominalSpeed` a ship keeps in transit while its engines are below it and
     * no repair can bring them back with what is aboard (the parts or a tool are not there): the
     * engineer coaxes the engine along, so a lost part strands the ship for a while, never for
     * good. 0 drifts as before.
     */
    readonly limpSpeedFraction: number;
    /**
     * §calling-the-crew-aboard: how long departure prep calls people on the dock to come aboard
     * before the dock crew bring up whoever is still there, so a departure is never held forever by
     * someone who cannot (or will not) walk back.
     */
    readonly recallAboardSeconds: Seconds;
    /**
     * §local-behaviour: how often a local standing at their post steps to a neighbouring tile and
     * back.
     */
    readonly localShuffleSeconds: Seconds;
    /**
     * §dock-hand-errands: how long a dock hand's carting errand may take before the old instant
     * behaviour does it instead, with a `dockHandGaveUp` event, so nothing waits forever on a
     * blocked walk.
     */
    readonly dockHandGiveUpSeconds: Seconds;
    /**
     * §meetings-and-visitors: how long the captain and someone on the dock talk before that
     * person's card comes up ("talking with Fenwick Adair").
     */
    readonly talkSeconds: Seconds;
    /**
     * §meetings-and-visitors: how long the captain is out through the gate: to see someone in the
     * port beyond it before their card comes up, or for a look round when nothing was on offer.
     */
    readonly gateVisitSeconds: Seconds;
    /**
     * §give-up-and-leaving: how long a card may wait to be delivered in person (the captain walking
     * over, or the speaker walking to the ramp) before it comes up anyway, so no card waits forever
     * on a walk.
     */
    readonly cardDeliveryGiveUpSeconds: Seconds;
  };
  readonly commerce: {
    /**
     * Credits per unit distance per cargo unit, inclusive band. Narrator `offerJob` pay must fit.
     * `passenger` (passengers-and-galaxy §3.4) is per unit of path distance for one fare, doubled
     * for a round trip; luggage adds nothing. `errand` (expeditions A2, §6) is per unit of path
     * distance to the site and back (`errandPay`).
     */
    readonly priceBands: Readonly<
      Record<CargoClass | "passenger" | "errand", { readonly min: number; readonly max: number }>
    >;
    /** §the-ships-day: how long an offered job stays open, in days (0.5 is half a day). */
    readonly jobOfferTtlDays: Days;
    /**
     * W6 addition: flat integer credits charged on arrival at a port (SD §17.3 "simple running
     * costs"), so money can go down even on an uneventful loop. 0 = no fee.
     */
    readonly dockingFee: number;
    /** W6 addition: `TaskDerivationTable` planner-ranking estimate for a `haul` task (SD §15.3). */
    readonly haulEstimateSeconds: Seconds;
    /**
     * How long after a declined or expired offer at a port before the narrator is asked again
     * there (the `captainAshore` hook, D40), in days (§the-ships-day).
     */
    readonly reofferDays: Days;
    /**
     * Cap on total cargo units per job, clamped at offer time so a haul made of individually
     * spawned crates (one item per unit, see `jobs.ts` `acceptJob`) stays a short trip rather than
     * a long single-actor slog.
     */
    readonly maxCratesPerJob: number;
    /**
     * §fragile-cargo: the least share of a freight job's pay a delivery earns however many of its
     * crates were smashed; otherwise the pay is scaled by the share that arrived whole.
     */
    readonly brokenFloorShare: number;
    /** Passengers-and-galaxy §3.3: how long a round-trip passenger stays ashore. */
    readonly passage: {
      /**
       * `returnsAtTick` is drawn uniformly in [min, max] days after going ashore (§the-ships-day).
       */
      readonly ashoreDaysMin: Days;
      readonly ashoreDaysMax: Days;
      /**
       * Not back this many days after going ashore: the overdue card ("Wait for them" /
       * "Leave").
       */
      readonly overdueDays: Days;
    };
    /**
     * §reserve-kinds: the food the ship keeps aboard, in days of its people's hunger (the nutrition
     * of the food aboard over eaters × `needs.hungerPerDay`). Below `lowBelowDays`, while docked at
     * a port whose market sells food, the crew buy enough to bring it to `restockToDays`
     * (`reserveLow`, bought like a part). `lowBelowDays` 0 turns it off.
     */
    readonly foodReserve: { readonly lowBelowDays: Days; readonly restockToDays: Days };
    /**
     * §reserve-kinds: units of each `spare`-tagged item the ship keeps aboard. Docked at a port
     * whose market sells one, a shortfall is bought (`reserveLow`, routine), so a fault far from
     * port finds its part aboard. 0 keeps no reserve.
     */
    readonly sparesReserve: number;
    /** §port-markets: the parts market. */
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
    /**
     * Quiet-too-long hook fires after this many days without a narrative event (§the-ships-day; a
     * third of a day is one watch, so at most once a watch).
     */
    readonly quietTooLongDays: Days;
    /**
     * §staging-hook-and-the-hold: the `stageDock` hook is raised this long (as a distance at
     * `travel.nominalSpeed`) before the end of the route; transit holds at the end until it is
     * answered.
     */
    readonly approachHookLeadSeconds: Seconds;
    readonly maxSpawnsPerCommand: number;
    /**
     * Upper bound on `scheduleFault` window length. §the-ships-day: the one narrator cadence still
     * in seconds this slice.
     */
    readonly maxFaultWindowSeconds: Seconds;
    /**
     * Narrator budget (review §D.3), refilled to these values (and `hazardBudget`) every
     * `budgetRefillDays` (§the-ships-day; `core/pipeline.ts` runs the refill). Advice, never a
     * refusal (§narrator-lever-budgets).
     */
    readonly spawnBudget: number;
    readonly faultBudget: number;
    readonly budgetRefillDays: Days;
    /**
     * W6 addition: `SimEvent["type"]` names (kept as plain strings so `content.ts` need not
     * depend on `core/types/events`) whose `narrative`-significance occurrence raises the
     * `notableEvent` hook the following tick. Empty = never.
     */
    readonly hookOnEvents: readonly string[];
    /**
     * §notable-event-hook: event types (plain strings, as `hookOnEvents`) that raise `notableEvent`
     * at any significance, as the aftermath of something the narrator set in motion: the alert
     * standing down after a field, a hazard rolled, a fault it caused repaired. Some have a filter
     * of their own (`core/pipeline.ts` `hooksNarrator`: `faultRepaired` only for a fault with a
     * cause, and not while a field is on).
     */
    readonly aftermathHookOnEvents: readonly string[];
    /**
     * §debris-fields-and-ion-storms: narrator-caused navigation hazards before the budget refills
     * (`scheduleHazard`), a budget of their own beside spawns and faults.
     */
    readonly hazardBudget: number;
    /**
     * §money-levers: the largest credit one `transact` may pay the ship (a windfall, a reward, a
     * bribe taken); a debit is bounded by the balance instead.
     */
    readonly maxWindfall: number;
    /** §money-levers: the largest sum an offer's named pay (`offerJob.payCredits`) may be. */
    readonly maxOfferPay: number;
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
    /**
     * §auto-slowdown: `SimEvent["type"]` names (plain strings, as `narrator.hookOnEvents`) that
     * drop the web host's fast-forward back to 1× when playback reaches them.
     */
    readonly slowDownOnEvents: readonly string[];
    /**
     * §dirt-grid: how often (host real time, seconds) the worker posts a `DirtFrame` to the
     * renderer.
     */
    readonly dirtFrameEverySeconds: Seconds;
  };
  /**
   * §sections-and-dayworkers: watches replace shifts. Which section is on watch comes from the
   * scenario's bill against `time.watchesPerDay`; these are the rhythm's tunables.
   */
  readonly watches: {
    /**
     * Watches of the day (0-based, each `< time.watchesPerDay`) on which dayworkers are on duty.
     */
    readonly dayworkerOnWatches: readonly number[];
    /** How long before the bell the oncoming helm-stander makes for the helm. */
    readonly handoverLeadSeconds: Seconds;
    /** The handover at the helm's standby position, both present. */
    readonly handoverSeconds: Seconds;
    /** Longest a relief stands in for a stander away for a need before the relief post closes. */
    readonly reliefMaxDays: Days;
    /** How long a stander past a survival need waits for relief before leaving anyway. */
    readonly reliefNoShowSeconds: Seconds;
    /** A hold this many watches long earns `stoodLongWatch` (twice it, `doubleWatch`). */
    readonly longWatchFactor: number;
    /** An empty helm in transit this long raises `helmUnattended` (once per vacancy). */
    readonly helmUnattendedSeconds: Seconds;
    /** Time at each stop of a round. */
    readonly roundsStopSeconds: Seconds;
    /** The pause after a round before the next. */
    readonly roundsEveryDays: Days;
    /** Work to plot a course at the nav terminal, before the skill rate (work at a machine). */
    readonly plotCourseSeconds: Seconds;
  };
  /** §mood-and-work-speed: mood (the clamped sum of live thoughts) and its bounded effects. */
  readonly mood: {
    /** Mood below this is low: work at `lowWorkSpeed`. */
    readonly lowBelow: number;
    /** Mood above this is high: work at `highWorkSpeed`. */
    readonly highAbove: number;
    readonly lowWorkSpeed: number;
    readonly highWorkSpeed: number;
  };
  /**
   * §galley-and-mess-call: the galley. Meals are cooked before each bell from a crate of provisions
   * and served on the `serving` zone; the oncoming watch eats first. Days (§the-ships-day) for the
   * rhythm, seconds for work at the stove.
   */
  readonly galley: {
    /** How long before the bell `mealToCook` is raised for the coming watch. */
    readonly mealLeadDays: Days;
    /** How long after the bell an uncooked meal is given up (`mealMissed`). */
    readonly mealGraceDays: Days;
    /** Work at the stove, before the cook's skill rate (`workRate`). */
    readonly cookSeconds: Seconds;
    /** Age of `mealToCook` after which anyone with cooking ≥ 1 may take it from the cook. */
    readonly substituteAfterDays: Days;
    /** Servings cooked beyond the crew aboard (never more than `servingsPerCrate` in all). */
    readonly spareServings: number;
    /** Servings one crate of `provisions` makes. */
    readonly servingsPerCrate: number;
    /** How long a served meal lasts on the counter before the galley sweeps it. */
    readonly mealSpoilDays: Days;
    /** Hunger above which a known hot meal is a routine candidate (well under `seekThreshold`). */
    readonly mealCallHungerAbove: number;
    /**
     * §reserve-kinds, §galley-provisions: the provisions reserve, in days of meals (a crate is a
     * meal and a meal a watch, so crates aboard over `time.watchesPerDay`, plus the plates on the
     * counter as a fraction of one). Below `lowBelowDays`, docked at a port whose market sells
     * provisions, the crew buy crates to bring it to `restockToDays` (`reserveLow`, bought like a
     * part). 0 turns it off. Ration packs are `commerce.foodReserve`'s.
     */
    readonly lowBelowDays: Days;
    readonly restockToDays: Days;
    /** Cooking at or above this serves `good`; below `poorCookingBelow`, `poor`; else `plain`. */
    readonly goodCookingAbove: number;
    readonly poorCookingBelow: number;
    /**
     * Slice 4: hunger above which a known `treat` is a voluntary `eat` candidate, eaten where
     * found (below `mealCallHungerAbove`, so a treat never replaces dinner).
     */
    readonly treatHungerAbove: number;
  };
  /**
   * §dirt-grid: dirt. A cell is 0..255 (255 = 1.0 of dirt); footfall, boots and deposits are
   * unitless amounts of that 1.0; tiers are thresholds on a room's weighted dirt.
   */
  readonly dirt: {
    /** Dirt a step leaves on a deck tile. */
    readonly footfallPerStep: number;
    /** Share of a tile's dirt that sticks to boots per step. */
    readonly bootsPickup: number;
    /** Share of the boots' load shed on a tile per step. */
    readonly bootsShed: number;
    /** Boots load per step on dock floor, times the dock's `grime`. */
    readonly dockGrimePerStep: number;
    /** Dirt a day settles near an open ramp while docked, times the dock's `airborneDust`. */
    readonly airborneDustPerDay: number;
    /** How far from an open ramp door dust reaches (falling linearly with distance). */
    readonly airborneDustRadiusTiles: number;
    /** Dust settled per docked visit stops at this (`dirt.dustThisVisit`). */
    readonly airborneDustVisitCap: number;
    /** What each thing people do leaves behind, spread `depositRadiusTiles` round the tile. */
    readonly deposits: {
      readonly cooking: number;
      readonly serving: number;
      readonly eating: number;
      readonly spoiledMeal: number;
      readonly repair: number;
      readonly cargo: number;
    };
    readonly depositRadiusTiles: number;
    /** `roomDirt = (1 − roomMaxWeight) × mean + roomMaxWeight × max` over the room's cells. */
    readonly roomMaxWeight: number;
    /** Room dirt at which each tier begins. */
    readonly tiers: { readonly untidy: number; readonly dirty: number; readonly filthy: number };
    /** A room drops a tier only this far below its threshold. */
    readonly tierHysteresis: number;
    /** Dirt (of 1.0) a mopped tile loses per trip. */
    readonly mopPerTile: number;
    /** Work per tile, before the skill rate. */
    readonly mopSecondsPerTile: Seconds;
    /** Tiles one `cleanCompartment` trip covers (the dirtiest first). */
    readonly mopTilesPerTrip: number;
    /** Cadence of the dirt system's tier pass (a cadence of the sim, not of ship life). */
    readonly updateEverySeconds: Seconds;
    /** Renderer: alpha of the grime tint is `min(tintMaxAlpha, cell / 255 × tintScale)`. */
    readonly tintScale: number;
    readonly tintMaxAlpha: number;
  };
  /** §debris-fields-and-ion-storms: navigation hazards (the narrator's `scheduleHazard`). */
  readonly hazards: {
    /** The narrator's difficulty tiers as piloting-check difficulties (1-10). */
    readonly difficulty: { readonly easy: number; readonly hard: number; readonly brutal: number };
    /** A `delay` outcome sets the leg back this long at `travel.nominalSpeed`. */
    readonly delaySeconds: Seconds;
  };
  /** W4a addition: ambient chat (PLAN §6 W4a item 5). */
  readonly social: {
    /** Max tile distance between two crew for an ambient conversation. */
    readonly chatRadiusTiles: number;
    /** Min seconds between two conversations involving the same person. */
    readonly chatCooldownSeconds: Seconds;
    /** §ambient-chat: the chat templates, some gated on where the ship lies. */
    readonly templateLines: readonly ChatLineDef[];
    /** §ambient-chat: a pair's chat leaves a memory at most once in this many days. */
    readonly chatMemoryEveryDays: Days;
    /**
     * §ambient-chat: the chance, per side, that a chat leaves `rubbedWrong` rather than `chatted`:
     * `atZero − perPoint × compatibility`, clamped to [0, 1].
     */
    readonly chatSour: { readonly atZero: number; readonly perPoint: number };
    /**
     * §affinity: a pair's compatibility, an integer in ±`range`, symmetric and fixed by who they
     * are: `base − perValuePoint × (summed value-axis gaps) + perSharedLike × (likes in common)
     * − perClash × (one's likes the other dislikes, both ways)`, rounded.
     */
    readonly compatibility: {
      readonly base: number;
      readonly perValuePoint: number;
      readonly perSharedLike: number;
      readonly perClash: number;
      readonly range: number;
    };
    /** §memories: every memory's opinion, duration and stack limit. */
    readonly memories: Readonly<Record<MemoryKey, MemoryDef>>;
    /**
     * Slice 4: affinity is an integer in [-affinityRange, affinityRange] (§affinity: derived,
     * clamped).
     */
    readonly affinityRange: number;
    /** Slice 4: at or below this, someone is avoided (seats, sessions). */
    readonly avoidBelow: number;
    /** Slice 4: above this, someone is sought out (seats, sessions). */
    readonly preferAbove: number;
    /** Slice 4: a losing run this long at one activity against one person is a rivalry. */
    readonly rivalry: { readonly streakFor: number };
    /** Slice 4: debate stances within `agreeWithin` agree; beyond `argueBeyond` argue. */
    readonly debate: { readonly agreeWithin: number; readonly argueBeyond: number };
  };
  /** Slice 4: off-watch recreation (`systems/recreation/`). */
  readonly recreation: {
    /** Recreation above which joining an open session is a candidate (voluntary class). */
    readonly joinAbove: number;
    /** How long an open session waits for members before it starts or collapses. */
    readonly gatherSeconds: Seconds;
    /** How long after a session starts a latecomer may still join. */
    readonly lateJoinSeconds: Seconds;
    /** A host whose session collapsed does not host that activity again for this long. */
    readonly collapseBackoffDays: Days;
  };
  /** Slice 4: berths and the captain's cabin (`systems/cabins/`). */
  readonly cabins: {
    /** A bunkroom sleeper disturbed this long wakes with `noisyBunkroom`. */
    readonly noisySeconds: Seconds;
    /** Cadence of the `noBunkOfMyOwn` check. */
    readonly checkEverySeconds: Seconds;
    /** How long a `privateTalk` lasts with both in the cabin. */
    readonly privateTalkSeconds: Seconds;
    /** A `privateTalk` not held this long after it was called is missed. */
    readonly privateTalkWaitSeconds: Seconds;
  };
  /** §the-asteroid-field: the asteroid field (the narrator's `scheduleField`, `systems/field/`). */
  readonly field: {
    /** The helm's detection check falls this long before the field's start. */
    readonly warningSeconds: Seconds;
    /** The alert stands this long after the field ends. */
    readonly alertClearSeconds: Seconds;
    /** Per severity: mean impacts a minute, the share of large rocks, and the field's length. */
    readonly severities: Readonly<
      Record<
        FieldSeverity,
        {
          readonly impactsPerMinute: number;
          readonly largeShare: number;
          readonly lengthSeconds: Seconds;
        }
      >
    >;
    /** Call 8: a manned helm multiplies the rate by `1 − helmThreading × piloting / 10`. */
    readonly helmThreading: number;
    /** Call 8: the rate multiplier with nobody at the helm. */
    readonly unmannedRateFactor: number;
    /** Call 9: the rate multiplier while stuck (engines out, tumbling with the rocks). */
    readonly stuckRateFactor: number;
    /** Call 9: impacts taken while stuck before the ship drifts clear and the field ends. */
    readonly stuckDriftImpacts: number;
    /** Hull points one impact costs, by rock, however many tiles it covers. */
    readonly hullDamage: Readonly<Record<RockSize, number>>;
    /** Relative weights of the machine effects a rock rolls (call 7). */
    readonly machineEffects: Readonly<Record<MachineEffect, number>>;
    /** Integrity a `graze` and a `damage` take off a machine. */
    readonly effectIntegrity: { readonly graze: number; readonly damage: number };
    /** §patching-and-plating: the share of a scar's hull damage a patch kit restores underway. */
    readonly patchRecovers: number;
    /** Call 2: the most scripted impacts one `scheduleField` may carry. */
    readonly maxScripted: number;
    /**
     * §fragile-cargo: by rock, the chance each fragile crate of a live freight job in the struck
     * compartment is smashed.
     */
    readonly fragileBreakChance: Readonly<Record<RockSize, number>>;
  };
  /** §hull-scars-and-ship-loss: the crew's damage work (`systems/damage/`). */
  readonly damage: {
    /** Welding a patch kit over a scar. */
    readonly patchSeconds: Seconds;
    /** Fitting a hull plate over a scar at port. */
    readonly plateSeconds: Seconds;
    /** Repairing impact damage: seconds per whole unit of machine integrity restored. */
    readonly repairSecondsPerIntegrity: Seconds;
    /** A scout's look round a compartment once there. */
    readonly checkSeconds: Seconds;
  };
  /** §intercom-and-reporting: intercom panels (`systems/intercom/`). */
  readonly intercom: {
    /** A report at a panel. */
    readonly reportSeconds: Seconds;
  };
  /** §medicine: wounds treated at the medbay bed (`systems/medical/`). */
  readonly medical: {
    /** The medic's work at the bedside, per untreated wound. */
    readonly treatSecondsPerWound: Seconds;
    /** `medical`-tagged units one treatment uses up. */
    readonly kitsPerTreatment: number;
    /** §medical-supplies: `medical`-tagged units the ship keeps aboard, bought at port. */
    readonly reserve: number;
    /** A patient waiting at the bed with no kit aboard gives up after this long. */
    readonly giveUpAfterSeconds: Seconds;
    /** §extraction: taking up a downed patient, once beside them. */
    readonly liftSeconds: Seconds;
    /** §extraction: laying the carried patient on the medbay bed, once beside it. */
    readonly laySeconds: Seconds;
  };
  /**
   * §accidents-aboard: wounds outside a fight (`systems/bodies/accidents.ts`). Each chance is
   * doubled for someone whose fatigue is past `urgency.needEssentialAbove`.
   */
  readonly accidents: {
    /** Off, no hazard is rolled (tests that pin a run's numbers turn it off). */
    readonly enabled: boolean;
    /** Chance a second of working at a machine past its `heat.derateAbove` burns an arm. */
    readonly hotWorkPerSecond: number;
    /** Chance a second of carrying cargo in a filthy room ends in a slip and a hurt leg. */
    readonly slipPerSecond: number;
    /** Chance each rock impact throws someone unbraced in the struck room. */
    readonly impactThrowChance: number;
    /** The ticker's line for each hazard: `{who}` the hurt, `{machine}` the hot machine. */
    readonly lines: Readonly<Record<AccidentHazard, string>>;
  };
  /**
   * Expeditions A1 (§7.1, SD §12): bodies. Part damage against `tolerance` gives a part's
   * function; wounds add damage and pain, bleed, and heal; capacities follow (`core/body.ts`).
   */
  readonly bodies: {
    /** Damage at which a part stops working (and a head or torso kills). */
    readonly tolerance: Readonly<Record<BodyPart, number>>;
    /** Part damage one wound of each severity adds. */
    readonly severityDamage: Readonly<Record<WoundSeverity, number>>;
    /** Pain one wound of each severity adds (pain is in [0, 1]). */
    readonly severityPain: Readonly<Record<WoundSeverity, number>>;
    readonly painDecayPerSecond: number;
    /** Blood lost per second while a wound of each severity bleeds. */
    readonly bleedPerSecond: Readonly<Record<WoundSeverity, number>>;
    /** A wound of each severity stops bleeding on its own this long after it was made. */
    readonly bleedStopsAfterSeconds: Readonly<Record<WoundSeverity, Seconds>>;
    /** Blood regained per second while nothing bleeds. */
    readonly bloodRecoverPerSecond: number;
    /** Consciousness debt one stun hit adds (`Body.stun`). */
    readonly stunPerHit: number;
    readonly stunDecayPerSecond: number;
    /** Below either floor someone is incapacitated. */
    readonly incapacitatedBelow: { readonly consciousness: number; readonly movement: number };
    /** Blood below this is death. */
    readonly deadBelowBlood: number;
    /** Share of a wound's damage healed a day once it no longer bleeds. */
    readonly healPerDay: number;
    /** §treatment-at-the-medbay-bed: a treated wound heals this many times `healPerDay`. */
    readonly treatedHealFactor: number;
    /** §treatment-at-the-medbay-bed: pain taken off the body when its wounds are treated. */
    readonly treatPainRelief: number;
    /** Relative weights of where a hit lands, and where a stun hit lands. */
    readonly partTable: Readonly<Record<BodyPart, number>>;
    readonly stunPartTable: Readonly<Record<BodyPart, number>>;
  };
  /**
   * Expeditions A1 (§8): the fight. Seconds for cadences, factors for hit chance, resolve deltas
   * per event or per second (`morale`), thresholds with hysteresis.
   */
  readonly expedition: {
    /** Each combatant decides this often (staggered by actor index). */
    readonly decideEverySeconds: Seconds;
    /** A fight still going this long after contact ends `timedOut`. */
    readonly maxFightSeconds: Seconds;
    /**
     * The party on the site floor this long under any posture but `creep` is contact (the
     * landing was loud), noticed or not.
     */
    readonly contactAfterSeconds: Seconds;
    /** An approach with no contact this long after the party is ashore ends `timedOut`. */
    readonly maxApproachSeconds: Seconds;
    /**
     * A target who wants out keeps low this long after contact, then makes for the exit (unless
     * cornered first): the party's window to take them.
     */
    readonly targetBoltsAfterSeconds: Seconds;
    /**
     * A steady guard with no party member in sight this long after contact leaves the post to
     * find a line to them (ruling 2).
     */
    readonly guardSearchAfterSeconds: Seconds;
    /** The alert stands this long after the fight resolves. */
    readonly alertClearSeconds: Seconds;
    readonly hitSkillBase: number;
    readonly hitPerFighting: number;
    /** Range falloff: 1 at point blank, this at the weapon's full range. */
    readonly rangeFalloffFloor: number;
    readonly coverPenalty: number;
    readonly movingTargetFactor: number;
    readonly movingShooterFactor: number;
    readonly resolveTiers: Readonly<Record<ResolveTier, number>>;
    /**
     * A cast member's tie to the target: a factor on their resolve (capped at 1) and their
     * loyalty; ignored (factor 1, loyalty 0) for the target and bystanders.
     */
    readonly tie: Readonly<Record<TieTier, { readonly resolve: number; readonly loyalty: number }>>;
    /** A cast member's `fighting` skill by their resolve tier (their generated crew def's). */
    readonly castFighting: Readonly<Record<ResolveTier, number>>;
    readonly crewResolve: {
      readonly base: number;
      readonly perFighting: number;
      readonly perMood: number;
      readonly perLeaderAffinity: number;
    };
    readonly morale: {
      readonly hitSelf: number;
      readonly allyDown: number;
      readonly allyDead: number;
      readonly underFireNoCoverPerSecond: number;
      readonly outnumberedPerSecond: number;
      readonly allyHit: number;
      readonly inCoverPerSecond: number;
      readonly leaderNearPerSecond: number;
      readonly outflanked: number;
      readonly targetTaken: number;
      readonly waverBelow: number;
      readonly breakBelow: number;
      readonly recoverAbove: number;
    };
    /** The party withdraws at its first casualty, or with this share of it down. */
    readonly withdrawWhen: { readonly firstDown: number; readonly halfDown: number };
    readonly leaderNearTiles: number;
    readonly surrenderIfCornered: boolean;
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
 * §issuers-and-pitches (2026-09-30): who offers work, for the null narrator's offline offers
 * (`data/people/`). Names are drawn from the shared lists; roles, organisations and extra pitch
 * lines are per port, so the people at a mining outpost sound like it. Pitch lines take `{cargo}`,
 * `{from}` and `{to}` placeholders and never mention pay (§cards-never-mention-pay).
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
   * §issuers-and-pitches name table. Optional so hand-built test bundles need not carry one;
   * without it the null narrator falls back to the template's `issuer` as the person's name.
   */
  readonly people?: PeopleTableDef;
  /**
   * Dockside §3: dock maps by id, at most one per port. Optional so hand-built test bundles need
   * not carry any; a port without one keeps the transfer-tile behaviour.
   */
  readonly docks?: Readonly<Record<DockDefId, DockDef>>;
  /**
   * §thoughts: every thought's def; required, so a missing one fails validation (and
   * `createWorld`).
   */
  readonly thoughts: Readonly<Record<ThoughtKey, ThoughtDef>>;
  /** Slice 4: off-watch activities by id (required; may be empty in a hand-built bundle). */
  readonly activities: Readonly<Record<ActivityDefId, ActivityDef>>;
  /** Slice 4: debate topics by id (required; may be empty in a hand-built bundle). */
  readonly topics: Readonly<Record<TopicDefId, TopicDef>>;
  readonly config: ConfigDef;
  readonly hash: string;
}
