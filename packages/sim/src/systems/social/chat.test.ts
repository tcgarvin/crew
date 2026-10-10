import { describe, expect, it } from "vitest";
import { dayTicks } from "../../core/clock";
import { affinityOf } from "../../core/social";
import type { ConfigDef } from "../../core/types/content";
import type { ActorId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import { onConversation } from "./chat";
import {
  JAX,
  TOMAS,
  actorOf,
  galleyStepCtx,
  setCharacter,
  socialWorld,
} from "./fixtures/social-world";

const feel = (world: World, from: ActorId, to: ActorId) =>
  affinityOf(world.state, world.config.values.social, from, to);
const keysHeld = (world: World, from: ActorId, to: ActorId) =>
  world.state.social.relationships[from]?.[to]?.memories.map((m) => m.key) ?? [];

/** A chat between Jax and Tomas at `tick`, under `social` (the fixture's when omitted). */
function chatAt(world: World, tick: number, social?: Partial<ConfigDef["social"]>): void {
  world.state.tick = tick;
  const { ctx } = galleyStepCtx(world);
  const config = { ...ctx.config, social: { ...ctx.config.social, ...social } };
  onConversation({ ...ctx, config }, actorOf(world, JAX), actorOf(world, TOMAS));
}

describe("ambient chat (call 10; §ambient-chat)", () => {
  it("leaves `chatted` each way once, not again within the window, and again after", () => {
    const { world } = socialWorld();
    const day = dayTicks(world.config.values, 1);
    chatAt(world, 10);
    expect(keysHeld(world, JAX, TOMAS)).toEqual(["chatted"]);
    expect(keysHeld(world, TOMAS, JAX)).toEqual(["chatted"]);
    chatAt(world, 20);
    chatAt(world, 10 + day - 1);
    expect(feel(world, JAX, TOMAS)).toBe(1);
    // The other way round is the same pair.
    world.state.tick = 30;
    onConversation(galleyStepCtx(world).ctx, actorOf(world, TOMAS), actorOf(world, JAX));
    expect(feel(world, TOMAS, JAX)).toBe(1);
    chatAt(world, 10 + day);
    expect(feel(world, JAX, TOMAS)).toBe(2);
    expect(feel(world, TOMAS, JAX)).toBe(2);
    expect(world.state.social.relationships[JAX]?.[TOMAS]?.lastChatTick).toBe(11 + day);
  });

  it("chatting every day holds a pair at the stack limit rather than warming them for ever", () => {
    const { world } = socialWorld();
    const day = dayTicks(world.config.values, 1);
    for (let d = 0; d < 20; d++) chatAt(world, d * day);
    expect(feel(world, JAX, TOMAS)).toBe(2);
    expect(keysHeld(world, JAX, TOMAS)).toEqual(["chatted", "chatted"]);
  });

  it("a sour chance of 1 leaves `rubbedWrong` both ways", () => {
    const sour = socialWorld().world;
    chatAt(sour, 10, { chatSour: { atZero: 1, perPoint: 0 } });
    expect(keysHeld(sour, JAX, TOMAS)).toEqual(["rubbedWrong"]);
    expect(keysHeld(sour, TOMAS, JAX)).toEqual(["rubbedWrong"]);
    expect(feel(sour, JAX, TOMAS)).toBe(-1);
  });

  it("compatibility sets the odds: a well-matched pair rarely grates, a clashing pair often", () => {
    const compatibility = { base: 2, perValuePoint: 0.5, perSharedLike: 1, perClash: 1, range: 2 };
    const chatSour = { atZero: 0.25, perPoint: 0.1 };
    const sourShare = (alike: boolean) => {
      let sour = 0;
      const seeds = 80;
      for (let seed = 1; seed <= seeds; seed++) {
        const { world } = socialWorld(seed);
        setCharacter(world, JAX, { likes: ["cards"], values: [2, 2, 2] });
        setCharacter(
          world,
          TOMAS,
          alike
            ? { likes: ["cards"], values: [2, 2, 2] }
            : { dislikes: ["cards"], values: [-2, -2, -2] },
        );
        chatAt(world, 10, { compatibility, chatSour });
        if (keysHeld(world, JAX, TOMAS).includes("rubbedWrong")) sour += 1;
      }
      return sour / seeds;
    };
    // Compatibility +2 sours 5 % of chats, −2 sours 45 %.
    expect(sourShare(true)).toBeLessThan(0.15);
    expect(sourShare(false)).toBeGreaterThan(0.3);
  });
});
