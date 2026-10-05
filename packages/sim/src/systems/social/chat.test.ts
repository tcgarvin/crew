import { describe, expect, it } from "vitest";
import { dayTicks } from "../../core/clock";
import { affinityOf } from "../../core/social";
import { onConversation } from "./chat";
import { JAX, TOMAS, actorOf, galleyStepCtx, socialWorld } from "./fixtures/social-world";
import { moveAffinity } from "./relationships";

describe("ambient chat (call 10)", () => {
  it("gives +1 each way once, not again within a day, and again after", () => {
    const { world } = socialWorld();
    const jax = actorOf(world, JAX);
    const tomas = actorOf(world, TOMAS);
    const day = dayTicks(world.config.values, 1);
    const chat = (tick: number) => {
      world.state.tick = tick;
      const { ctx } = galleyStepCtx(world);
      onConversation(ctx, jax, tomas);
    };
    chat(10);
    expect(affinityOf(world.state.social, JAX, TOMAS)).toBe(1);
    expect(affinityOf(world.state.social, TOMAS, JAX)).toBe(1);
    chat(20);
    chat(10 + day - 1);
    expect(affinityOf(world.state.social, JAX, TOMAS)).toBe(1);
    // The other way round is the same pair.
    world.state.tick = 30;
    onConversation(galleyStepCtx(world).ctx, tomas, jax);
    expect(affinityOf(world.state.social, TOMAS, JAX)).toBe(1);
    chat(10 + day);
    expect(affinityOf(world.state.social, JAX, TOMAS)).toBe(2);
    expect(affinityOf(world.state.social, TOMAS, JAX)).toBe(2);
    expect(world.state.social.relationships[JAX]?.[TOMAS]?.lastChatTick).toBe(11 + day);
  });

  it("still remembers the chat when the affinity is pinned at the cap", () => {
    const { world } = socialWorld();
    const { ctx } = galleyStepCtx(world);
    moveAffinity(ctx, JAX, TOMAS, 10);
    onConversation(ctx, actorOf(world, JAX), actorOf(world, TOMAS));
    expect(world.state.social.relationships[JAX]?.[TOMAS]).toEqual({
      affinity: 10,
      lastChatTick: ctx.tick,
    });
    expect(affinityOf(world.state.social, TOMAS, JAX)).toBe(1);
  });
});
