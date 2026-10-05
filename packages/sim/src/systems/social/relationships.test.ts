import { describe, expect, it } from "vitest";
import { affinityOf, rivalryKey } from "../../core/social";
import type { ActorId } from "../../core/types/ids";
import { needsViolations } from "../needs/invariants";
import {
  ACT,
  JAX,
  NOOR,
  TOMAS,
  actorOf,
  galleyStepCtx,
  socialWorld,
} from "./fixtures/social-world";
import { moveAffinity, pruneSocial } from "./relationships";
import { SOCIAL_EVERY_TICKS, socialSystem } from "./social";

describe("moveAffinity (call 9)", () => {
  it("creates the entry on the first move and says so (trace)", () => {
    const { world } = socialWorld();
    const { ctx, drafts } = galleyStepCtx(world);
    expect(world.state.social.relationships[JAX]).toBeUndefined();
    moveAffinity(ctx, JAX, TOMAS, 2);
    expect(world.state.social.relationships[JAX]?.[TOMAS]).toEqual({ affinity: 2 });
    expect(world.state.social.relationships[TOMAS]).toBeUndefined();
    expect(drafts.map((d) => [d.type, d.payload])).toEqual([
      ["affinityChanged", { fromActorId: JAX, toActorId: TOMAS, delta: 2, affinity: 2 }],
    ]);
  });

  it("never leaves [−10, 10]", () => {
    const { world } = socialWorld();
    const { ctx, drafts } = galleyStepCtx(world);
    moveAffinity(ctx, JAX, TOMAS, 25);
    expect(affinityOf(world.state.social, JAX, TOMAS)).toBe(10);
    moveAffinity(ctx, JAX, TOMAS, 3);
    expect(affinityOf(world.state.social, JAX, TOMAS)).toBe(10);
    moveAffinity(ctx, JAX, TOMAS, -30);
    expect(affinityOf(world.state.social, JAX, TOMAS)).toBe(-10);
    // A move against the cap changes nothing and says nothing.
    expect(drafts.map((d) => (d.payload as { delta: number }).delta)).toEqual([10, -20]);
    expect(needsViolations(world)).toEqual([]);
  });

  it("refuses a fractional delta, a self-pair and a stranger", () => {
    const { world } = socialWorld();
    const { ctx } = galleyStepCtx(world);
    expect(() => moveAffinity(ctx, JAX, TOMAS, 0.5)).toThrow(/not whole/);
    expect(() => moveAffinity(ctx, JAX, JAX, 1)).toThrow(/themselves/);
    expect(() => moveAffinity(ctx, JAX, "a99" as ActorId, 1)).toThrow(/not an actor/);
  });

  it("a zero move creates nothing", () => {
    const { world } = socialWorld();
    const { ctx, drafts } = galleyStepCtx(world);
    moveAffinity(ctx, JAX, TOMAS, 0);
    expect(world.state.social.relationships).toEqual({});
    expect(drafts).toEqual([]);
  });
});

describe("the social invariants (needsViolations)", () => {
  it("flags an affinity beyond the range, a malformed rivalry and a bad captain's table day", () => {
    const { world } = socialWorld();
    world.state.social.relationships[JAX] = { [TOMAS]: { affinity: 11 } };
    world.state.social.rivalries[`${TOMAS}|${JAX}|${ACT.cards}`] = {
      wins: 1,
      losses: 0,
      streak: 2,
    };
    world.state.social.captainsTableDay = -2;
    expect(needsViolations(world)).toEqual([
      `social.relationships.${JAX}.${TOMAS}.affinity 11 is outside ±10`,
      `social.rivalries.${TOMAS}|${JAX}|${ACT.cards} is not "<a>|<b>|<activity>" with a < b`,
      `social.rivalries.${TOMAS}|${JAX}|${ACT.cards}.streak 2 does not fit 1–0`,
      "social.captainsTableDay is -2",
    ]);
  });
});

describe("pruneSocial and the social system", () => {
  it("a passenger who left is pruned from relationships and rivalries", () => {
    const { world } = socialWorld();
    const { ctx } = galleyStepCtx(world);
    moveAffinity(ctx, JAX, NOOR, 2);
    moveAffinity(ctx, JAX, TOMAS, 1);
    moveAffinity(ctx, NOOR, JAX, 3);
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
    expect(world.state.social.relationships).toEqual({ [JAX]: { [TOMAS]: { affinity: 1 } } });
    expect(Object.keys(world.state.social.rivalries)).toEqual([rivalryKey(JAX, TOMAS, ACT.cards)]);
  });

  it("the system prunes every tick, in the needs phase after the commerce sweep", () => {
    const { world } = socialWorld();
    const { ctx } = galleyStepCtx(world);
    moveAffinity(ctx, JAX, NOOR, 2);
    delete world.state.actors[NOOR];
    socialSystem.run(ctx);
    expect(world.state.social.relationships).toEqual({});
    expect(socialSystem.every).toBe(SOCIAL_EVERY_TICKS);
    expect(socialSystem.phase).toBe("needs");
  });
});
