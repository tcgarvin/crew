/** Dirt in a save (D82): a 720-cell grid round-trips and the invariants catch a bad one. */
import { describe, expect, it } from "vitest";
import {
  TINY,
  tinyConfig,
  tinyContent,
  tinyEffectiveConfig,
} from "../../core/fixtures/tiny-content";
import { checkInvariants } from "../../core/invariants";
import { createKernel } from "../../core/kernel";
import { createRegistry } from "../../core/registry";
import { restore, serialize } from "../../core/save";
import type { ContentBundle } from "../../core/types/content";
import { registerSpatial } from "../spatial/index";
import { registerDirt } from "./index";
import { dirtViolations } from "./invariants";

/** The tiny deck padded with void to 36 × 20: Mk2's 720 cells. */
function wideContent(): ContentBundle {
  const base = tinyContent(tinyConfig());
  const deck = base.decks[TINY.deck];
  if (deck === undefined) throw new Error("no tiny deck");
  const width = 36;
  const height = 20;
  const tiles = Array.from({ length: height }, (_, y) => (deck.tiles[y] ?? "").padEnd(width, " "));
  return { ...base, decks: { [TINY.deck]: { ...deck, width, height, tiles } }, hash: "wide-v1" };
}

function wideWorld() {
  const registry = createRegistry();
  registerSpatial(registry);
  registerDirt(registry);
  const kernel = createKernel(registry);
  const config = tinyConfig();
  const world = kernel.createWorld(TINY.scenario, 3, wideContent(), tinyEffectiveConfig(config));
  return { registry, kernel, world };
}

describe("dirt in a save (D82)", () => {
  it("a 720-cell grid round-trips through serialize, JSON and restore, invariants clean", () => {
    const { registry, kernel, world } = wideWorld();
    const cells = world.state.dirt.cells[TINY.deck];
    if (cells === undefined) throw new Error("no dirt row");
    expect(cells).toHaveLength(720);
    for (let i = 0; i < cells.length; i++) cells[i] = (i * 37) % 256;
    world.state.dirt.tiers = {
      [world.content.decks[TINY.deck]?.compartments[0]?.key ?? ""]: "dirty",
    };
    kernel.advance(world, 20);
    const blob = JSON.parse(JSON.stringify(serialize(world)));
    const restored = restore(blob, world.content, registry);
    expect(restored.state.dirt).toStrictEqual(world.state.dirt);
    expect(checkInvariants(restored.state)).toEqual([]);
    expect(dirtViolations(restored)).toEqual([]);
    kernel.advance(world, 40);
    kernel.advance(restored, 40);
    expect(restored.state).toStrictEqual(world.state);
  });

  it("flags a cell out of range, a short row and a tier for no room", () => {
    const { world } = wideWorld();
    const cells = world.state.dirt.cells[TINY.deck];
    if (cells === undefined) throw new Error("no dirt row");
    cells[5] = 256;
    expect(checkInvariants(world.state).join("; ")).toMatch(/dirt/);
    cells[5] = 0;
    cells.pop();
    world.state.dirt.tiers = { nowhere: "filthy" };
    const violations = dirtViolations(world);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toMatch(/719 cells for a 36×20 deck/);
    expect(violations[1]).toMatch(/nowhere/);
  });
});
