/**
 * W2 test fixture (slice 4): the galley fixture's ship (airlock, galley, mess with a four-seat
 * table, bunkroom, bridge; Bettina, Noor, Mara the captain, Jax, Tomas) with the social system
 * registered and the activities the outcome tests need beside the fixture three: a debate, a vid
 * (bond), music (perform), sparring (contest with risk and dirt), tinkering (skill), baking
 * (a product) and a sharp contest (a memory only from loser to winner). `the_guild` is
 * re-weighted so (2, 1, 2) against (−2, 0, −1) argues (W4 tunes the authored weights).
 *
 * Sessions are built by hand (W1's lounge fixture and session lifecycle live in another stream):
 * `handSession` makes a row that is never stored, as `resolveOutcome` reads only its argument.
 */
import { rebuildActorIndex } from "../../../core/caches";
import { dayTicks } from "../../../core/clock";
import type { TestWorld } from "../../../core/fixtures/test-world";
import { createKernel } from "../../../core/kernel";
import { createRegistry } from "../../../core/registry";
import type { Interests, Values } from "../../../core/types/actor";
import type { TileCoord } from "../../../core/types/common";
import type {
  ActivityDef,
  ContentBundle,
  InterestTag,
  ItemDef,
  MemoryKey,
  TopicDef,
} from "../../../core/types/content";
import type {
  ActivityDefId,
  ActorId,
  CompartmentId,
  ItemDefId,
  SessionId,
  TopicDefId,
} from "../../../core/types/ids";
import type { World } from "../../../core/types/kernel";
import type { RngApi, StepCtx } from "../../../core/types/pipeline";
import type { GroupSession, SessionVenue, SocialMemory } from "../../../core/types/state";
import type { Activity } from "../../../core/types/work";
import { registerPlannerDefaults } from "../../../planner/index";
import {
  GALLEY,
  galleyConfig,
  galleyContent,
  galleyStepCtx,
  placeOnGalleyDeck,
} from "../../galley/fixtures/galley-deck";
import { registerGalley } from "../../galley/index";
import { galleyTaskDerivations } from "../../galley/tasks";
import { registerNeeds } from "../../needs/index";
import { registerSpatial } from "../../spatial/index";
import { rebuildReservations } from "../../spatial/reservations";
import { fixtureEffectiveConfig } from "../../travel/fixtures";
import { registerTravel } from "../../travel/index";
import { travelTaskDerivations } from "../../travel/tasks";
import { registerWatch } from "../../watch/index";
import { registerWork } from "../../work/index";
import { registerSocial } from "../index";

export {
  BETTINA,
  JAX,
  MARA,
  NOOR,
  SEATS,
  TOMAS,
  addServing,
  onGalleyDeck,
} from "../../galley/fixtures/galley-deck";

export const ACT = {
  cards: "activity.cards" as ActivityDefId,
  sharp: "activity.test.sharp_cards" as ActivityDefId,
  debate: "activity.test.debate" as ActivityDefId,
  vids: "activity.test.vids" as ActivityDefId,
  music: "activity.test.music" as ActivityDefId,
  sparring: "activity.test.sparring" as ActivityDefId,
  tinkering: "activity.test.tinkering" as ActivityDefId,
  baking: "activity.test.baking" as ActivityDefId,
} as const;

export const TOPIC = {
  guild: "topic.the_guild" as TopicDefId,
  philosophy: "topic.philosophy" as TopicDefId,
  vid: "topic.the_vid" as TopicDefId,
} as const;

export const TREAT = "item.test.treat" as ItemDefId;

const base = {
  participants: { min: 2, max: 4 },
  durationDays: 0.1,
  restores: { recreation: 0.3 },
} as const;

