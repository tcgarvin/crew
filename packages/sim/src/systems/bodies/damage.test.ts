/**
 * Expeditions A1 (§7.1): `applyDamage`, the one damage entry point, on the bodies fixture. The
 * numbers are `core/body.ts`'s formulas at the default bundle's config.
 */
import { describe, expect, it } from "vitest";
import { BODY_PARTS, type BodyPart } from "../../core/types/content";
import {
  BETTINA,
  JAX,
  MARA,
  PRIYA,
  actorOf,
  bodiesWorld,
  bodiesWorldViolations,
  handBlaster,
  woundNow,
} from "./fixtures/bodies-deck";

const only = (part: BodyPart): Record<BodyPart, number> =>
  Object.fromEntries(BODY_PARTS.map((p) => [p, p === part ? 1 : 0])) as Record<BodyPart, number>;

const types = (drafts: readonly { type: string }[]) => drafts.map((d) => d.type);

describe("applyDamage (§7.1)", () => {
  it("a serious blaster wound to a leg: movement 0.7, hands unchanged, bleeding, in pain", () => {
    const { world } = bodiesWorld();
    const { result, drafts } = woundNow(world, JAX, {
      part: "leftLeg",
      severity: "serious",
      type: "blaster",
      byActorId: MARA,
    });
    const jax = actorOf(world, JAX);
    expect(result).toMatchObject({ part: "leftLeg", incapacitated: false, died: false });
    expect(jax.body.wounds).toEqual([
      expect.objectContaining({
        id: result.woundId,
        part: "leftLeg",
        severity: "serious",
        bleeding: true,
        causeActorId: MARA,
      }),
    ]);
    expect(jax.body.parts.leftLeg.damage).toBeCloseTo(1.2, 12);
    expect(jax.body.pain).toBeCloseTo(0.3, 12);
    expect(jax.capacities.movement).toBeCloseTo(0.7, 12);
    expect(jax.capacities.manipulation).toBe(1);
    expect(jax.availability).toBe("available");
    expect(types(drafts)).toEqual(["wounded", "thoughtAdded"]);
    expect(drafts[0]?.payload).toMatchObject({ actorId: JAX, byActorId: MARA, part: "leftLeg" });
    expect(jax.thoughts.map((t) => t.key)).toContain("wounded");
    expect(bodiesWorldViolations(world)).toEqual([]);
  });

  it("two serious wounds on one arm leave manipulation at half", () => {
    const { world } = bodiesWorld();
    const hit = { part: "rightArm", severity: "serious", type: "blunt" } as const;
    woundNow(world, PRIYA, hit);
    woundNow(world, PRIYA, hit);
    const priya = actorOf(world, PRIYA);
    expect(priya.capacities.manipulation).toBeCloseTo(0.5, 12);
    expect(priya.capacities.movement).toBe(1);
    expect(priya.body.wounds.map((w) => w.bleeding)).toEqual([false, false]);
    expect(bodiesWorldViolations(world)).toEqual([]);
  });

  it("a grave head wound kills at once, with died naming the shooter", () => {
    const { world } = bodiesWorld();
    const { result, drafts } = woundNow(world, BETTINA, {
      part: "head",
      severity: "grave",
      type: "blaster",
      byActorId: JAX,
    });
    const bettina = actorOf(world, BETTINA);
    expect(result.died).toBe(true);
    expect(bettina.availability).toBe("dead");
    expect(bettina.activity).toEqual({ kind: "idle" });
    expect(bettina.movement).toEqual({ kind: "stationary" });
    expect(types(drafts)).toEqual(["wounded", "thoughtAdded", "died"]);
    expect(drafts[2]?.payload).toEqual({ actorId: BETTINA, cause: "wound", byActorId: JAX });
    expect(bodiesWorldViolations(world)).toEqual([]);
    expect(() =>
      woundNow(world, BETTINA, { part: "torso", severity: "graze", type: "blunt" }),
    ).toThrow(/already dead/);
  });

  it("a grave torso wound does not kill at once: it is a bleeder", () => {
    const { world } = bodiesWorld();
    const { result } = woundNow(world, JAX, { part: "torso", severity: "grave", type: "blaster" });
    expect(result).toMatchObject({ died: false, incapacitated: false });
    expect(actorOf(world, JAX).body.wounds[0]?.bleeding).toBe(true);
  });

  it("an unaimed hit lands by the hit's table, and a stun hit only on a limb", () => {
    const { world } = bodiesWorld();
    const { result } = woundNow(world, JAX, {
      severity: "graze",
      type: "blunt",
      partTable: only("rightLeg"),
    });
    expect(result.part).toBe("rightLeg");
    const parts = new Set<BodyPart>();
    for (let i = 0; i < 40; i++) {
      const { world: w } = bodiesWorld({ seed: i + 1 });
      parts.add(woundNow(w, PRIYA, { severity: "serious", type: "stun" }).result.part);
    }
    expect(parts.has("head")).toBe(false);
    expect(parts.has("torso")).toBe(false);
    expect(parts.size).toBeGreaterThan(1);
  });

  it("stun: no damage or pain; one hit staggers, the second puts them down", () => {
    const { world } = bodiesWorld();
    const stun = { part: "leftArm", severity: "serious", type: "stun" } as const;
    const first = woundNow(world, MARA, stun);
    const mara = actorOf(world, MARA);
    expect(first.result.incapacitated).toBe(false);
    expect(mara.body.stun).toBeCloseTo(0.5, 12);
    expect(mara.body.parts.leftArm.damage).toBe(0);
    expect(mara.body.pain).toBe(0);
    expect(mara.capacities.consciousness).toBeCloseTo(0.5, 12);
    expect(types(first.drafts)).toEqual(["wounded"]);
    const second = woundNow(world, MARA, stun);
    expect(second.result.incapacitated).toBe(true);
    expect(mara.availability).toBe("incapacitated");
    expect(mara.capacities.consciousness).toBe(0);
    expect(second.drafts.at(-1)).toMatchObject({
      type: "incapacitated",
      payload: { actorId: MARA, cause: "stun" },
    });
    // A third on someone already down adds to the debt but does not take them down twice.
    const third = woundNow(world, MARA, stun);
    expect(types(third.drafts)).toEqual(["wounded"]);
    expect(third.result.incapacitated).toBe(true);
    expect(bodiesWorldViolations(world)).toEqual([]);
  });

  it("someone going down drops the blaster at their feet", () => {
    const { world } = bodiesWorld();
    const blaster = handBlaster(world, PRIYA);
    const stun = { part: "rightLeg", severity: "serious", type: "stun" } as const;
    woundNow(world, PRIYA, stun);
    expect(world.state.items[blaster]?.location).toEqual({ kind: "carriedBy", actorId: PRIYA });
    woundNow(world, PRIYA, stun);
    const priya = actorOf(world, PRIYA);
    if (priya.location.kind !== "onDeck") throw new Error("Priya is not on deck");
    expect(world.state.items[blaster]?.location).toEqual({
      kind: "onDeck",
      deckId: priya.location.deckId,
      x: Math.floor(priya.location.x) + 0.5,
      y: Math.floor(priya.location.y) + 0.5,
    });
    expect(world.caches.index.itemsByHolder[PRIYA] ?? []).toEqual([]);
    expect(bodiesWorldViolations(world)).toEqual([]);
  });
});
