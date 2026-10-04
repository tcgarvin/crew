import { describe, expect, it } from "vitest";
import { MARA, crewWorld } from "../systems/work/fixtures/crew-deck";
import { dayTicks } from "./clock";
import { type ThoughtCtx, addThought, moodOf, moodWorkFactor } from "./thoughts";
import type { Actor } from "./types/actor";
import type { EventDraft } from "./types/events";
import type { ActorId, EntityId } from "./types/ids";

function setup(tick = 100) {
  const { world } = crewWorld();
  const mara = world.state.actors[MARA];
  if (mara === undefined) throw new Error("no mara");
  const emitted: EventDraft[] = [];
  const ctx: ThoughtCtx = {
    content: world.content,
    config: world.config.values,
    tick,
    emit: (event) => emitted.push(event),
  };
  return { ctx, mara, emitted, thoughts: world.content.thoughts };
}

const at = (ctx: ThoughtCtx, tick: number): ThoughtCtx => ({ ...ctx, tick });

describe("addThought (D79)", () => {
  it("gives the def's value until the def's duration has passed, and says so in a trace event", () => {
    const { ctx, mara, emitted, thoughts } = setup();
    addThought(ctx, mara, "stoodLongWatch");
    const def = thoughts.stoodLongWatch;
    expect(mara.thoughts).toEqual([
      {
        key: "stoodLongWatch",
        value: def.value,
        expiresAtTick: 100 + dayTicks(ctx.config, def.durationDays),
      },
    ]);
    expect(emitted).toEqual([
      expect.objectContaining({
        type: "thoughtAdded",
        subjectIds: [MARA],
        payload: { actorId: MARA, key: "stoodLongWatch" },
      }),
    ]);
  });

  it("refreshes a non-stacking thought's expiry instead of holding it twice", () => {
    const { ctx, mara, thoughts } = setup();
    expect(thoughts.doubleWatch.stacks).toBe(false);
    addThought(ctx, mara, "doubleWatch");
    addThought(at(ctx, 500), mara, "doubleWatch");
    expect(mara.thoughts).toHaveLength(1);
    expect(mara.thoughts[0]?.expiresAtTick).toBe(
      500 + dayTicks(ctx.config, thoughts.doubleWatch.durationDays),
    );
    expect(mara.mood).toBeCloseTo(thoughts.doubleWatch.value);
  });

  it("keeps a non-stacking thought about someone else apart (refId)", () => {
    const { ctx, mara } = setup();
    addThought(ctx, mara, "doubleWatch", "a7" as ActorId as EntityId);
    addThought(ctx, mara, "doubleWatch", "a8" as ActorId as EntityId);
    addThought(ctx, mara, "doubleWatch", "a8" as ActorId as EntityId);
    expect(mara.thoughts.map((t) => t.refId)).toEqual(["a7", "a8"]);
  });

  it("appends a stacking thought each time it is had", () => {
    const { ctx, mara, thoughts } = setup();
    expect(thoughts.helmCleanPass.stacks).toBe(true);
    addThought(ctx, mara, "helmCleanPass");
    addThought(at(ctx, 200), mara, "helmCleanPass");
    expect(mara.thoughts).toHaveLength(2);
    expect(mara.mood).toBeCloseTo(2 * thoughts.helmCleanPass.value);
  });

  it("brings mood up to date at once, so a thought had after the needs phase is counted", () => {
    const { ctx, mara, thoughts } = setup();
    addThought(ctx, mara, "helmScrape");
    expect(mara.mood).toBeCloseTo(thoughts.helmScrape.value);
  });

  it("throws on a key the content has no def for", () => {
    const { ctx, mara } = setup();
    const bare: ThoughtCtx = { ...ctx, content: { ...ctx.content, thoughts: {} as never } };
    expect(() => addThought(bare, mara, "helmScrape")).toThrow(/no thought "helmScrape"/);
  });
});

describe("moodOf (D79)", () => {
  const holding = (...thoughts: Actor["thoughts"]) => ({ thoughts });

  it("sums only the thoughts still live at the tick (expiresAtTick is the first tick they do not count)", () => {
    const actor = holding(
      { key: "helmCleanPass", value: 0.1, expiresAtTick: 50 },
      { key: "helmScrape", value: -0.3, expiresAtTick: 100 },
    );
    expect(moodOf(actor, 10)).toBeCloseTo(-0.2);
    expect(moodOf(actor, 50)).toBeCloseTo(-0.3);
    expect(moodOf(actor, 100)).toBe(0);
  });

  it("clamps to [-1, 1]", () => {
    const low = holding(
      { key: "doubleWatch", value: -0.8, expiresAtTick: 10 },
      { key: "stoodLongWatch", value: -0.7, expiresAtTick: 10 },
    );
    expect(moodOf(low, 0)).toBe(-1);
    const high = holding(
      { key: "helmCleanPass", value: 0.9, expiresAtTick: 10 },
      { key: "helmCleanPass", value: 0.9, expiresAtTick: 10 },
    );
    expect(moodOf(high, 0)).toBe(1);
  });
});

describe("moodWorkFactor (D79)", () => {
  it("is the low speed below lowBelow, the high speed above highAbove, else 1", () => {
    const { ctx } = setup();
    const { lowBelow, highAbove, lowWorkSpeed, highWorkSpeed } = ctx.config.mood;
    expect(moodWorkFactor({ mood: lowBelow - 0.01 }, ctx.config)).toBe(lowWorkSpeed);
    expect(moodWorkFactor({ mood: lowBelow }, ctx.config)).toBe(1);
    expect(moodWorkFactor({ mood: 0 }, ctx.config)).toBe(1);
    expect(moodWorkFactor({ mood: highAbove }, ctx.config)).toBe(1);
    expect(moodWorkFactor({ mood: highAbove + 0.01 }, ctx.config)).toBe(highWorkSpeed);
  });
});
