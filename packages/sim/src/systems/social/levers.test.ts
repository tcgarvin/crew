/**
 * §memory-levers, §thought-and-reveal-levers (D106): the narrator's `plantMemory`, `fallOut` and
 * `giveThought` on the social fixture (Bettina, Noor, Mara the captain, Jax, Tomas aboard).
 */
import { describe, expect, it } from "vitest";
import { dayTicks } from "../../core/clock";
import { cmd } from "../../core/fixtures/test-world";
import type { TestWorld } from "../../core/fixtures/test-world";
import { tickerLine } from "../../core/render";
import { affinityOf } from "../../core/social";
import type { CommandPayloadMap, EnqueueResult } from "../../core/types/commands";
import type { NarratorMemoryKey } from "../../core/types/content";
import type { SimEvent } from "../../core/types/events";
import type { ActorId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import { needsViolations } from "../needs/invariants";
import { JAX, NOOR, TOMAS, actorOf, socialWorld } from "./fixtures/social-world";
import { pruneSocial } from "./relationships";

type LeverKind = "plantMemory" | "fallOut" | "giveThought";

function send<K extends LeverKind>(
  test: TestWorld,
  kind: K,
  payload: CommandPayloadMap[K],
): { result: EnqueueResult; events: readonly SimEvent[] } {
  const result = test.kernel.enqueueCommand(
    test.world,
    cmd({ source: "narrator", kind, payload } as Parameters<typeof test.kernel.enqueueCommand>[1]),
  );
  const events = result.status === "accepted" ? test.kernel.advance(test.world, 1).events : [];
  return { result, events };
}

const reasonOf = (result: EnqueueResult) =>
  result.status === "rejected" ? result.rejection.reason : "accepted";

const feel = (world: World, from: ActorId, to: ActorId) =>
  affinityOf(world.state, world.config.values.social, from, to);

const held = (world: World, from: ActorId, to: ActorId) =>
  world.state.social.relationships[from]?.[to]?.memories ?? [];

const plant = (from: ActorId, to: ActorId, key: NarratorMemoryKey, lasting = false) => ({
  fromActorId: from,
  toActorId: to,
  key,
  lasting,
});

describe("plantMemory (§memory-levers)", () => {
  it("a betrayal carries any pair past at odds, and a life saved past close to, on its own", () => {
    const test = socialWorld();
    const { world } = test;
    const range = world.config.values.social.compatibility.range;
    expect(world.config.values.social.memories.betrayedMe.opinion + range).toBeLessThanOrEqual(-3);
    expect(world.config.values.social.memories.savedMyLife.opinion - range).toBeGreaterThanOrEqual(
      3,
    );
    const { result, events } = send(test, "plantMemory", plant(JAX, TOMAS, "betrayedMe"));
    expect(result.status).toBe("accepted");
    expect(feel(world, JAX, TOMAS)).toBeLessThanOrEqual(-3);
    // Directed: Tomas feels nothing new about Jax.
    expect(held(world, TOMAS, JAX)).toEqual([]);
    const planted = events.find((e) => e.type === "memoryPlanted");
    expect(planted?.significance).toBe("notable");
    expect(planted === undefined ? "" : tickerLine(planted, world.state, world.content)).toBeNull();
    send(test, "plantMemory", plant(NOOR, TOMAS, "savedMyLife"));
    expect(feel(world, NOOR, TOMAS)).toBeGreaterThanOrEqual(3);
    expect(needsViolations(world)).toEqual([]);
  });

  it("a timed one expires like any memory; a lasting one survives far past its days", () => {
    const test = socialWorld();
    const { world } = test;
    send(test, "plantMemory", plant(JAX, TOMAS, "wrongedOverSomeone"));
    send(test, "plantMemory", plant(NOOR, TOMAS, "betrayedMe", true));
    const later = world.state.tick + dayTicks(world.config.values, 60);
    pruneSocial({ state: world.state, tick: later });
    expect(held(world, JAX, TOMAS)).toEqual([]);
    expect(held(world, NOOR, TOMAS)).toEqual([{ key: "betrayedMe", lasting: true }]);
  });

  it("only another planted memory between the same two, that way round, clears a lasting one", () => {
    const test = socialWorld();
    const { world } = test;
    send(test, "plantMemory", plant(NOOR, TOMAS, "betrayedMe", true));
    send(test, "plantMemory", plant(TOMAS, NOOR, "madeItRight"));
    expect(held(world, NOOR, TOMAS)).toEqual([{ key: "betrayedMe", lasting: true }]);
    send(test, "plantMemory", plant(NOOR, TOMAS, "madeItRight"));
    expect(held(world, NOOR, TOMAS).map((m) => m.key)).toEqual(["madeItRight"]);
    expect("lasting" in (held(world, NOOR, TOMAS)[0] ?? {})).toBe(false);
  });

  it("refuses one person, nobody, the dead, someone off the ship and a key the narrator has not", () => {
    const test = socialWorld();
    expect(reasonOf(send(test, "plantMemory", plant(JAX, JAX, "betrayedMe")).result)).toContain(
      "the same person",
    );
    expect(
      reasonOf(send(test, "plantMemory", plant(JAX, "a99" as ActorId, "betrayedMe")).result),
    ).toContain('no one "a99"');
    actorOf(test.world, TOMAS).availability = "offShip";
    expect(reasonOf(send(test, "plantMemory", plant(JAX, TOMAS, "betrayedMe")).result)).toContain(
      "is not aboard",
    );
    actorOf(test.world, NOOR).availability = "dead";
    expect(reasonOf(send(test, "plantMemory", plant(NOOR, JAX, "betrayedMe")).result)).toContain(
      "is dead",
    );
    expect(
      reasonOf(send(test, "plantMemory", plant(JAX, TOMAS, "chatted" as NarratorMemoryKey)).result),
    ).toContain('"chatted" is not a memory the narrator plants');
  });
});

describe("fallOut (§memory-levers)", () => {
  it("leaves the pair at odds both ways, argued in their thoughts, and the argument in the log", () => {
    const test = socialWorld();
    const { world } = test;
    const { result, events } = send(test, "fallOut", {
      aId: JAX,
      bId: TOMAS,
      over: "Ysolde Maren",
    });
    expect(result.status).toBe("accepted");
    expect(feel(world, JAX, TOMAS)).toBeLessThanOrEqual(-3);
    expect(feel(world, TOMAS, JAX)).toBeLessThanOrEqual(-3);
    const argument = events.find((e) => e.type === "argument");
    expect(argument?.payload).toEqual({ aId: JAX, bId: TOMAS, over: "Ysolde Maren" });
    expect(argument?.significance).toBe("narrative");
    const line = argument === undefined ? null : tickerLine(argument, world.state, world.content);
    expect(line).toBe(
      `${actorOf(world, JAX).name} and ${actorOf(world, TOMAS).name} have fallen out over Ysolde Maren`,
    );
    expect(actorOf(world, JAX).thoughts).toContainEqual(
      expect.objectContaining({ key: "argued", refId: TOMAS }),
    );
    expect(actorOf(world, TOMAS).thoughts).toContainEqual(
      expect.objectContaining({ key: "argued", refId: JAX }),
    );
    expect(
      held(world, JAX, TOMAS)
        .map((m) => m.key)
        .sort(),
    ).toEqual(["argued", "wrongedOverSomeone"]);
    expect(needsViolations(world)).toEqual([]);
  });

  it("refuses an empty over and a falling-out with oneself", () => {
    const test = socialWorld();
    expect(reasonOf(send(test, "fallOut", { aId: JAX, bId: TOMAS, over: " " }).result)).toContain(
      "over says what it is over",
    );
    expect(reasonOf(send(test, "fallOut", { aId: JAX, bId: JAX, over: "x" }).result)).toContain(
      "the same person",
    );
  });
});

describe("giveThought (§thought-and-reveal-levers)", () => {
  it("gives a thought about someone, as the sim would, and moves the mood", () => {
    const test = socialWorld();
    const { world } = test;
    const before = actorOf(world, JAX).mood;
    const { result, events } = send(test, "giveThought", {
      actorId: JAX,
      key: "worriedAbout",
      refId: TOMAS,
    });
    expect(result.status).toBe("accepted");
    expect(actorOf(world, JAX).thoughts).toContainEqual(
      expect.objectContaining({ key: "worriedAbout", refId: TOMAS }),
    );
    expect(actorOf(world, JAX).mood).toBeLessThan(before);
    expect(events.find((e) => e.type === "thoughtGiven")?.payload).toEqual({
      actorId: JAX,
      key: "worriedAbout",
      refId: TOMAS,
    });
  });

  it("refuses a thought about someone with nobody named, an unknown key and an unknown ref", () => {
    const test = socialWorld();
    expect(reasonOf(send(test, "giveThought", { actorId: JAX, key: "grieving" }).result)).toContain(
      "is about someone",
    );
    expect(
      reasonOf(
        send(test, "giveThought", {
          actorId: JAX,
          key: "elated" as CommandPayloadMap["giveThought"]["key"],
        }).result,
      ),
    ).toContain('no thought "elated"');
    expect(
      reasonOf(
        send(test, "giveThought", { actorId: JAX, key: "shaken", refId: "a99" as ActorId }).result,
      ),
    ).toContain('no one "a99"');
    expect(send(test, "giveThought", { actorId: JAX, key: "shaken" }).result.status).toBe(
      "accepted",
    );
  });
});
