/**
 * §grief on the bodies fixture: a crewmate's death gives every other living member of the ship's
 * company `grieving` about them, twice for those close to them; a passenger's death, and the
 * passengers, the dead and the dead themselves, take none.
 */
import { describe, expect, it } from "vitest";
import { affinityOf } from "../../core/social";
import type { ActorId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import { addMemory } from "../social/relationships";
import {
  BETTINA,
  JAX,
  MARA,
  PRIYA,
  actorOf,
  bodiesWorld,
  bodiesWorldViolations,
  stepCtxOf,
  woundNow,
} from "./fixtures/bodies-deck";

const kill = (world: World, id: ActorId) =>
  woundNow(world, id, { part: "head", severity: "grave", type: "blaster" });

/** The grieving thoughts `id` holds about `deadId`. */
const griefOf = (world: World, id: ActorId, deadId: ActorId) =>
  actorOf(world, id).thoughts.filter((t) => t.key === "grieving" && t.refId === deadId);

describe("grief (§grief)", () => {
  it("every living crewmate grieves the dead once, by name; the dead themselves do not", () => {
    const { world } = bodiesWorld();
    const { drafts } = kill(world, BETTINA);
    for (const id of [JAX, MARA, PRIYA]) {
      expect(affinityOf(world.state, world.config.values.social, id, BETTINA)).toBeLessThan(3);
      expect(griefOf(world, id, BETTINA)).toHaveLength(1);
    }
    expect(actorOf(world, BETTINA).thoughts.some((t) => t.key === "grieving")).toBe(false);
    const value = world.content.thoughts.grieving?.value ?? 0;
    expect(griefOf(world, JAX, BETTINA)[0]?.value).toBe(value);
    expect(drafts.filter((d) => d.type === "thoughtAdded")).toHaveLength(4);
    expect(bodiesWorldViolations(world)).toEqual([]);
  });

  it("one close to the dead (affinity at griefCloseAffinity or more) grieves twice", () => {
    const { world } = bodiesWorld();
    const { ctx } = stepCtxOf(world);
    addMemory(ctx, JAX, BETTINA, "carriedMeOut");
    addMemory(ctx, JAX, BETTINA, "foughtBeside");
    const config = world.config.values;
    expect(affinityOf(world.state, config.social, JAX, BETTINA)).toBeGreaterThanOrEqual(
      config.medical.griefCloseAffinity,
    );
    kill(world, BETTINA);
    expect(griefOf(world, JAX, BETTINA)).toHaveLength(config.medical.griefStacksClose);
    expect(griefOf(world, MARA, BETTINA)).toHaveLength(1);
    // The close grieve harder.
    expect(actorOf(world, JAX).mood).toBeLessThan(actorOf(world, MARA).mood);
  });

  it("blood loss kills through the same rule: the crew grieve", () => {
    const test = bodiesWorld();
    const { world } = test;
    actorOf(world, PRIYA).body.blood = world.config.values.bodies.deadBelowBlood - 0.01;
    test.kernel.advance(world, 20);
    expect(actorOf(world, PRIYA).availability).toBe("dead");
    for (const id of [JAX, MARA, BETTINA]) expect(griefOf(world, id, PRIYA)).toHaveLength(1);
  });

  it("nobody grieves a passenger, and a passenger grieves nobody", () => {
    const dying = bodiesWorld().world;
    actorOf(dying, PRIYA).passenger = true;
    kill(dying, PRIYA);
    for (const id of [JAX, MARA, BETTINA]) expect(griefOf(dying, id, PRIYA)).toEqual([]);

    const riding = bodiesWorld().world;
    actorOf(riding, PRIYA).passenger = true;
    kill(riding, BETTINA);
    expect(griefOf(riding, JAX, BETTINA)).toHaveLength(1);
    expect(griefOf(riding, PRIYA, BETTINA)).toEqual([]);
  });
});
