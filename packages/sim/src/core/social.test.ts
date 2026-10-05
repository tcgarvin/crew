import { describe, expect, it } from "vitest";
import { affinityOf, emptySocial, rivalryKey } from "./social";
import type { ActivityDefId, ActorId } from "./types/ids";

const A = "a1" as ActorId;
const B = "a2" as ActorId;
const CARDS = "activity.cards" as ActivityDefId;

describe("core/social", () => {
  it("emptySocial is a fresh slice with no captain's table yet", () => {
    const one = emptySocial();
    expect(one).toEqual({ relationships: {}, rivalries: {}, sessions: {}, captainsTableDay: -1 });
    one.relationships[A] = {};
    expect(emptySocial().relationships).toEqual({});
  });

  it("affinityOf reads the directed entry, 0 when absent", () => {
    const social = { relationships: { [A]: { [B]: { affinity: 3 } } } };
    expect(affinityOf(social, A, B)).toBe(3);
    expect(affinityOf(social, B, A)).toBe(0);
    expect(affinityOf({ relationships: {} }, A, B)).toBe(0);
  });

  it("rivalryKey orders the two ids so either side finds one row", () => {
    expect(rivalryKey(B, A, CARDS)).toBe("a1|a2|activity.cards");
    expect(rivalryKey(A, B, CARDS)).toBe(rivalryKey(B, A, CARDS));
  });
});
