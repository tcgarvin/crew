/**
 * D81-D83 in the digest: the galley line, the dirt line and their problem lines. The world comes
 * from the in-code fixtures (the default scenario's Mk2 and its stores); the counter, the cook's
 * task, the room tiers and the problems are written by hand, so these hold whatever the galley
 * and dirt systems do.
 */
import {
  type ActorId,
  type ClaimId,
  type CompartmentId,
  type DirtTier,
  type ItemDefId,
  type ItemId,
  type LocalKey,
  type PortDefId,
  type ProblemId,
  type SaveEnvelope,
  type TaskId,
  dayTicks,
  provisionsDays,
  watchTicks,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import { buildDigest } from "./digest";
import { approachRequest } from "./fixtures";
import { daysPhrase } from "./galley-digest";
import { EMPTY_NOTES } from "./notes";
import { content } from "./test-support";

type State = SaveEnvelope["state"];

const HUB = "port.crossroads_hub" as PortDefId;
const PROVISIONS = "item.provisions" as ItemDefId;

function snapshot(): SaveEnvelope {
  return structuredClone(approachRequest(content()).snapshot) as SaveEnvelope;
}

function digest(snap: SaveEnvelope): string {
  return buildDigest(snap, [], EMPTY_NOTES, content(), undefined).text;
}

function shipLines(text: string): string[] {
  return text.split("## Ship\n")[1]?.split("\n\n")[0]?.split("\n") ?? [];
}

function lineStarting(lines: readonly string[], prefix: string): string | undefined {
  return lines.find((l) => l.startsWith(prefix));
}

function actorNamed(state: State, name: string): ActorId {
  const actor = Object.values(state.actors).find((a) => a.name === name);
  if (actor === undefined) throw new Error(`fixture: no ${name}`);
  return actor.id;
}

function deckId(state: State): string {
  const id = Object.keys(state.deck.tiles)[0];
  if (id === undefined) throw new Error("fixture: no deck");
  return id;
}

function compartmentOf(state: State, key: string): CompartmentId {
  const room = Object.values(state.compartments).find((c) => c.key === key);
  if (room === undefined) throw new Error(`fixture: no compartment ${key}`);
  return room.id;
}

/** The first tile of the ship's `serving` zone (the counter). */
function counterTile(state: State): { x: number; y: number } {
  const deck = content().decks[deckId(state) as keyof ReturnType<typeof content>["decks"]];
  const tile = deck?.zones.find((z) => z.tags.includes("serving"))?.tiles[0];
  if (tile === undefined) throw new Error("fixture: no serving zone");
  return tile;
}

function putMeals(
  state: State,
  id: string,
  count: number,
  quality: "poor" | "plain" | "good",
  cook: ActorId,
): void {
  const tile = counterTile(state);
  const itemId = id as ItemId;
  state.items[itemId] = {
    id: itemId,
    defId: "item.hot_meal" as ItemDefId,
    location: { kind: "onDeck", deckId: deckId(state) as never, x: tile.x, y: tile.y },
    stacking: "stack",
    count,
    reserved: 0,
    meal: { quality, spoilsAtTick: state.tick + 1000, cookId: cook },
  };
}

/** An open problem with a task claimed by `holder` (or unclaimed). */
function openProblemWithTask(
  state: State,
  problem: Omit<State["work"]["problems"][ProblemId], "id" | "status" | "revision">,
  n: number,
  holder?: ActorId,
): ProblemId {
  const problemId = `p${n}` as ProblemId;
  state.work.problems[problemId] = {
    ...problem,
    id: problemId,
    status: "open",
    revision: 0,
  } as State["work"]["problems"][ProblemId];
  const taskId = `t${n}` as TaskId;
  const claimId = `c${n}` as ClaimId;
  state.work.tasks[taskId] = {
    id: taskId,
    problemId,
    claimState:
      holder === undefined ? { kind: "unclaimed" } : { kind: "claimed", claimIds: [claimId] },
  } as never;
  if (holder !== undefined) {
    state.work.claims[claimId] = {
      id: claimId,
      taskId,
      ownerActorId: holder,
      claimedTick: state.tick,
      expiresAtTick: state.tick + 100,
    };
  }
  return problemId;
}

describe("the galley line (D81, D83)", () => {
  it("says the counter is empty, when the next meal is due and the provisions in crates and days", () => {
    const snap = snapshot();
    const state = snap.state;
    const config = snap.config;
    const length = watchTicks(config);
    // Early in a watch, before the meal's call: the coming bell's meal.
    state.tick = length * 4 + config.time.tickRate * 10;
    const line = lineStarting(shipLines(digest(snap)), "galley: ");
    const days = provisionsDays(state, content(), config);
    const toBell = Math.round((length * 5 - state.tick) / config.time.tickRate);
    expect(line).toBe(
      `galley: nothing on the counter, next meal due at the bell in ~${toBell}s; provisions 18 crates, ${daysPhrase(days)}`,
    );
  });

  it("past the meal's call with none open, the next meal is the bell after", () => {
    const snap = snapshot();
    const config = snap.config;
    const length = watchTicks(config);
    const lead = dayTicks(config, config.galley.mealLeadDays);
    snap.state.tick = length * 5 - Math.floor(lead / 2);
    const line = lineStarting(shipLines(digest(snap)), "galley: ");
    const toBell = Math.round((length * 6 - snap.state.tick) / config.time.tickRate);
    expect(line).toContain(`next meal due at the bell in ~${toBell}s;`);
  });

  it("counts the servings on the counter with their quality and cook", () => {
    const snap = snapshot();
    const state = snap.state;
    const bettina = actorNamed(state, "Bettina Solheim");
    putMeals(state, "i900", 10, "good", bettina);
    const line = lineStarting(shipLines(digest(snap)), "galley: ");
    expect(line).toMatch(
      /^galley: 10 hot meals on the counter \(good, Bettina Solheim\), next meal/,
    );
  });

  it("lists each cook and quality when the counter holds more than one meal", () => {
    const snap = snapshot();
    const state = snap.state;
    putMeals(state, "i900", 2, "good", actorNamed(state, "Bettina Solheim"));
    putMeals(state, "i901", 1, "poor", actorNamed(state, "Dane Whitcross"));
    const line = lineStarting(shipLines(digest(snap)), "galley: ");
    expect(line).toContain(
      "3 hot meals on the counter (2 good, Bettina Solheim; 1 poor, Dane Whitcross)",
    );
  });

  it("says who is cooking while the meal is open, or that nobody is yet", () => {
    const snap = snapshot();
    const state = snap.state;
    const meal = {
      kind: "mealToCook" as const,
      payload: { watchIndex: 5 },
      owner: "galley" as const,
      visibility: "public" as const,
      dedupeKey: "meal:5",
      createdTick: state.tick,
      baseUrgency: "routineObligation" as const,
      location: { kind: "compartment" as const, compartmentId: compartmentOf(state, "galley") },
    };
    const unclaimed = structuredClone(snap);
    openProblemWithTask(unclaimed.state, meal, 900);
    expect(lineStarting(shipLines(digest(unclaimed)), "galley: ")).toContain(
      "(nobody is cooking it yet)",
    );
    openProblemWithTask(state, meal, 900, actorNamed(state, "Bettina Solheim"));
    expect(lineStarting(shipLines(digest(snap)), "galley: ")).toContain(
      "(Bettina Solheim cooking)",
    );
  });
});

describe("the dirt line (D82, D83)", () => {
  it("is absent while every room is below dirty", () => {
    const snap = snapshot();
    snap.state.dirt.tiers = { galley: "untidy", mess: "clean" } as Record<LocalKey, DirtTier>;
    expect(lineStarting(shipLines(digest(snap)), "dirt: ")).toBeUndefined();
  });

  it("names the rooms at dirty or worse, filthy first", () => {
    const snap = snapshot();
    snap.state.dirt.tiers = {
      galley: "dirty",
      cargoHold: "filthy",
      corridor: "untidy",
      mess: "dirty",
    } as Record<LocalKey, DirtTier>;
    expect(lineStarting(shipLines(digest(snap)), "dirt: ")).toBe(
      "dirt: Cargo Hold filthy; Galley dirty; Mess dirty",
    );
  });
});

describe("galley and dirt problem lines (D80-D83)", () => {
  it("words a provisions reserveLow as the galley running low, in days, with why it is open", () => {
    const snap = snapshot();
    const state = snap.state;
    state.travel = { stage: "docked", portId: HUB };
    // The hub's market stocks provisions (W3 lists them at every port; written here so the
    // reason does not depend on content).
    state.markets[HUB] = { [PROVISIONS]: { count: 8, price: 50 } } as never;
    state.money.balance = 5000;
    openProblemWithTask(
      state,
      {
        kind: "reserveLow",
        payload: { itemDefId: PROVISIONS, count: 4 },
        owner: "commerce",
        visibility: "public",
        dedupeKey: `reserveLow:${PROVISIONS}`,
        createdTick: 10,
        baseUrgency: "routineObligation",
        location: { kind: "port", portId: HUB },
      },
      901,
    );
    const days = provisionsDays(state, content(), snap.config);
    expect(digest(snap)).toContain(
      `- reserveLow (public) since tick 10: provisions are low (${daysPhrase(days)} of meals left); 4 crates would restock the galley; the crew are buying it here (Crossroads Hub)`,
    );
  });

  it("words a compartmentDirty with the room, its tier and who is mopping it", () => {
    const snap = snapshot();
    const state = snap.state;
    const hold = compartmentOf(state, "cargoHold");
    const dirty = {
      kind: "compartmentDirty" as const,
      payload: { compartmentId: hold, key: "cargoHold" as LocalKey, tier: "filthy" as DirtTier },
      owner: "dirt" as const,
      visibility: "public" as const,
      dedupeKey: "dirty:cargoHold",
      createdTick: 20,
      baseUrgency: "routineObligation" as const,
      location: { kind: "compartment" as const, compartmentId: hold },
    };
    const nobody = structuredClone(snap);
    openProblemWithTask(nobody.state, dirty, 902);
    expect(digest(nobody)).toContain(
      "- compartmentDirty (public) since tick 20: Cargo Hold is filthy; nobody is mopping it yet",
    );
    openProblemWithTask(state, dirty, 902, actorNamed(state, "Dane Whitcross"));
    expect(digest(snap)).toContain(
      "- compartmentDirty (public) since tick 20: Cargo Hold is filthy; Dane Whitcross mopping",
    );
  });
});

describe("daysPhrase", () => {
  it.each([
    [0.64, "about 0.6 days"],
    [1, "about 1.0 days"],
    [5.4, "about 5 days"],
    [Number.POSITIVE_INFINITY, "nobody aboard to feed"],
  ])("%s → %s", (days, phrase) => {
    expect(daysPhrase(days)).toBe(phrase);
  });
});
