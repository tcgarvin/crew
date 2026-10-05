/**
 * `privateTalk` (slice 4, call 15): the command, the walk to the cabin and the talk, on the berth
 * deck with a desk in the captain's cabin (`fixtures.ts`), and on the bridge deck for the helm.
 */
import { describe, expect, it } from "vitest";
import { BERTH, CAPTAIN_BED, bedUseTile } from "../../core/fixtures/berth-deck";
import type { TestWorld } from "../../core/fixtures/test-world";
import { cmd } from "../../core/fixtures/test-world";
import { createKernel } from "../../core/kernel";
import { createRegistry } from "../../core/registry";
import { actionLabel, tickerLine } from "../../core/render";
import type { SimEvent } from "../../core/types/events";
import type { ActorId } from "../../core/types/ids";
import type { World } from "../../core/types/kernel";
import { registerPlannerDefaults } from "../../planner/index";
import { registerNeeds } from "../needs/index";
import { registerSpatial } from "../spatial/index";
import { PORTS, fixtureEffectiveConfig } from "../travel/fixtures";
import { registerTravel } from "../travel/index";
import { travelTaskDerivations } from "../travel/tasks";
import { BRIDGE, MARA, NOOR, bridgeConfig, bridgeContent } from "../watch/fixtures/bridge-deck";
import { whoHasTheHelm } from "../watch/helm";
import { registerWatch } from "../watch/index";
import { isAsleep } from "../work/activity";
import { registerWork } from "../work/index";
import {
  CABIN_DESK,
  actorNamed,
  actorOf,
  cabinsWorld,
  hasThought,
  place,
  runTicks,
  seconds,
  tileOf,
} from "./fixtures";
import { registerCabins } from "./index";
import { talkCabin } from "./private-talk";

type TW = ReturnType<typeof cabinsWorld>;

function callIn(
  tw: TW,
  actorId: ActorId,
  tone: "warm" | "stern",
  source: "player" | "narrator" = "player",
) {
  return tw.kernel.enqueueCommand(
    tw.world,
    cmd({ source, kind: "privateTalk", payload: { actorId, tone } }),
  );
}

const ofType = <T extends SimEvent["type"]>(events: readonly SimEvent[], type: T) =>
  events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

const label = (world: World, id: ActorId) =>
  actionLabel(actorOf(world, id), world.state, world.content);

const compartmentKeyOf = (world: World, id: ActorId): string | undefined => {
  const tile = tileOf(world, id);
  if (tile === undefined) return undefined;
  const symbol = world.content.decks[BERTH.deck]?.tiles[tile.y]?.[tile.x];
  return world.content.decks[BERTH.deck]?.compartments.find((c) => c.symbol === symbol)?.key;
};

const conferTicks = (world: World, id: ActorId): number | undefined => {
  const activity = actorOf(world, id).activity;
  if (activity.kind === "idle" || activity.plan === undefined) return undefined;
  const step = activity.plan.steps[activity.plan.stepIndex];
  return step?.kind === "confer" ? step.ticksDone : undefined;
};

/** Call Ada in, run until the talk is held, and report what happened on the way. */
function holdTalkWithAda(tone: "warm" | "stern") {
  const tw = cabinsWorld();
  const { world } = tw;
  const captain = actorNamed(world, "Mara Voss");
  const ada = actorNamed(world, "Ada Kim");
  expect(callIn(tw, ada, tone).status).toBe("accepted");
  const labels = new Set<string>();
  let bothSince: number | undefined;
  const events = runTicks(
    tw,
    seconds(world, 120),
    (so) => ofType(so, "privateTalkHeld").length > 0,
    () => {
      labels.add(label(world, captain));
      labels.add(label(world, ada));
      const both =
        conferTicks(world, captain) !== undefined && conferTicks(world, ada) !== undefined;
      if (both && bothSince === undefined) bothSince = world.state.tick;
    },
  );
  return { tw, world, captain, ada, events, labels, bothSince };
}

