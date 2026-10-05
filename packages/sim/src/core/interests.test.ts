import { describe, expect, it } from "vitest";
import {
  type Character,
  generateInterests,
  interestScore,
  interestsFromSeed,
  stanceOn,
} from "./interests";
import { type RngHost, createRngApi, seedAllStreams } from "./rng";
import { INTEREST_TAGS } from "./types/content";
import type { ActorId } from "./types/ids";

function host(seed: number): RngHost {
  return { seed, rng: seedAllStreams(seed) };
}

const ids = Array.from({ length: 200 }, (_, i) => `a${i + 1}` as ActorId);

/** The shape every character must have (the invariants' rules, call 8). */
function expectWellFormed({ interests, values }: Character): void {
  expect(interests.likes).toHaveLength(2);
  expect(new Set(interests.likes).size).toBe(2);
  expect(interests.strong).toBeDefined();
  expect(interests.likes).toContain(interests.strong);
  expect(interests.dislikes.length).toBeLessThanOrEqual(1);
  for (const tag of [...interests.likes, ...interests.dislikes]) {
    expect(INTEREST_TAGS).toContain(tag);
  }
  for (const tag of interests.dislikes) expect(interests.likes).not.toContain(tag);
  for (const value of Object.values(values)) {
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(-2);
    expect(value).toBeLessThanOrEqual(2);
  }
}

describe("generateInterests (slice 4, call 8)", () => {
  it("always gives a strong like among two likes, and never a tag both liked and disliked", () => {
    const rng = createRngApi(host(11));
    for (const id of ids) expectWellFormed(generateInterests(rng, "setup", id));
  });

  it("does not advance the stream it draws on: world creation's other draws stay put", () => {
    const h = host(5);
    const rng = createRngApi(h);
    const before = [...h.rng.setup];
    generateInterests(rng, "setup", "a1" as ActorId);
    expect(h.rng.setup).toEqual(before);
  });

  it("is keyed on the id and the seed: the same pair gives the same person", () => {
    const a = generateInterests(createRngApi(host(9)), "setup", "a3" as ActorId);
    const b = generateInterests(createRngApi(host(9)), "setup", "a3" as ActorId);
    expect(a).toEqual(b);
    const people = ids.map((id) =>
      JSON.stringify(generateInterests(createRngApi(host(9)), "setup", id)),
    );
    expect(new Set(people).size).toBeGreaterThan(150);
  });

  it("spreads over the tags, dislikes about half the time, and the whole value range", () => {
    const rng = createRngApi(host(21));
    const characters = ids.map((id) => generateInterests(rng, "setup", id));
    const strong = new Set(characters.map((c) => c.interests.strong));
    expect(strong.size).toBe(INTEREST_TAGS.length);
    const disliking = characters.filter((c) => c.interests.dislikes.length > 0).length;
    expect(disliking).toBeGreaterThan(70);
    expect(disliking).toBeLessThan(130);
    const values = new Set(characters.flatMap((c) => Object.values(c.values)));
    expect([...values].sort()).toEqual([-1, -2, 0, 1, 2]);
  });
});

describe("interestsFromSeed (slice 4, call 8: the 9 → 10 migration)", () => {
  it("is stable: the same id always gives the same interests and values", () => {
    for (const id of ids.slice(0, 20)) expect(interestsFromSeed(id)).toEqual(interestsFromSeed(id));
    expect(interestsFromSeed("a7" as ActorId)).toMatchInlineSnapshot(`
      {
        "interests": {
          "dislikes": [],
          "likes": [
            "music",
            "tinkering",
          ],
          "strong": "music",
        },
        "values": {
          "faithReason": -2,
          "loyaltyAmbition": -2,
          "orderFreedom": 1,
        },
      }
    `);
  });

  it("is well formed for every id and differs between people", () => {
    const people = ids.map((id) => interestsFromSeed(id));
    for (const character of people) expectWellFormed(character);
    expect(new Set(people.map((c) => JSON.stringify(c))).size).toBeGreaterThan(150);
    expect(new Set(people.map((c) => c.interests.strong)).size).toBe(INTEREST_TAGS.length);
  });
});

describe("interestScore and stanceOn", () => {
  const interests = {
    likes: ["cards", "vids"] as const,
    strong: "cards" as const,
    dislikes: ["reading"] as const,
  };

  it("scores strong like 3, like 2, neutral 1, dislike 0", () => {
    const view = {
      likes: [...interests.likes],
      strong: interests.strong,
      dislikes: [...interests.dislikes],
    };
    expect(interestScore(view, "cards")).toBe(3);
    expect(interestScore(view, "vids")).toBe(2);
    expect(interestScore(view, "music")).toBe(1);
    expect(interestScore(view, "reading")).toBe(0);
  });

  it("takes a stance as the dot product of values and the topic's weights", () => {
    const values = { orderFreedom: 2, faithReason: -1, loyaltyAmbition: 1 };
    expect(
      stanceOn(values, { weights: { orderFreedom: -1, faithReason: 0.5, loyaltyAmbition: 0.5 } }),
    ).toBe(-2);
  });
});