const EXTRA_ACTIVITIES: readonly ActivityDef[] = [
  {
    ...base,
    id: ACT.sharp,
    label: "playing sharp cards",
    waitingLabel: "waiting for sharp cards",
    interest: "cards",
    venue: [{ machineTag: "messTable" }],
    outcome: "contest",
    thoughts: { win: "wonContest", lose: "lostContest" },
    memories: { loserToWinner: "beatMe" },
  },
  {
    ...base,
    id: ACT.debate,
    label: "debating",
    waitingLabel: "waiting for a debate",
    interest: "debate",
    venue: [{ compartmentTag: "mess" }],
    participants: { min: 2, max: 3 },
    durationDays: 0.06,
    outcome: "debate",
    topics: [TOPIC.guild, TOPIC.philosophy],
  },
  {
    ...base,
    id: ACT.vids,
    label: "watching a vid",
    waitingLabel: "waiting for a vid",
    interest: "vids",
    venue: [{ compartmentTag: "mess" }],
    participants: { min: 1, max: 4 },
    outcome: "bond",
    topics: [TOPIC.vid],
    thoughts: { joined: "goodCompany" },
    memories: { together: "goodTime" },
  },
  {
    ...base,
    id: ACT.music,
    label: "playing the harmonica",
    waitingLabel: "playing the harmonica",
    interest: "music",
    venue: [{ compartmentTag: "mess" }],
    participants: { min: 1, max: 1 },
    durationDays: 0.05,
    outcome: "perform",
    thoughts: { listened: "enjoyedMusic", listenedDislike: "hatedTheNoise" },
  },
  {
    ...base,
    id: ACT.sparring,
    label: "sparring",
    waitingLabel: "waiting for a sparring partner",
    interest: "sparring",
    venue: [{ compartmentTag: "mess" }],
    participants: { min: 2, max: 2 },
    durationDays: 0.04,
    outcome: "contest",
    thoughts: { win: "wonContest", lose: "lostContest" },
    risk: { injuryChance: 1 },
    dirt: 0.05,
    fatigueCost: 0.1,
  },
  {
    ...base,
    id: ACT.tinkering,
    label: "tinkering",
    waitingLabel: "tinkering",
    interest: "tinkering",
    venue: [{ compartmentTag: "mess" }],
    participants: { min: 1, max: 1 },
    outcome: "none",
    skillGain: { skill: "engineering", perDay: 0.2 },
  },
  {
    ...base,
    id: ACT.baking,
    label: "baking",
    waitingLabel: "baking",
    interest: "cooking",
    venue: [{ machineTag: "stove" }],
    participants: { min: 1, max: 1 },
    durationDays: 0.05,
    outcome: "none",
    blockedByProblems: ["mealToCook"],
    produces: { itemDefId: TREAT, count: 4, zoneTag: "serving" },
  },
];

/** `the_guild` re-weighted so the plan's (2, 1, 2) and (−2, 0, −1) argue (gate notes). */
const GUILD: TopicDef = {
  id: TOPIC.guild,
  label: "the Guild",
  weights: { orderFreedom: -1, faithReason: 0, loyaltyAmbition: -0.5 },
};

const TREAT_DEF: ItemDef = {
  id: TREAT,
  name: "Treat",
  stacking: "stackable",
  maxStack: 20,
  tags: ["food", "consumable", "treat"],
  toolKinds: [],
  mass: 0.1,
  nutrition: 0.05,
};

export function socialContent(): ContentBundle {
  const content = galleyContent(galleyConfig());
  return {
    ...content,
    activities: {
      ...content.activities,
      ...Object.fromEntries(EXTRA_ACTIVITIES.map((def) => [def.id, def])),
    },
    topics: { ...content.topics, [GUILD.id]: GUILD },
    items: { ...content.items, [TREAT]: TREAT_DEF },
    hash: "social-galley-v1",
  };
}

/** The galley fixture's systems plus `registerSocial`. */
export function socialWorld(seed = 5): TestWorld {
  const config = galleyConfig();
  const registry = createRegistry();
  registerSpatial(registry);
  registerTravel(registry);
  registerNeeds(registry);
  registerWatch(registry);
  registerGalley(registry);
  registerSocial(registry);
  registerWork(registry, {
    derivations: { ...travelTaskDerivations, ...galleyTaskDerivations },
  });
  registerPlannerDefaults(registry);
  const kernel = createKernel(registry);
  const world = kernel.createWorld(
    GALLEY.scenario,
    seed,
    socialContent(),
    fixtureEffectiveConfig(config),
  );
  return { registry, kernel, world };
}

export function actorOf(world: World, id: ActorId) {
  const actor = world.state.actors[id];
  if (actor === undefined) throw new Error(`no actor ${id}`);
  return actor;
}

/** Give `id` these interests (the first like strong when `strong`) and values. */
export function setCharacter(
  world: World,
  id: ActorId,
  character: {
    likes?: readonly InterestTag[];
    strong?: InterestTag;
    dislikes?: readonly InterestTag[];
    values?: readonly [number, number, number];
  },
): void {
  const actor = actorOf(world, id);
  const interests: Interests = {
    likes: [...(character.likes ?? [])],
    dislikes: [...(character.dislikes ?? [])],
    ...(character.strong === undefined ? {} : { strong: character.strong }),
  };
  const [orderFreedom, faithReason, loyaltyAmbition] = character.values ?? [0, 0, 0];
  const values: Values = { orderFreedom, faithReason, loyaltyAmbition };
  actor.interests = interests;
  actor.values = values;
}