describe("privateTalk: the talk (slice 4, call 15)", () => {
  it("a warm word: both walk to the captain's cabin, talk twenty seconds there, and Ada is heard out", () => {
    const { world, captain, ada, events, labels, bothSince } = holdTalkWithAda("warm");
    const [called] = ofType(events, "privateTalkCalled");
    const [held] = ofType(events, "privateTalkHeld");
    expect(called?.payload).toEqual({ captainId: captain, actorId: ada });
    expect(held?.payload).toEqual({ captainId: captain, actorId: ada, tone: "warm" });
    expect(ofType(events, "privateTalkMissed")).toHaveLength(0);
    // Twenty seconds counted from the tick both stood in the cabin on their `confer` steps (the
    // second to arrive starts the count on the tick they arrive).
    expect(bothSince).toBeDefined();
    expect((held?.tick ?? 0) - (bothSince ?? 0) + 1).toBe(seconds(world, 20));
    expect(tileOf(world, captain)).toEqual(CABIN_DESK.seat);
    expect(tileOf(world, ada)).toEqual(CABIN_DESK.standing);
    expect(compartmentKeyOf(world, ada)).toBe("captainsCabin");
    expect(hasThought(world, ada, "heardOut")).toBe(true);
    expect(hasThought(world, ada, "dressedDown")).toBe(false);
    expect(world.state.social.privateTalk).toBeUndefined();
    expect(labels).toContain("going to the captain's cabin");
    expect(labels).toContain("having a word with Ada Kim");
    expect(labels).toContain("having a word with the captain");
    const ticker = events.map((e) => tickerLine(e, world.state, world.content)).filter(Boolean);
    expect(ticker).toContain("Mara Voss asked Ada Kim for a word in the captain's cabin");
    expect(ticker).toContain("Mara Voss had a word with Ada Kim");
  });

  it("both leave the cabin's business once it is held: neither is still conferring", () => {
    const { tw, world, captain, ada } = holdTalkWithAda("warm");
    runTicks(tw, 2);
    for (const id of [captain, ada]) {
      const activity = actorOf(world, id).activity;
      expect(activity.kind === "personal" && activity.activity === "privateTalk").toBe(false);
    }
  });

  it("a stern word leaves Ada dressed down, not heard out", () => {
    const { world, ada, events } = holdTalkWithAda("stern");
    expect(ofType(events, "privateTalkHeld")[0]?.payload.tone).toBe("stern");
    expect(hasThought(world, ada, "dressedDown")).toBe(true);
    expect(hasThought(world, ada, "heardOut")).toBe(false);
  });

  // W2's `moveAffinity` is a gate stub in this tree: the affinity outcome lands with W2.
  it.todo("warm moves Ada's affinity for the captain +2 and the captain's for Ada +1 (after W2)");
  it.todo(
    "stern moves Ada's affinity for the captain -2 and the captain's for Ada not at all (after W2)",
  );

  it("with the captain asleep the first officer holds it, in the officers' cabin", () => {
    const tw = cabinsWorld();
    const { world } = tw;
    const captain = actorNamed(world, "Mara Voss");
    const officer = actorNamed(world, "Ines Ward");
    const ada = actorNamed(world, "Ada Kim");
    place(world, captain, bedUseTile(CAPTAIN_BED));
    actorOf(world, captain).needs.fatigue = 0.8;
    runTicks(tw, seconds(world, 60), () => isAsleep(actorOf(world, captain).activity));
    expect(callIn(tw, ada, "warm").status).toBe("accepted");
    const keep = () => {
      actorOf(world, captain).needs.fatigue = 0.8;
    };
    const events = runTicks(
      tw,
      seconds(world, 120),
      (so) => ofType(so, "privateTalkHeld").length > 0,
      keep,
    );
    expect(ofType(events, "privateTalkHeld")[0]?.payload).toEqual({
      captainId: officer,
      actorId: ada,
      tone: "warm",
    });
    expect(compartmentKeyOf(world, officer)).toBe("officersCabin");
    expect(compartmentKeyOf(world, ada)).toBe("officersCabin");
    expect(tileOf(world, officer)).not.toEqual(tileOf(world, ada));
    expect(isAsleep(actorOf(world, captain).activity)).toBe(true);
    const ticker = events.map((e) => tickerLine(e, world.state, world.content)).filter(Boolean);
    expect(ticker).toContain("Ines Ward asked Ada Kim for a word in the first officer's cabin");
  });
});

describe("privateTalk: who can be called in (slice 4, call 15)", () => {
  it("rejects the captain calling herself, a passenger, someone ashore, and a second talk", () => {
    const tw = cabinsWorld();
    const { world } = tw;
    const captain = actorNamed(world, "Mara Voss");
    const ada = actorNamed(world, "Ada Kim");
    const bo = actorNamed(world, "Bo Lindqvist");
    const cy = actorNamed(world, "Cy Mbeki");
    expect(callIn(tw, captain, "warm").status).toBe("rejected");
    actorOf(world, bo).passenger = true;
    expect(callIn(tw, bo, "warm").status).toBe("rejected");
    actorOf(world, cy).availability = "offShip";
    expect(callIn(tw, cy, "warm").status).toBe("rejected");
    expect(callIn(tw, ada, "warm", "narrator").status).toBe("rejected");
    expect(callIn(tw, ada, "stern").status).toBe("accepted");
    runTicks(tw, 1);
    expect(world.state.social.privateTalk).toMatchObject({ captainId: captain, actorId: ada });
    expect(callIn(tw, actorNamed(world, "Dee Park"), "warm").status).toBe("rejected");
  });

  it("names the cabin from the caller's rank: the captain's, the first officer's, nobody else's", () => {
    const { world } = cabinsWorld();
    const cabinKey = (name: string) => {
      const id = talkCabin(world.state, world.content, actorNamed(world, name));
      return id === undefined ? undefined : world.state.compartments[id]?.key;
    };
    expect(cabinKey("Mara Voss")).toBe("captainsCabin");
    expect(cabinKey("Ines Ward")).toBe("officersCabin");
    expect(cabinKey("Ada Kim")).toBeUndefined();
  });
});

