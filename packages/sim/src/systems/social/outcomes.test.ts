import { describe, expect, it } from "vitest";
import { dayTicks } from "../../core/clock";
import { affinityOf, rivalryKey } from "../../core/social";
import type { EventDraft } from "../../core/types/events";
import type { ActorId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import { needsViolations } from "../needs/invariants";
import {
  ACT,
  BETTINA,
  JAX,
  MARA,
  NOOR,
  TOMAS,
  TOPIC,
  TREAT,
  actorOf,
  asleep,
  defOf,
  galleyStepCtx,
  handSession,
  placeAll,
  riggedCtx,
  setCharacter,
  socialWorld,
} from "./fixtures/social-world";
import { resolveOutcome } from "./outcomes";

const thoughtKeys = (world: World, id: ActorId) => actorOf(world, id).thoughts.map((t) => t.key);
const ofType = (drafts: readonly EventDraft[], type: EventDraft["type"]) =>
  drafts.filter((d) => d.type === type);
const feel = (world: World, from: ActorId, to: ActorId) =>
  affinityOf(world.state, world.config.values.social, from, to);

/** Everyone in the mess, out of the way of each other. */
function inTheMess(world: World, ids: readonly ActorId[]): void {
  const tiles = [
    { x: 6, y: 0 },
    { x: 6, y: 1 },
    { x: 6, y: 2 },
    { x: 6, y: 3 },
    { x: 9, y: 0 },
  ];
  placeAll(world, Object.fromEntries(ids.map((id, i) => [id, tiles[i] ?? { x: 9, y: 3 }])));
}

/** Everyone not named goes to the bunkroom, out of earshot of the mess. */
function elsewhere(world: World, ids: readonly ActorId[]): void {
  const tiles = [
    { x: 11, y: 1 },
    { x: 12, y: 1 },
    { x: 13, y: 1 },
    { x: 11, y: 3 },
    { x: 12, y: 3 },
  ];
  placeAll(world, Object.fromEntries(ids.map((id, i) => [id, tiles[i] ?? { x: 13, y: 3 }])));
}

describe("contest (call 5)", () => {
  it("the keen player beats the neutral one more often than not over twenty seeded rolls", () => {
    const { world } = socialWorld();
    setCharacter(world, JAX, { likes: ["cards"], strong: "cards" });
    setCharacter(world, TOMAS, {});
    inTheMess(world, [JAX, TOMAS]);
    let jaxWins = 0;
    for (let i = 0; i < 20; i++) {
      const { ctx } = galleyStepCtx(world);
      const summary = resolveOutcome(
        ctx,
        handSession(world, ACT.cards, [JAX, TOMAS]),
        defOf(world, ACT.cards),
      );
      if (summary.winnerId === JAX) jaxWins += 1;
      else expect(summary.winnerId).toBe(TOMAS);
    }
    expect(jaxWins).toBeGreaterThan(10);
    const row = world.state.social.rivalries[rivalryKey(JAX, TOMAS, ACT.cards)];
    expect(row).toMatchObject({ wins: jaxWins, losses: 20 - jaxWins });
    expect(needsViolations(world)).toEqual([]);
  });

  it("each loss is lostContest and beatMe toward the winner, held to its stack limit; the third running is a rivalry", () => {
    const { world } = socialWorld();
    inTheMess(world, [JAX, TOMAS]);
    const def = defOf(world, ACT.sharp);
    const play = (winner: ActorId) => {
      const { ctx, drafts } = riggedCtx(world, winner);
      resolveOutcome(ctx, handSession(world, ACT.sharp, [JAX, TOMAS]), def);
      return drafts;
    };
    play(JAX);
    expect(thoughtKeys(world, TOMAS)).toEqual(["lostContest"]);
    expect(thoughtKeys(world, JAX)).toEqual(["wonContest"]);
    expect(feel(world, TOMAS, JAX)).toBe(-1);
    expect(feel(world, JAX, TOMAS)).toBe(0);
    expect(ofType(play(JAX), "rivalryStreak")).toEqual([]);
    expect(feel(world, TOMAS, JAX)).toBe(-2);

    const third = play(JAX);
    expect(ofType(third, "rivalryStreak").map((d) => d.payload)).toEqual([
      { winnerId: JAX, loserId: TOMAS, activityId: ACT.sharp, streak: 3 },
    ]);
    const beaten = actorOf(world, TOMAS).thoughts.filter((t) => t.key === "keepsBeatingMe");
    expect(beaten.map((t) => t.refId)).toEqual([JAX]);
    // §memories: beatMe stacks to two, so the third loss holds it at −2; the rivalry adds its −1.
    expect(feel(world, TOMAS, JAX)).toBe(-3);
    expect(
      world.state.social.relationships[TOMAS]?.[JAX]?.memories.map((m) => m.key).sort(),
    ).toEqual(["beatMe", "beatMe", "keepsBeatingMe"]);
    // Tomas's side reads 0–3; the row is Jax's (the lower id comes first).
    expect(world.state.social.rivalries[rivalryKey(TOMAS, JAX, ACT.sharp)]).toEqual({
      wins: 3,
      losses: 0,
      streak: 3,
    });

    // A fourth loss refreshes the thought and the memories but is no second rivalry line.
    expect(ofType(play(JAX), "rivalryStreak")).toEqual([]);
    expect(feel(world, TOMAS, JAX)).toBe(-3);
    expect(actorOf(world, TOMAS).thoughts.filter((t) => t.key === "keepsBeatingMe")).toHaveLength(
      1,
    );

    // A win by the loser resets the run.
    play(TOMAS);
    expect(world.state.social.rivalries[rivalryKey(JAX, TOMAS, ACT.sharp)]).toEqual({
      wins: 4,
      losses: 1,
      streak: -1,
    });
    expect(needsViolations(world)).toEqual([]);
  });

  it("the authored cards' memories: goodTime all round, beatMe loser to winner (net 0 for the loser)", () => {
    const { world } = socialWorld();
    inTheMess(world, [JAX, TOMAS, NOOR]);
    const { ctx } = riggedCtx(world, JAX);
    resolveOutcome(ctx, handSession(world, ACT.cards, [JAX, TOMAS, NOOR]), defOf(world, ACT.cards));
    expect(feel(world, JAX, TOMAS)).toBe(1);
    expect(feel(world, TOMAS, JAX)).toBe(0);
    expect(feel(world, TOMAS, NOOR)).toBe(1);
    expect(feel(world, NOOR, JAX)).toBe(0);
  });

  it("a contest with one member left has no winner and moves nothing", () => {
    const { world } = socialWorld();
    inTheMess(world, [JAX]);
    const { ctx, drafts } = galleyStepCtx(world);
    expect(
      resolveOutcome(ctx, handSession(world, ACT.cards, [JAX]), defOf(world, ACT.cards)),
    ).toEqual({});
    expect(drafts).toEqual([]);
  });

  /*
   * Done-when stand-in: the plan asks for a rivalry key with three or more games on `crewWorld`
   * over three days, which needs W1's session lifecycle. Until it merges, three ship's days of
   * hand-built games (three a day, between watches) resolved through the real rng show the same.
   */
  it("three days of evening card games leave a rivalry with three or more games", () => {
    const { world } = socialWorld(17);
    setCharacter(world, JAX, { likes: ["cards", "vids"], strong: "cards", values: [2, 1, 2] });
    setCharacter(world, TOMAS, { likes: ["sparring", "cards"], strong: "sparring" });
    inTheMess(world, [JAX, TOMAS]);
    const day = dayTicks(world.config.values, 1);
    const events: EventDraft[] = [];
    for (let d = 0; d < 3; d++) {
      for (let game = 0; game < 3; game++) {
        world.state.tick = d * day + Math.floor(day / 2) + game * 100;
        const { ctx, drafts } = galleyStepCtx(world);
        resolveOutcome(ctx, handSession(world, ACT.cards, [JAX, TOMAS]), defOf(world, ACT.cards));
        events.push(...drafts);
      }
    }
    const row = world.state.social.rivalries[rivalryKey(JAX, TOMAS, ACT.cards)];
    expect(row).toBeDefined();
    expect((row?.wins ?? 0) + (row?.losses ?? 0)).toBe(9);
    expect(ofType(events, "thoughtAdded").length).toBeGreaterThanOrEqual(18);
    expect(needsViolations(world)).toEqual([]);
  });
});

describe("debate (call 5)", () => {
  it("(2, 1, 2) against (−2, 0, −1) on the Guild is an argument: −2 each way, argued on both", () => {
    const { world } = socialWorld();
    setCharacter(world, JAX, { likes: ["debate"], values: [2, 1, 2] });
    setCharacter(world, TOMAS, { likes: ["debate"], values: [-2, 0, -1] });
    inTheMess(world, [JAX, TOMAS]);
    elsewhere(world, [BETTINA, NOOR, MARA]);
    const { ctx, drafts } = galleyStepCtx(world);
    const summary = resolveOutcome(
      ctx,
      handSession(world, ACT.debate, [JAX, TOMAS], { topicId: TOPIC.guild }),
      defOf(world, ACT.debate),
    );
    expect(summary).toEqual({ topicId: TOPIC.guild, argued: true });
    expect(feel(world, JAX, TOMAS)).toBe(-2);
    expect(feel(world, TOMAS, JAX)).toBe(-2);
    expect(actorOf(world, JAX).thoughts).toMatchObject([{ key: "argued", refId: TOMAS }]);
    expect(actorOf(world, TOMAS).thoughts).toMatchObject([{ key: "argued", refId: JAX }]);
    expect(ofType(drafts, "argument").map((d) => d.payload)).toEqual([
      { aId: JAX, bId: TOMAS, topicId: TOPIC.guild },
    ]);
  });

  it("(1, 2, 1) against (−1, 1, −1) on philosophy is a spirited talk: goodTalk (+2) each way", () => {
    const { world } = socialWorld();
    setCharacter(world, NOOR, { values: [1, 2, 1] });
    setCharacter(world, BETTINA, { values: [-1, 1, -1] });
    inTheMess(world, [NOOR, BETTINA]);
    elsewhere(world, [JAX, TOMAS, MARA]);
    const { ctx, drafts } = galleyStepCtx(world);
    const summary = resolveOutcome(
      ctx,
      handSession(world, ACT.debate, [NOOR, BETTINA], { topicId: TOPIC.philosophy }),
      defOf(world, ACT.debate),
    );
    expect(summary).toEqual({ topicId: TOPIC.philosophy, argued: false });
    expect(thoughtKeys(world, NOOR)).toEqual(["spiritedTalk"]);
    expect(thoughtKeys(world, BETTINA)).toEqual(["spiritedTalk"]);
    expect(feel(world, NOOR, BETTINA)).toBe(2);
    expect(ofType(drafts, "argument")).toEqual([]);
  });

  it("picks a topic from the def when the session has none", () => {
    const { world } = socialWorld();
    inTheMess(world, [NOOR, BETTINA]);
    const { ctx } = galleyStepCtx(world);
    const summary = resolveOutcome(
      ctx,
      handSession(world, ACT.debate, [NOOR, BETTINA]),
      defOf(world, ACT.debate),
    );
    expect([TOPIC.guild, TOPIC.philosophy]).toContain(summary.topicId);
  });

  it("a bystander who does not like debate is lectured; a liker and a sleeper are not", () => {
    const { world } = socialWorld();
    setCharacter(world, JAX, { values: [2, 1, 2] });
    setCharacter(world, TOMAS, { values: [-2, 0, -1] });
    setCharacter(world, NOOR, { dislikes: ["debate"] });
    setCharacter(world, BETTINA, { likes: ["debate"] });
    setCharacter(world, MARA, {});
    inTheMess(world, [JAX, TOMAS, NOOR, BETTINA, MARA]);
    asleep(world, MARA);
    const { ctx } = galleyStepCtx(world);
    resolveOutcome(
      ctx,
      handSession(world, ACT.debate, [JAX, TOMAS], { topicId: TOPIC.guild }),
      defOf(world, ACT.debate),
    );
    expect(thoughtKeys(world, NOOR)).toEqual(["gotLectured"]);
    expect(thoughtKeys(world, BETTINA)).toEqual([]);
    expect(thoughtKeys(world, MARA)).toEqual([]);
  });
});

describe("perform and bond (call 5)", () => {
  it("music: the liker enjoys it and warms to the player, the disliker hates it, the rest nothing", () => {
    const { world } = socialWorld();
    setCharacter(world, NOOR, { likes: ["music"] });
    setCharacter(world, JAX, { dislikes: ["music"] });
    setCharacter(world, TOMAS, {});
    setCharacter(world, MARA, { likes: ["music"] });
    inTheMess(world, [BETTINA, NOOR, JAX, TOMAS, MARA]);
    asleep(world, MARA);
    const { ctx } = galleyStepCtx(world);
    resolveOutcome(ctx, handSession(world, ACT.music, [BETTINA]), defOf(world, ACT.music));
    expect(thoughtKeys(world, NOOR)).toEqual(["enjoyedMusic"]);
    expect(feel(world, NOOR, BETTINA)).toBe(1);
    expect(thoughtKeys(world, JAX)).toEqual(["hatedTheNoise"]);
    expect(feel(world, JAX, BETTINA)).toBe(0);
    expect(thoughtKeys(world, TOMAS)).toEqual([]);
    expect(thoughtKeys(world, MARA)).toEqual([]);
    expect(thoughtKeys(world, BETTINA)).toEqual([]);
  });

  it("only the room hears it", () => {
    const { world } = socialWorld();
    setCharacter(world, NOOR, { likes: ["music"] });
    inTheMess(world, [BETTINA]);
    elsewhere(world, [NOOR]);
    const { ctx } = galleyStepCtx(world);
    resolveOutcome(ctx, handSession(world, ACT.music, [BETTINA]), defOf(world, ACT.music));
    expect(thoughtKeys(world, NOOR)).toEqual([]);
  });

  it("a vid is a bond: goodCompany all round, goodTime from its likers, never an argument", () => {
    const { world } = socialWorld();
    setCharacter(world, JAX, { likes: ["vids"], values: [2, 2, 2] });
    setCharacter(world, NOOR, { strong: "vids", values: [-2, -2, -2] });
    setCharacter(world, TOMAS, {});
    inTheMess(world, [JAX, NOOR, TOMAS]);
    const { ctx, drafts } = galleyStepCtx(world);
    const summary = resolveOutcome(
      ctx,
      handSession(world, ACT.vids, [JAX, NOOR, TOMAS], { topicId: TOPIC.vid }),
      defOf(world, ACT.vids),
    );
    expect(summary).toEqual({});
    for (const id of [JAX, NOOR, TOMAS]) expect(thoughtKeys(world, id)).toEqual(["goodCompany"]);
    for (const [a, b] of [
      [JAX, NOOR],
      [NOOR, JAX],
      [JAX, TOMAS],
      [NOOR, TOMAS],
    ] as const) {
      expect(feel(world, a, b)).toBe(1);
    }
    // §outcomes: Tomas, neutral on vids, sat through it and does not warm to anyone.
    expect(feel(world, TOMAS, JAX)).toBe(0);
    expect(feel(world, TOMAS, NOOR)).toBe(0);
    expect(ofType(drafts, "argument")).toEqual([]);
  });

  it("a vid watched alone is no company", () => {
    const { world } = socialWorld();
    inTheMess(world, [JAX]);
    const { ctx } = galleyStepCtx(world);
    resolveOutcome(ctx, handSession(world, ACT.vids, [JAX]), defOf(world, ACT.vids));
    expect(thoughtKeys(world, JAX)).toEqual([]);
  });
});

describe("skill, risk, dirt and product (call 5)", () => {
  it("sparring at injury chance 1 bruises both and says so twice", () => {
    const { world } = socialWorld();
    inTheMess(world, [JAX, TOMAS]);
    const { ctx, drafts } = galleyStepCtx(world);
    resolveOutcome(ctx, handSession(world, ACT.sparring, [JAX, TOMAS]), defOf(world, ACT.sparring));
    for (const id of [JAX, TOMAS]) expect(thoughtKeys(world, id)).toContain("sparringBruise");
    expect(ofType(drafts, "tookAKnock").map((d) => d.payload)).toEqual([
      { actorId: JAX, activityId: ACT.sparring },
      { actorId: TOMAS, activityId: ACT.sparring },
    ]);
  });

  it("sparring leaves dirt on the mess floor", () => {
    const { world } = socialWorld();
    inTheMess(world, [JAX, TOMAS]);
    const deckId = actorOf(world, JAX).location;
    if (deckId.kind !== "onDeck") throw new Error("Jax is not on deck");
    const before = (world.state.dirt.cells[deckId.deckId] ?? []).reduce((a, b) => a + b, 0);
    const { ctx } = galleyStepCtx(world);
    resolveOutcome(ctx, handSession(world, ACT.sparring, [JAX, TOMAS]), defOf(world, ACT.sparring));
    const after = (world.state.dirt.cells[deckId.deckId] ?? []).reduce((a, b) => a + b, 0);
    expect(after).toBeGreaterThan(before);
  });

  it("tinkering raises engineering by perDay × durationDays", () => {
    const { world } = socialWorld();
    inTheMess(world, [TOMAS]);
    const before = actorOf(world, TOMAS).skills.engineering ?? 0;
    const { ctx } = galleyStepCtx(world);
    resolveOutcome(ctx, handSession(world, ACT.tinkering, [TOMAS]), defOf(world, ACT.tinkering));
    expect(actorOf(world, TOMAS).skills.engineering).toBeCloseTo(before + 0.2 * 0.1, 10);
  });

  it("baking puts a tray of treats on the counter, Bettina's, spoiling like a meal", () => {
    const { world } = socialWorld();
    placeAll(world, { [BETTINA]: { x: 3, y: 1 } });
    const { ctx, drafts } = galleyStepCtx(world);
    resolveOutcome(
      ctx,
      handSession(world, ACT.baking, [BETTINA], { room: "galley" }),
      defOf(world, ACT.baking),
    );
    const treats = Object.values(world.state.items).filter((item) => item.defId === TREAT);
    expect(treats).toHaveLength(1);
    const tray = treats[0];
    expect(tray).toMatchObject({
      stacking: "stack",
      count: 4,
      location: { kind: "onDeck", x: 4.5, y: 1.5 },
      meal: { quality: "good", cookId: BETTINA },
    });
    expect(ofType(drafts, "treatsBaked").map((d) => d.payload)).toEqual([
      { cookId: BETTINA, count: 4 },
    ]);
    expect(thoughtKeys(world, BETTINA)).toContain("bakedForTheCrew");
    if (tray === undefined) throw new Error("no tray");
    // The baker knows; the rest are told unless their first look's brief is still to come.
    expect(actorOf(world, BETTINA).knowledge[`${tray.id}/itemLocation`]).toBeDefined();
  });
});