/** Stand everyone named on these tiles and bring the compartment index and reservations up to date. */
export function placeAll(world: World, where: Readonly<Record<ActorId, TileCoord>>): void {
  for (const [id, tile] of Object.entries(where)) placeOnGalleyDeck(world, id as ActorId, tile);
  refreshIndexes(world);
}

export function refreshIndexes(world: World): void {
  rebuildActorIndex(world.content, world.state, world.caches.index);
  rebuildReservations(world.caches, world.state);
}

/** The state id of the compartment with this deck key (`mess`, `galley`, `quarters`). */
export function compartmentOf(world: World, key: string): CompartmentId {
  const compartment = Object.values(world.state.compartments).find((c) => c.key === key);
  if (compartment === undefined) throw new Error(`no compartment ${key}`);
  return compartment.id;
}

/** A session row as the recreation system would hold it at its end (never stored). */
export function handSession(
  world: World,
  activityId: ActivityDefId,
  members: readonly ActorId[],
  options: {
    venue?: Omit<SessionVenue, "compartmentId">;
    room?: string;
    topicId?: TopicDefId;
  } = {},
): GroupSession {
  const host = members[0];
  if (host === undefined) throw new Error("handSession: no members");
  const tick = world.state.tick;
  return {
    id: "s1" as SessionId,
    activityId,
    venue: { compartmentId: compartmentOf(world, options.room ?? "mess"), ...options.venue },
    hostId: host,
    members: [...members],
    openedTick: tick,
    startedTick: tick,
    endsAtTick: tick,
    ...(options.topicId === undefined ? {} : { topicId: options.topicId }),
  };
}

export function defOf(world: World, id: ActivityDefId): ActivityDef {
  const def = world.content.activities[id];
  if (def === undefined) throw new Error(`no activity ${id}`);
  return def;
}

/** A step context whose contests always go to `winnerId` (the rest of the rng is the world's). */
export function riggedCtx(world: World, winnerId: ActorId): ReturnType<typeof galleyStepCtx> {
  const { ctx, drafts } = galleyStepCtx(world);
  const rng: RngApi = {
    ...ctx.rng,
    weighted: <T>(_stream: Parameters<RngApi["weighted"]>[0], items: readonly { item: T }[]) => {
      const pick = items.find(({ item }) => (item as { id?: ActorId }).id === winnerId);
      if (pick === undefined) throw new Error(`riggedCtx: ${winnerId} is not playing`);
      return pick.item;
    },
  };
  const rigged: StepCtx = { ...ctx, rng };
  return { ctx: rigged, drafts };
}

/** Lay `id` down asleep where they stand (a sleep hold, as the sleep plan ends in). */
export function asleep(world: World, id: ActorId): void {
  const tick = world.state.tick;
  const activity: Activity = {
    kind: "personal",
    activity: "sleep",
    urgency: "routineObligation",
    action: { kind: "sleep", stage: "asleep", progress: 0, startedTick: tick, interruptible: true },
    sinceTick: tick,
    plan: { steps: [{ kind: "hold", hold: "sleep", sinceTick: tick }], stepIndex: 0 },
  };
  actorOf(world, id).activity = activity;
}

export { galleyStepCtx };

/**
 * §affinity: `from` feels `affinity` about `to` (compatibility is 0 in this fixture's config) by a
 * set of memories within their stack limits, larger opinions first, written straight into state
 * with a day to run. Throws when the memory table cannot make `affinity` exactly.
 */
export function feels(world: World, from: ActorId, to: ActorId, affinity: number): void {
  const { memories } = world.config.values.social;
  const expiresAtTick = world.state.tick + dayTicks(world.config.values, 1);
  const held: SocialMemory[] = [];
  let left = affinity;
  const keys = (Object.keys(memories) as MemoryKey[])
    .filter((key) => Math.sign(memories[key].opinion) === Math.sign(affinity))
    .sort((a, b) => Math.abs(memories[b].opinion) - Math.abs(memories[a].opinion));
  for (const key of keys) {
    const { opinion, stackLimit } = memories[key];
    for (let i = 0; i < stackLimit && Math.abs(left) >= Math.abs(opinion); i++) {
      held.push({ key, expiresAtTick });
      left -= opinion;
    }
  }
  if (left !== 0) throw new Error(`feels: no set of memories makes ${affinity}`);
  const row = world.state.social.relationships[from] ?? {};
  world.state.social.relationships[from] = row;
  row[to] = { ...row[to], memories: held };
}
