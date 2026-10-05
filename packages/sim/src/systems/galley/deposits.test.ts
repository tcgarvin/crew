/**
 * The galley's dirt (D81, D82): what it hands `depositDirt` and where. The grid itself is dirt's;
 * here the deposit is a spy, so the galley's side of the contract is checked on its own.
 */
import { describe, expect, it, vi } from "vitest";
import type { TileCoord } from "../../core/types/common";

const deposits = vi.hoisted(() => [] as { tile: TileCoord; amount: number }[]);
vi.mock("../dirt/deposit", () => ({
  depositDirt: (
    _state: unknown,
    _content: unknown,
    _config: unknown,
    _deckId: unknown,
    tile: TileCoord,
    amount: number,
  ) => {
    deposits.push({ tile: { x: tile.x, y: tile.y }, amount });
  },
}));

import {
  COUNTER,
  GALLEY_WATCH,
  SEATS,
  STOVE_USE,
  galleyConfig,
  galleyWorld,
  ofType,
  runToSecond,
  runUntil,
} from "./fixtures/galley-deck";

describe("the galley's deposits (D82 through D81)", () => {
  it("cooking at the stove, serving on the counter, eating at the table", () => {
    deposits.length = 0;
    const fixture = galleyWorld();
    const dirt = fixture.world.config.values.dirt.deposits;
    runToSecond(fixture, GALLEY_WATCH);
    expect(deposits).toContainEqual({ tile: STOVE_USE, amount: dirt.cooking });
    expect(deposits).toContainEqual({ tile: COUNTER, amount: dirt.serving });
    const eating = deposits.filter((d) => d.amount === dirt.eating);
    expect(eating.length).toBeGreaterThan(0);
    for (const d of eating) expect(SEATS).toContainEqual(d.tile);
  });

  it("a spoiled serving dirties the counter", () => {
    deposits.length = 0;
    const base = galleyConfig();
    const fixture = galleyWorld({ config: { ...base, needs: { ...base.needs, hungerPerDay: 0 } } });
    const dirt = fixture.world.config.values.dirt.deposits;
    let spoiled = false;
    runUntil(
      fixture,
      2 * GALLEY_WATCH,
      () => spoiled,
      (_w, events) => {
        spoiled ||= ofType(events, "mealSpoiled").length > 0;
      },
    );
    expect(deposits.at(-1)).toEqual({ tile: COUNTER, amount: dirt.spoiledMeal });
  });
});
