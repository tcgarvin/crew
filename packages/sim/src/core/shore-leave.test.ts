/**
 * §shore-leave: shore leave is open only while the ship lies docked at a port with its ramps down a
 * while, a course set or not (never at a landing site, in departure prep or under way); the spots
 * by a post keep off the post, its counter, the freight areas and the ramp landings; and who counts
 * as ashore on leave.
 */
import { describe, expect, it } from "vitest";
import { DECK12 } from "../systems/spatial/fixtures/deck-12x8";
import { QUAY } from "../systems/spatial/fixtures/dock";
import { berthDock } from "./docks";
import { isOnShoreLeave, shoreLeaveDock, shorePost, shoreSpots } from "./shore-leave";
import type { Actor } from "./types/actor";
import type { ContentBundle, DeckDef, DockDef } from "./types/content";
import type { LocalKey, PortDefId } from "./types/ids";
import type { TravelState } from "./types/travel";

const PORT = QUAY.portId;

/** The spike quay with a stall on its open south rows, facing north, and a staging area. */
const DOCK: DockDef = {
  ...QUAY,
  posts: [
    {
      key: "stall" as LocalKey,
      kind: "marketStall",
      name: "the noodle stall",
      tile: { x: 5, y: 11 },
      facing: "n",
    },
  ],
  areas: [
    { key: "staging" as LocalKey, kind: "freightStaging", rect: { x: 2, y: 10, w: 2, h: 2 } },
  ],
};

const deck = {
  id: DECK12.deck,
  width: 12,
  height: 8,
  hull: { class: "test_hull", sizeClass: "S", max: 100 },
} as unknown as DeckDef;
const content = {
  docks: { [DOCK.id]: DOCK },
  decks: { [DECK12.deck]: deck },
} as unknown as Pick<ContentBundle, "docks" | "decks">;

function host(travel: TravelState, dock: DockDef = DOCK, tick = 1000) {
  return {
    tick,
    deck: { dock: { dockId: dock.id, deckId: DECK12.deck } },
    travel,
  };
}

/** 20 s at 20 ticks a second: 400 ticks. */
const config = { time: { tickRate: 20 }, recreation: { shoreLeaveMinDockedSeconds: 20 } };
const docked = { stage: "docked", portId: PORT } as TravelState;

describe("shoreLeaveDock (§shore-leave)", () => {
  it("is the dock alongside while docked at its port", () => {
    expect(shoreLeaveDock(content, config, host(docked))?.dock.id).toBe(DOCK.id);
  });

  it("stays open with a course set while the ship is still docked", () => {
    const planned = { ...docked, plannedDestinationId: "port.far" as PortDefId } as TravelState;
    expect(shoreLeaveDock(content, config, host(planned))?.dock.id).toBe(DOCK.id);
    const plotted = { ...planned, coursePlotted: true } as TravelState;
    expect(shoreLeaveDock(content, config, host(plotted))?.dock.id).toBe(DOCK.id);
  });

  it("opens only once the ramps have been down shoreLeaveMinDockedSeconds", () => {
    const arrived = { ...docked, dockedSinceTick: 700 } as TravelState;
    expect(shoreLeaveDock(content, config, host(arrived, DOCK, 1099))).toBeUndefined();
    expect(shoreLeaveDock(content, config, host(arrived, DOCK, 1100))?.dock.id).toBe(DOCK.id);
  });

  it("is closed in departure prep, under way, or at another port", () => {
    const prep = {
      stage: "preparingDeparture",
      fromPortId: PORT,
      toPortId: "port.far" as PortDefId,
      stageProgress: 0,
    } as TravelState;
    expect(shoreLeaveDock(content, config, host(prep))).toBeUndefined();
    const elsewhere = { stage: "docked", portId: "port.other" as PortDefId } as TravelState;
    expect(shoreLeaveDock(content, config, host(elsewhere))).toBeUndefined();
    expect(
      shoreLeaveDock(content, config, {
        tick: 1000,
        deck: {},
        travel: docked,
      } as ReturnType<typeof host>),
    ).toBeUndefined();
  });

  it("is never open at a landing site", () => {
    const site: DockDef = { ...DOCK, kind: "site" };
    const siteContent = { ...content, docks: { [site.id]: site } } as typeof content;
    expect(shoreLeaveDock(siteContent, config, host(docked, site))).toBeUndefined();
  });
});

describe("shoreSpots (§shore-leave)", () => {
  it("lies by the post, nearest first, off the post, its counter, the areas and the berth", () => {
    const berth = berthDock(DOCK, deck);
    const post = shorePost(berth, "marketStall");
    if (post === undefined) throw new Error("no stall");
    const spots = shoreSpots(berth, post).map((t) => ({
      x: t.x + berth.shipAt.x,
      y: t.y + berth.shipAt.y,
    }));
    expect(spots.length).toBeGreaterThan(0);
    const has = (x: number, y: number) => spots.some((s) => s.x === x && s.y === y);
    // The post's tile and the counter it faces are the local's and the buyers'.
    expect(has(5, 11)).toBe(false);
    expect(has(5, 10)).toBe(false);
    // The staging area, the crates (no floor) and anything beside the berth box are out.
    expect(has(3, 10)).toBe(false);
    expect(has(6, 10)).toBe(false);
    expect(spots.every((s) => s.y >= 10)).toBe(true);
    expect(spots[0]).toEqual({ x: 4, y: 10 });
    expect(shorePost(berth, "bench")).toBeUndefined();
  });
});

describe("isOnShoreLeave (§shore-leave)", () => {
  const berth = berthDock(DOCK, deck);
  const deckId = DECK12.deck;
  const ashoreTile = { x: 4 - berth.shipAt.x, y: 10 - berth.shipAt.y };
  const recreating = (location: Actor["location"], steps: unknown[] = []) =>
    ({
      location,
      activity: {
        kind: "personal",
        activity: "recreate",
        plan: { steps, stepIndex: 0 },
      },
    }) as unknown as Actor;

  it("counts someone at a recreate on the dock, or with a walk onto it still ahead, only", () => {
    const state = host(docked);
    const onDock = {
      kind: "onDeck",
      deckId,
      x: ashoreTile.x + 0.5,
      y: ashoreTile.y + 0.5,
    } as const;
    const aboard = { kind: "onDeck", deckId, x: 3.5, y: 5.5 } as const;
    const drink = { kind: "recreate", activityId: "activity.shore_leave", role: "host" };
    expect(isOnShoreLeave(content, state, recreating(onDock, [drink]))).toBe(true);
    expect(isOnShoreLeave(content, state, recreating(aboard, [drink]))).toBe(false);
    const walk = [{ kind: "moveTo", target: ashoreTile, requested: false }, drink];
    expect(isOnShoreLeave(content, state, recreating(aboard, walk))).toBe(true);
    // On the dock but walking back aboard to a game: not on leave.
    const back = [{ kind: "moveTo", target: { x: 3, y: 5 }, requested: false }, drink];
    expect(isOnShoreLeave(content, state, recreating(onDock, back))).toBe(false);
    const working = { location: onDock, activity: { kind: "idle" } } as unknown as Actor;
    expect(isOnShoreLeave(content, state, working)).toBe(false);
  });
});
