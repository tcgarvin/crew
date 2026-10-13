/**
 * §the-body-aboard and §laid-to-rest on the medical fixture: a crew member dead aboard under way
 * is carried by a crewmate to the deck's first free resting place (the room of the cargo ramp,
 * tucked away from its doorways, zones and machines) and left there; docked at a port the dead
 * are carried ashore and leave the ship, their gear staying aboard; docked at a landing site they
 * stay.
 */
import { describe, expect, it } from "vitest";
import { tickerLine } from "../../core/render";
import type { TileCoord } from "../../core/types/common";
import type { ActorId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import type { ProblemOfKind } from "../../core/types/work";
import { shipDeckId } from "../../core/world";
import { handBlaster } from "../bodies/fixtures/bodies-deck";
import { symbolAt } from "../damage/deck";
import { PORTS } from "../travel/fixtures";
import {
  JAX,
  MARA,
  PRIYA,
  actorOf,
  bodiesWorldViolations,
  medicalWorld,
  ofType,
  runFor,
  runUntil,
  stepCtxOf,
  underWay,
  woundNow,
} from "./fixtures/medical-deck";
import { restingPlaces, sweepBodies } from "./rest";

/** A tile on the bridge, across the ship from the airlock. */
const BRIDGE = { x: 13, y: 3 };

function places(world: World): readonly TileCoord[] {
  const deck = world.content.decks[shipDeckId(world.state)];
  if (deck === undefined) throw new Error("no deck");
  return restingPlaces(world.content, deck);
}

/** Put `id` on `tile` and kill them there with a shot to the head. */
function killAt(world: World, id: ActorId, tile: TileCoord): void {
  const actor = actorOf(world, id);
  if (actor.location.kind !== "onDeck") throw new Error(`${id} is not on deck`);
  actor.location = { ...actor.location, x: tile.x + 0.5, y: tile.y + 0.5 };
  woundNow(world, id, { part: "head", severity: "grave", type: "blaster" });
  if (actor.availability !== "dead") throw new Error(`${id} is not dead`);
}

const bodyProblems = (world: World) =>
  Object.values(world.state.work.problems).filter(
    (p): p is ProblemOfKind<"bodyAboard"> => p.kind === "bodyAboard",
  );

const lyingAt = (world: World, id: ActorId): TileCoord | undefined => {
  const location = actorOf(world, id).location;
  return location.kind === "onDeck"
    ? { x: Math.floor(location.x), y: Math.floor(location.y) }
    : undefined;
};

describe("resting places (§the-body-aboard)", () => {
  it("lie in the cargo ramp's room, off its doorways, zones and ramp, the most tucked away first", () => {
    const { world } = medicalWorld();
    const deck = world.content.decks[shipDeckId(world.state)];
    if (deck === undefined) throw new Error("no deck");
    const all = places(world);
    expect(all.length).toBeGreaterThan(1);
    const ramp = deck.docking.cargoTransferTiles[0];
    if (ramp === undefined) throw new Error("no ramp");
    for (const t of all) {
      expect(symbolAt(deck, t)).toBe(symbolAt(deck, ramp));
      expect(t).not.toEqual(ramp);
      expect(deck.zones.some((z) => z.tiles.some((z1) => z1.x === t.x && z1.y === t.y))).toBe(
        false,
      );
    }
    // The airlock's corners come first: (0,0) and (0,4) are as tucked away and as near the ramp
    // at (0,2); the row breaks the tie.
    expect(all.slice(0, 2)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 4 },
    ]);
  });
});

