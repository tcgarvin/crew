import { describe, expect, it } from "vitest";
import { FIXTURE_SOCIAL } from "./fixtures/ship-life";
import { affinitiesFrom, affinityOf, compatibility, emptySocial, rivalryKey } from "./social";
import type { Interests, Values } from "./types/actor";
import type { ConfigDef } from "./types/content";
import type { ActivityDefId, ActorId } from "./types/ids";

const A = "a1" as ActorId;
const B = "a2" as ActorId;
const C = "a3" as ActorId;
const CARDS = "activity.cards" as ActivityDefId;

/** The default bundle's compatibility weights (the fixture's are all 0). */
const WEIGHTS = { base: 2, perValuePoint: 0.5, perSharedLike: 1, perClash: 1, range: 2 };
const SOCIAL: ConfigDef["social"] = {
  chatRadiusTiles: 2,
  chatCooldownSeconds: 45,
  templateLines: ["{a} joked"],
  ...FIXTURE_SOCIAL,
  compatibility: WEIGHTS,
};

function person(values: [number, number, number], interests: Partial<Interests> = {}) {
  const [orderFreedom, faithReason, loyaltyAmbition] = values;
  const v: Values = { orderFreedom, faithReason, loyaltyAmbition };
  return { values: v, interests: { likes: [], dislikes: [], ...interests } };
}

describe("core/social", () => {
  it("emptySocial is a fresh slice with no captain's table yet", () => {
    const one = emptySocial();
    expect(one).toEqual({ relationships: {}, rivalries: {}, sessions: {}, captainsTableDay: -1 });
    one.relationships[A] = {};
    expect(emptySocial().relationships).toEqual({});
  });

  it("compatibility: alike and sharing a like is the most; far apart and clashing the least", () => {
    const keen = person([1, 1, 1], { likes: ["cards"] });
    expect(compatibility(keen, person([1, 1, 1], { likes: ["cards"] }), WEIGHTS)).toBe(2);
    // 2 − 0.5 × 6 = −1, and the cards one likes and the other dislikes −1 more.
    const opposite = person([-1, -1, -1], { likes: ["debate"], dislikes: ["cards"] });
    expect(compatibility(keen, opposite, WEIGHTS)).toBe(-2);
    // 2 − 0.5 × 5 = −0.5 rounds to 0, never −0.
    expect(Object.is(compatibility(keen, person([-1, -1, 0]), WEIGHTS), 0)).toBe(true);
    // The same both ways.
    expect(compatibility(opposite, keen, WEIGHTS)).toBe(compatibility(keen, opposite, WEIGHTS));
  });

  it("affinityOf is compatibility plus the memories held, from one side only, clamped", () => {
    const actors = {
      [A]: person([1, 1, 1], { likes: ["cards"] }),
      [B]: person([1, 1, 1], { likes: ["cards"] }),
      [C]: person([1, 1, 1], { likes: ["cards"] }),
    };
    const expiresAtTick = 100;
    const state = {
      actors,
      social: {
        relationships: {
          [A]: {
            [B]: {
              memories: [
                { key: "argued" as const, expiresAtTick },
                { key: "chatted" as const, expiresAtTick },
              ],
            },
          },
        },
      },
    } as unknown as Parameters<typeof affinityOf>[0];
    // 2 − 2 + 1.
    expect(affinityOf(state, SOCIAL, A, B)).toBe(1);
    expect(affinityOf(state, SOCIAL, B, A)).toBe(2);
    expect(affinitiesFrom(state, SOCIAL, A)).toEqual({ [B]: 1, [C]: 2 });
    const clamped = { ...SOCIAL, affinityRange: 1 };
    expect(affinityOf(state, clamped, C, A)).toBe(1);
    expect(() => affinityOf(state, SOCIAL, A, A)).toThrow(/not a pair/);
    expect(() => affinityOf(state, SOCIAL, A, "a9" as ActorId)).toThrow(/not a pair/);
  });

  it("rivalryKey orders the two ids so either side finds one row", () => {
    expect(rivalryKey(B, A, CARDS)).toBe("a1|a2|activity.cards");
    expect(rivalryKey(A, B, CARDS)).toBe(rivalryKey(B, A, CARDS));
  });
});
