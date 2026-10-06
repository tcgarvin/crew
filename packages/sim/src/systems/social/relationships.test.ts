import { describe, expect, it } from "vitest";
import { dayTicks } from "../../core/clock";
import { affinityOf, rivalryKey } from "../../core/social";
import type { MemoryKey } from "../../core/types/content";
import type { ActorId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import { needsViolations } from "../needs/invariants";
import { ACT, JAX, NOOR, TOMAS, galleyStepCtx, socialWorld } from "./fixtures/social-world";
import { addMemory, pruneSocial } from "./relationships";
import { SOCIAL_EVERY_TICKS, socialSystem } from "./social";

const feel = (world: World, from: ActorId, to: ActorId) =>
  affinityOf(world.state, world.config.values.social, from, to);
const keysHeld = (world: World, from: ActorId, to: ActorId) =>
  world.state.social.relationships[from]?.[to]?.memories.map((m) => m.key) ?? [];

describe("addMemory (D88)", () => {
  it("creates the entry on the first memory, and says how affinity moved (trace)", () => {
    const { world } = socialWorld();
    const { ctx, drafts } = galleyStepCtx(world);
    expect(world.state.social.relationships[JAX]).toBeUndefined();
    addMemory(ctx, JAX, TOMAS, "goodTalk");
    expect(world.state.social.relationships[JAX]?.[TOMAS]).toEqual({
      memories: [{ key: "goodTalk", expiresAtTick: ctx.tick + dayTicks(ctx.config, 5) }],
    });
    expect(world.state.social.relationships[TOMAS]).toBeUndefined();
    expect(feel(world, JAX, TOMAS)).toBe(2);
    expect(drafts.map((d) => [d.type, d.payload])).toEqual([
      ["affinityChanged", { fromActorId: JAX, toActorId: TOMAS, delta: 2, affinity: 2 }],
    ]);
  });

  it("stacks to the memory's limit, then refreshes the oldest instead of adding", () => {
    const { world } = socialWorld();
    const day = dayTicks(world.config.values, 1);
    const chat = (tick: number) => {
      world.state.tick = tick;
      addMemory(galleyStepCtx(world).ctx, JAX, TOMAS, "chatted");
    };
    chat(0);
    chat(day);
    expect(feel(world, JAX, TOMAS)).toBe(2);
    chat(2 * day);
    // Still two, still +2: the one from tick 0 now runs from 2 days on.
    expect(feel(world, JAX, TOMAS)).toBe(2);
    expect(
      world.state.social.relationships[JAX]?.[TOMAS]?.memories.map((m) => m.expiresAtTick),
    ).toEqual([2 * day + 1 + 5 * day, day + 1 + 5 * day]);
    expect(needsViolations(world)).toEqual([]);
  });

  it("affinity never leaves ±10, however much is remembered", () => {
    const { world } = socialWorld();
    const { ctx, drafts } = galleyStepCtx(world);
    const warm: MemoryKey[] = ["goodTalk", "heardMeOut", "chatted", "chatted", "goodTime"];
    const warmer: MemoryKey[] = ["goodTime", "playedForMe", "sharedATable", "talkedItThrough"];
    for (const key of [...warm, ...warmer]) addMemory(ctx, JAX, TOMAS, key);
    expect(feel(world, JAX, TOMAS)).toBe(10);
    // The last memory pushed the sum to 11; only one of it showed.
    expect(drafts.map((d) => (d.payload as { delta: number }).delta).at(-1)).toBe(1);
    expect(drafts).toHaveLength(warm.length + warmer.length - 1);
  });

  it("refuses a self-pair and a stranger", () => {
    const { world } = socialWorld();
    const { ctx } = galleyStepCtx(world);
    expect(() => addMemory(ctx, JAX, JAX, "chatted")).toThrow(/pair of actors/);
    expect(() => addMemory(ctx, JAX, "a99" as ActorId, "chatted")).toThrow(/pair of actors/);
  });
});

describe("the social invariants (needsViolations)", () => {
  it("flags a memory past its stack limit, a malformed rivalry and a bad captain's table day", () => {
    const { world } = socialWorld();
    const expiresAtTick = world.state.tick + 100;
    world.state.social.relationships[JAX] = {
      [TOMAS]: { memories: [1, 2, 3].map(() => ({ key: "chatted", expiresAtTick })) },
    };
    world.state.social.rivalries[`${TOMAS}|${JAX}|${ACT.cards}`] = {
      wins: 1,
      losses: 0,
      streak: 2,
    };
    world.state.social.captainsTableDay = -2;
    expect(needsViolations(world)).toEqual([
      `social.relationships.${JAX}.${TOMAS} holds 3 of chatted`,
      `social.rivalries.${TOMAS}|${JAX}|${ACT.cards} is not "<a>|<b>|<activity>" with a < b`,
      `social.rivalries.${TOMAS}|${JAX}|${ACT.cards}.streak 2 does not fit 1–0`,
      "social.captainsTableDay is -2",
    ]);
  });
});

describe("pruneSocial and the social system", () => {
  it("a memory counts until its expiry tick, then it and an entry left empty are gone", () => {
    const { world } = socialWorld();
    const { ctx } = galleyStepCtx(world);
    addMemory(ctx, JAX, TOMAS, "argued");
    const expiresAtTick =
      world.state.social.relationships[JAX]?.[TOMAS]?.memories[0]?.expiresAtTick;
    if (expiresAtTick === undefined) throw new Error("no memory");
    pruneSocial({ state: world.state, tick: expiresAtTick - 1 });
    expect(feel(world, JAX, TOMAS)).toBe(-2);
    pruneSocial({ state: world.state, tick: expiresAtTick });
    expect(world.state.social.relationships).toEqual({});
    expect(feel(world, JAX, TOMAS)).toBe(0);
  });

  it("keeps an entry with only a chat time in it, for the chat's once-in-a-while", () => {
    const { world } = socialWorld();
    world.state.social.relationships[JAX] = { [TOMAS]: { memories: [], lastChatTick: 5 } };
    pruneSocial({ state: world.state, tick: 10_000 });
    expect(world.state.social.relationships[JAX]?.[TOMAS]).toEqual({
      memories: [],
      lastChatTick: 5,
    });
  });

  it("a passenger who left is pruned from relationships and rivalries", () => {
    const { world } = socialWorld();
    const { ctx } = galleyStepCtx(world);
    addMemory(ctx, JAX, NOOR, "goodTalk");
    addMemory(ctx, JAX, TOMAS, "chatted");
    addMemory(ctx, NOOR, JAX, "goodTime");
    world.state.social.rivalries[rivalryKey(JAX, NOOR, ACT.cards)] = {
      wins: 1,
      losses: 0,
      streak: 1,
    };
    world.state.social.rivalries[rivalryKey(JAX, TOMAS, ACT.cards)] = {
      wins: 0,
      losses: 1,
      streak: -1,
    };
    delete world.state.actors[NOOR];
    pruneSocial(ctx);
    expect(Object.keys(world.state.social.relationships)).toEqual([JAX]);
    expect(keysHeld(world, JAX, TOMAS)).toEqual(["chatted"]);
    expect(Object.keys(world.state.social.relationships[JAX] ?? {})).toEqual([TOMAS]);
    expect(Object.keys(world.state.social.rivalries)).toEqual([rivalryKey(JAX, TOMAS, ACT.cards)]);
  });

  it("the system prunes every tick, in the needs phase after the commerce sweep", () => {
    const { world } = socialWorld();
    const { ctx } = galleyStepCtx(world);
    addMemory(ctx, JAX, NOOR, "goodTalk");
    delete world.state.actors[NOOR];
    socialSystem.run(ctx);
    expect(world.state.social.relationships).toEqual({});
    expect(socialSystem.every).toBe(SOCIAL_EVERY_TICKS);
    expect(socialSystem.phase).toBe("needs");
  });
});