describe("the body aboard (§the-body-aboard)", () => {
  it("is carried by a crewmate to the first resting place and left there", () => {
    const test = medicalWorld();
    const { world } = test;
    underWay(test, false);
    killAt(world, PRIYA, BRIDGE);
    const place = places(world)[0];
    runFor(test, 1);
    expect(bodyProblems(world)).toMatchObject([
      {
        status: "open",
        owner: "medical",
        visibility: "public",
        baseUrgency: "routineObligation",
        dedupeKey: `body:${PRIYA}`,
        payload: { actorId: PRIYA, tile: place },
      },
    ]);
    const labels = new Set<string>();
    const events = runUntil(test, 180, (w) => {
      for (const a of Object.values(w.state.actors)) {
        if (a.activity.kind !== "idle" && a.activity.label !== undefined) {
          labels.add(a.activity.label);
        }
      }
      return bodyProblems(w)[0]?.status === "resolved";
    });
    const laid = ofType(events, "bodyLaidOut");
    expect(laid).toHaveLength(1);
    expect(laid[0]?.payload.actorId).toBe(PRIYA);
    expect(lyingAt(world, PRIYA)).toEqual(place);
    const carrier = actorOf(world, laid[0]?.payload.byActorId ?? PRIYA).name;
    expect(laid[0] && tickerLine(laid[0], world.state, world.content)).toBe(
      `${carrier} lays Priya Kessler out in the airlock`,
    );
    expect(labels).toContain("lifting Priya Kessler's body");
    expect(labels).toContain("carrying Priya Kessler's body to the airlock");
    // Laid out, she is left there: no second problem, no second carry.
    const later = runFor(test, 30);
    expect(ofType(later, "bodyLaidOut")).toEqual([]);
    expect(bodyProblems(world)).toHaveLength(1);
    expect(lyingAt(world, PRIYA)).toEqual(place);
    expect(bodiesWorldViolations(world)).toEqual([]);
  });

  it("two bodies go to two places", () => {
    const test = medicalWorld();
    const { world } = test;
    underWay(test, false);
    killAt(world, PRIYA, BRIDGE);
    killAt(world, MARA, { x: BRIDGE.x, y: BRIDGE.y - 2 });
    runUntil(test, 400, (w) => bodyProblems(w).filter((p) => p.status === "resolved").length === 2);
    const [first, second] = places(world);
    const tiles = [lyingAt(world, PRIYA), lyingAt(world, MARA)];
    expect(tiles).toContainEqual(first);
    expect(tiles).toContainEqual(second);
  });

  it("is not raised for one who died where a body is laid out", () => {
    const test = medicalWorld();
    const { world } = test;
    underWay(test, false);
    const place = places(world)[0];
    if (place === undefined) throw new Error("no resting place");
    killAt(world, PRIYA, place);
    runFor(test, 5);
    expect(bodyProblems(world)).toEqual([]);
  });
});

describe("laid to rest (§laid-to-rest)", () => {
  it("docked at a port, the dead are carried ashore and leave the ship; their gear stays", () => {
    const test = medicalWorld();
    const { world } = test;
    const blaster = handBlaster(world, JAX);
    killAt(world, JAX, BRIDGE);
    // Down, he let go of what was in his hands; give him something on his belt too.
    const belt = world.state.items[blaster];
    if (belt === undefined) throw new Error("no blaster");
    belt.location = { kind: "equippedBy", actorId: JAX, slot: "belt" };
    const events = runFor(test, 1);
    const jax = actorOf(world, JAX);
    expect(jax.availability).toBe("dead");
    expect(jax.location).toMatchObject({ kind: "inExternalStore", portId: PORTS.a });
    const rested = ofType(events, "laidToRest");
    expect(rested.map((e) => e.payload)).toEqual([{ actorId: JAX, portId: PORTS.a }]);
    const alpha = world.content.ports[PORTS.a]?.name;
    expect(rested[0] && tickerLine(rested[0], world.state, world.content)).toBe(
      `Jax Okonkwo is carried ashore at ${alpha}`,
    );
    expect(world.state.items[blaster]?.location).toMatchObject({ kind: "onDeck" });
    expect(bodyProblems(world).filter((p) => p.status === "open")).toEqual([]);
    expect(bodiesWorldViolations(world)).toEqual([]);
  });

  it("a body laid out under way is carried ashore at the next port", () => {
    const test = medicalWorld();
    const { world } = test;
    underWay(test, false);
    killAt(world, PRIYA, BRIDGE);
    runUntil(test, 180, (w) => bodyProblems(w)[0]?.status === "resolved");
    world.state.travel = { stage: "docked", portId: PORTS.b };
    const events = runFor(test, 1);
    expect(ofType(events, "laidToRest").map((e) => e.payload)).toEqual([
      { actorId: PRIYA, portId: PORTS.b },
    ]);
    expect(actorOf(world, PRIYA).location).toMatchObject({ portId: PORTS.b });
  });

  it("docked at a landing site, the dead stay aboard", () => {
    const { world } = medicalWorld();
    killAt(world, JAX, BRIDGE);
    const alpha = world.content.ports[PORTS.a];
    if (alpha === undefined) throw new Error("no Alpha");
    const { ctx, drafts } = stepCtxOf(world);
    const asSite = {
      ...ctx,
      content: {
        ...world.content,
        ports: { ...world.content.ports, [PORTS.a]: { ...alpha, kind: "site" as const } },
      },
    };
    sweepBodies(asSite);
    expect(drafts.filter((d) => d.type === "laidToRest")).toEqual([]);
    expect(actorOf(world, JAX).location.kind).toBe("onDeck");
    expect(bodyProblems(world).map((p) => p.payload.actorId)).toEqual([JAX]);
  });

  it("a passenger's body is not the crew's to lay out or lay to rest", () => {
    const test = medicalWorld();
    const { world } = test;
    actorOf(world, PRIYA).passenger = true;
    killAt(world, PRIYA, BRIDGE);
    const events = runFor(test, 2);
    expect(ofType(events, "laidToRest")).toEqual([]);
    expect(bodyProblems(world)).toEqual([]);
    expect(actorOf(world, PRIYA).location.kind).toBe("onDeck");
  });
});