describe("privateTalk: a talk not held (slice 4, call 15)", () => {
  it("times out with privateTalkMissed when the one called in cannot come, and both steps end", () => {
    const tw = cabinsWorld();
    const { world } = tw;
    const captain = actorNamed(world, "Mara Voss");
    const ada = actorNamed(world, "Ada Kim");
    expect(callIn(tw, ada, "warm").status).toBe("accepted");
    // Ada is held at the far end of the corridor, never walking: she cannot answer.
    const pin = () => place(world, ada, { x: 15, y: 6 });
    const events = runTicks(tw, seconds(world, 130), () => false, pin);
    const missed = ofType(events, "privateTalkMissed");
    expect(missed).toHaveLength(1);
    expect(missed[0]?.payload).toEqual({ captainId: captain, actorId: ada });
    expect((missed[0]?.tick ?? 0) - (ofType(events, "privateTalkCalled")[0]?.tick ?? 0)).toBe(
      seconds(world, 120),
    );
    expect(world.state.social.privateTalk).toBeUndefined();
    expect(ofType(events, "privateTalkHeld")).toHaveLength(0);
    const activity = actorOf(world, captain).activity;
    expect(activity.kind === "personal" && activity.activity === "privateTalk").toBe(false);
    const ticker = events.map((e) => tickerLine(e, world.state, world.content)).filter(Boolean);
    expect(ticker).toContain("Ada Kim never made it to the captain's cabin");
  });
});

// ---------------------------------------------------------------------------------------------
// The helm: the bridge deck with a captain's cabin over the bridge
// ---------------------------------------------------------------------------------------------

/**
 * The D77 bridge deck with its north-east corner made the captain's cabin (no desk), reached from
 * the bridge through an opening south of (11,0); a 900 s day, so Red's watch outlasts the wait,
 * and a ten-minute leg.
 *
 *   x 0123456789ABCD
 *   0 LLLMMMMMBNBKKK
 *   1 LLLMMMMMBBBBsH    the helm (13,1), its seat (12,1)
 */
function helmWorld(): TestWorld {
  const base = bridgeConfig();
  const config = {
    ...base,
    time: { ...base.time, daySeconds: 900 },
    travel: { ...base.travel, nominalSpeed: 25 / 600 },
  };
  const content = bridgeContent(config);
  const deck = content.decks[BRIDGE.deck];
  if (deck === undefined) throw new Error("bridge content lost its deck");
  const cabinDeck = {
    ...deck,
    tiles: deck.tiles.map((row, y) => (y === 0 ? `${row.slice(0, 11)}KKK` : row)),
    compartments: [
      ...deck.compartments,
      {
        key: "captainsCabin",
        symbol: "K",
        name: "Captain's Cabin",
        tags: ["cabin", "captainsCabin"],
      },
    ],
    openings: [...deck.openings, { x: 11, y: 0, side: "s" as const }],
  };
  const registry = createRegistry();
  registerSpatial(registry);
  registerTravel(registry);
  registerNeeds(registry);
  registerWatch(registry);
  registerCabins(registry);
  registerWork(registry, { derivations: travelTaskDerivations });
  registerPlannerDefaults(registry);
  const kernel = createKernel(registry);
  const world = kernel.createWorld(
    BRIDGE.scenario,
    7,
    { ...content, decks: { [BRIDGE.deck]: cabinDeck } },
    fixtureEffectiveConfig(config),
  );
  return { registry, kernel, world };
}

describe("privateTalk: the helm is not interrupted (slice 4, call 15)", () => {
  it("a talk whose crew member is at the helm waits and times out, and the helm is never left", () => {
    const tw = helmWorld();
    const { world, kernel } = tw;
    kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "setCourse", payload: { destinationPortId: PORTS.b } }),
    );
    runTicks(tw, 1);
    const travel = world.state.travel;
    if (travel.stage !== "docked") throw new Error("not docked");
    travel.coursePlotted = true;
    const atHelm = () => whoHasTheHelm(world.state, world.content);
    // Under way, with Noor in the seat: the stander's hold, not the departure's manoeuvre.
    runTicks(
      tw,
      seconds(world, 120),
      () => world.state.travel.stage === "transit" && atHelm() === NOOR,
    );
    expect(world.state.travel.stage).toBe("transit");
    expect(atHelm()).toBe(NOOR);

    expect(callIn(tw, NOOR, "warm").status).toBe("accepted");
    let left = false;
    const events = runTicks(
      tw,
      seconds(world, 125),
      (so) => ofType(so, "privateTalkMissed").length > 0,
      () => {
        if (world.state.tick > 2 && atHelm() !== NOOR) left = true;
      },
    );
    expect(ofType(events, "privateTalkMissed")[0]?.payload).toEqual({
      captainId: MARA,
      actorId: NOOR,
    });
    expect(ofType(events, "privateTalkHeld")).toHaveLength(0);
    expect(left).toBe(false);
    expect(atHelm()).toBe(NOOR);
    // The captain answered her own summons: she went to her cabin and waited there.
    const location = actorOf(world, MARA).location;
    expect(location.kind === "onDeck" && location.y < 1 && location.x >= 11).toBe(true);
  });
});
