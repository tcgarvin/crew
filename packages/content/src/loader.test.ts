import { describe, expect, it } from "vitest";
import { loadBundle, rawBundle } from "./loader";
import { validateBundle } from "./schemas/validate";
import { dockWalkableMask } from "./schemas/validate-dock";

/** The authored bundle, which must validate. */
function authoredBundle() {
  const result = loadBundle();
  if (!result.ok) throw new Error("content bundle failed validation");
  return result.bundle;
}

describe("loadBundle", () => {
  it("loads and validates the authored content bundle clean (L1-L3)", () => {
    const result = loadBundle();
    if (!result.ok) {
      // Pretty-print issues so a failure here is diagnosable at a glance.
      const details = result.issues.map((i) => `[${i.level}] ${i.path.join(".")}: ${i.message}`);
      throw new Error(`content bundle failed validation:\n${details.join("\n")}`);
    }
    expect(result.ok).toBe(true);
  });

  it("stows a welder torch aboard, which the generator's short needs and only Ossory sells (D71)", () => {
    const raw = rawBundle() as { scenarios: Record<string, { startingItems: unknown[] }> };
    const scenario = raw.scenarios["scenario.default_freighter_run"];
    expect(scenario?.startingItems).toContainEqual(
      expect.objectContaining({ itemDefId: "item.welder_torch", count: 1 }),
    );
    const withoutWelder = {
      ...raw,
      scenarios: {
        ...raw.scenarios,
        "scenario.default_freighter_run": {
          ...scenario,
          startingItems: (scenario?.startingItems ?? []).filter(
            (line) => (line as { itemDefId: string }).itemDefId !== "item.welder_torch",
          ),
        },
      },
    };
    const result = validateBundle(withoutWelder);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.message)).toContainEqual(
        expect.stringContaining('tool kind "welder", which "machine.generator" needs'),
      );
    }
  });

  it("computes a stable hash across repeated loads", () => {
    expect(rawBundle().hash).toBe(rawBundle().hash);
  });

  it("gives every crew member a voice of their own (D38)", () => {
    const bundle = authoredBundle();
    const voices = Object.values(bundle.crew).map((c) => c.voice);
    expect(voices).toHaveLength(10);
    for (const voice of voices) expect(voice.trim().split(/\s+/).length).toBeLessThan(60);
    expect(new Set(voices).size).toBe(10);
  });

  it("ships a generic passenger template with no skills, role tags or inventory", () => {
    const bundle = authoredBundle();
    const passenger = bundle.crew["crew.passenger" as keyof typeof bundle.crew];
    expect(passenger).toBeDefined();
    expect(passenger?.skills).toEqual({});
    expect(passenger?.roleTags).toEqual([]);
    expect(passenger?.startingInventory).toEqual([]);
    expect(passenger?.traits ?? []).toEqual([]);
  });

  it("gives every port a market, well stocked at the Hub and bare at Green Meridian (D47)", () => {
    const bundle = authoredBundle();
    const parts = (portId: string) =>
      bundle.ports[portId as keyof typeof bundle.ports]?.market.find(
        (line) => line.itemDefId === "item.spare_parts_stack",
      );
    expect(parts("port.crossroads_hub")).toMatchObject({ count: 4 });
    expect(parts("port.kessler_drift")).toMatchObject({ count: 1 });
    expect(parts("port.green_meridian")).toMatchObject({ count: 0 });
    for (const port of Object.values(bundle.ports)) {
      for (const line of port.market) {
        expect(bundle.items[line.itemDefId]).toBeDefined();
        expect(line.price).toBeGreaterThan(0);
      }
    }
    expect(bundle.config.commerce.market.maxStockPerCommand).toBe(4);
  });

  it("has 9 crew plus the passenger template, 10 traits, the default scenario, 20 items, 27 thoughts, 12 activities and 7 topics", () => {
    const bundle = rawBundle() as {
      crew: Record<string, unknown>;
      traits: Record<string, unknown>;
      scenarios: Record<string, unknown>;
      thoughts: Record<string, unknown>;
      items: Record<string, unknown>;
      activities: Record<string, unknown>;
      topics: Record<string, unknown>;
    };
    expect(Object.keys(bundle.crew)).toHaveLength(10);
    expect(Object.keys(bundle.items)).toHaveLength(20);
    expect(Object.keys(bundle.traits)).toHaveLength(10);
    expect(Object.keys(bundle.scenarios)).toHaveLength(1);
    expect(Object.keys(bundle.activities)).toHaveLength(12);
    expect(Object.keys(bundle.topics)).toHaveLength(7);
    expect(Object.keys(bundle.thoughts).sort()).toEqual([
      "argued",
      "ateATreat",
      "ateInDirtyMess",
      "ateInFilthyMess",
      "ateRationPack",
      "ateWell",
      "burntDinner",
      "doubleWatch",
      "dressedDown",
      "enjoyedMusic",
      "goodCompany",
      "gotLectured",
      "hatedTheNoise",
      "heardOut",
      "helmCleanPass",
      "helmScrape",
      "keepsBeatingMe",
      "lostContest",
      "nearMiss",
      "noBunkOfMyOwn",
      "noisyBunkroom",
      "ownCabin",
      "satWithTheCaptain",
      "sparringBruise",
      "spiritedTalk",
      "stoodLongWatch",
      "wonContest",
    ]);
  });

  it("stands the default scenario's watch in three sections, Blue with a deckhand for the gangway, and two dayworkers (D77)", () => {
    const bundle = authoredBundle();
    const bill =
      bundle.scenarios["scenario.default_freighter_run" as keyof typeof bundle.scenarios]
        ?.watchBill;
    expect(bill?.sections.map((s) => s.key)).toEqual(["red", "white", "blue"]);
    expect(bill?.sections[0]?.members).toEqual([
      "crew.noor_haddad",
      "crew.mara_osei",
      "crew.priya_kessler",
    ]);
    expect(bill?.sections[2]?.members).toEqual(["crew.dane_whitcross", "crew.sunniva_park"]);
    expect(bill?.sections.flatMap((s) => s.members)).toHaveLength(7);
    expect(bill?.dayworkers).toEqual(["crew.bettina_solheim", "crew.oyelaran_abiodun"]);
  });

  it("sails the default scenario on Freighter Mk2 with nine crew, the captain first (D73)", () => {
    const bundle = authoredBundle();
    const scenario =
      bundle.scenarios["scenario.default_freighter_run" as keyof typeof bundle.scenarios];
    expect(scenario?.deckId).toBe("deck.freighter_mk2");
    expect(scenario?.crew).toHaveLength(9);
    expect(scenario?.crew[0]).toBe("crew.mara_osei");
    expect(scenario?.crew).toContain("crew.noor_haddad");
  });

  it("keeps Mk1 loadable as a second footprint beside Mk2 (D73)", () => {
    const bundle = authoredBundle();
    expect(Object.keys(bundle.decks).sort()).toEqual(["deck.freighter_mk1", "deck.freighter_mk2"]);
  });

  it("gives Mk2 a bed for every crew member and a spare, and every bunk a locker (D73)", () => {
    const bundle = authoredBundle();
    const deck = bundle.decks["deck.freighter_mk2" as keyof typeof bundle.decks];
    if (deck === undefined) throw new Error("no Mk2");
    const beds = deck.machines.filter((m) => bundle.machines[m.machineDefId]?.tags.includes("bed"));
    expect(beds).toHaveLength(12);
    const lockerOwners = deck.zones
      .filter((z) => z.tags.includes("locker"))
      .map((z) => z.machineKey);
    expect(lockerOwners.sort()).toEqual(beds.map((b) => b.key).sort());
  });

  it("puts no crew spawn point of either deck on a machine or its interaction tile (D73)", () => {
    const bundle = authoredBundle();
    for (const deck of Object.values(bundle.decks)) {
      const taken = new Set<string>();
      for (const placement of deck.machines) {
        const def = bundle.machines[placement.machineDefId];
        if (def === undefined) throw new Error(`unknown machine ${placement.machineDefId}`);
        const turn = (o: { x: number; y: number }) =>
          placement.rotation === 0
            ? o
            : placement.rotation === 180
              ? { x: -o.x, y: -o.y }
              : placement.rotation === 90
                ? { x: -o.y, y: o.x }
                : { x: o.y, y: -o.x };
        const offsets = [...def.footprint, ...def.interactionPositions.map((p) => p.offset)];
        for (const offset of offsets) {
          const t = turn(offset);
          taken.add(`${placement.origin.x + t.x},${placement.origin.y + t.y}`);
        }
      }
      const crewSpawns = deck.spawnPoints.filter((p) => p.tags.includes("crew"));
      for (const point of crewSpawns) {
        expect(taken.has(`${point.tile.x},${point.tile.y}`), `${deck.id} ${point.key}`).toBe(false);
      }
    }
  });

  it("tags the harmonica and the old photograph as personal belongings", () => {
    const bundle = authoredBundle();
    for (const id of ["item.harmonica", "item.old_photograph"]) {
      expect(bundle.items[id as keyof typeof bundle.items]?.tags).toContain("personal");
    }
  });
});

describe("port distances (D10: short hop <= ~30s)", () => {
  const bundle = rawBundle() as {
    ports: Record<
      string,
      { id: string; routes: readonly { toPortId: string; distance: number }[] }
    >;
  };

  function distance(from: string, to: string): number | undefined {
    return bundle.ports[from]?.routes.find((r) => r.toPortId === to)?.distance;
  }

  it("hub <-> mining is a short hop (~25s)", () => {
    expect(distance("port.crossroads_hub", "port.kessler_drift")).toBe(25);
    expect(distance("port.kessler_drift", "port.crossroads_hub")).toBe(25);
  });

  it("hub <-> agri is a medium hop (~45s)", () => {
    expect(distance("port.crossroads_hub", "port.green_meridian")).toBe(45);
    expect(distance("port.green_meridian", "port.crossroads_hub")).toBe(45);
  });

  it("mining <-> agri is the long hop (~70s)", () => {
    expect(distance("port.kessler_drift", "port.green_meridian")).toBe(70);
    expect(distance("port.green_meridian", "port.kessler_drift")).toBe(70);
  });
});

describe("the six-port galaxy (passengers spec §2.1, §2.4)", () => {
  const bundle = authoredBundle();
  const ports = bundle.ports;
  const ids = Object.keys(ports).sort();

  it("has the three core ports and three far ports", () => {
    expect(ids).toEqual([
      "port.crossroads_hub",
      "port.green_meridian",
      "port.kessler_drift",
      "port.ossory_station",
      "port.terns_rest",
      "port.vesper_gate",
    ]);
  });

  it("puts every far port on a single long spur off one core port, a watch long (D76)", () => {
    const spur = (id: string) => ports[id as keyof typeof ports]?.routes;
    expect(spur("port.ossory_station")).toEqual([
      { toPortId: "port.kessler_drift", distance: 400 },
    ]);
    expect(spur("port.vesper_gate")).toEqual([{ toPortId: "port.green_meridian", distance: 400 }]);
    expect(spur("port.terns_rest")).toEqual([{ toPortId: "port.crossroads_hub", distance: 400 }]);
    const { time, travel } = bundle.config;
    expect(400 / travel.nominalSpeed).toBe(time.daySeconds / time.watchesPerDay);
  });

  it("lists every route in both directions with the same distance", () => {
    for (const port of Object.values(ports)) {
      for (const route of port.routes) {
        const back = ports[route.toPortId]?.routes.find((r) => r.toPortId === port.id);
        expect(back, `${port.id} -> ${route.toPortId}`).toBeDefined();
        expect(back?.distance).toBe(route.distance);
      }
    }
  });

  it("gives every port character, two or three cast seeds and a lounge for passengers ashore", () => {
    for (const port of Object.values(ports)) {
      expect(port.character.trim().length, port.id).toBeGreaterThan(0);
      expect(port.castSeed.length, port.id).toBeGreaterThanOrEqual(2);
      expect(port.castSeed.length, port.id).toBeLessThanOrEqual(3);
      expect(
        port.externalStores.some((s) => s.kind === "lounge"),
        port.id,
      ).toBe(true);
    }
  });

  it("gives every port one dock map, with at least one regular posted on it (Dockside §3.3)", () => {
    const docks = Object.values(bundle.docks ?? {});
    for (const port of Object.values(ports)) {
      expect(docks.filter((d) => d.portId === port.id).length, port.id).toBe(1);
      expect(
        port.castSeed.some((seed) => seed.post !== undefined),
        port.id,
      ).toBe(true);
    }
    const planets = docks.filter((d) => ports[d.portId]?.setting === "planet").map((d) => d.portId);
    expect(planets.sort()).toEqual(["port.green_meridian", "port.terns_rest"]);
  });

  it("puts every dock's warehouse door a short walk from its delivery bay (D69)", () => {
    // The delivery's receiver waits at the warehouse door and is sent for the crates only once
    // the hand truck is parked, which is when departure prep begins: a long walk (Kessler's was
    // 27 steps round the conveyor) loses the race to the cast-off.
    for (const dock of Object.values(bundle.docks ?? {})) {
      const mask = dockWalkableMask(dock);
      const floor = (x: number, y: number) =>
        x >= 0 && y >= 0 && x < dock.width && y < dock.height && mask[y * dock.width + x] === 1;
      const door = dock.posts.find((p) => p.kind === "warehouseDoor");
      const bay = dock.areas.find((a) => a.kind === "deliveryBay")?.rect;
      if (door === undefined || bay === undefined) throw new Error(`${dock.id}: no door or bay`);
      const inBay = (x: number, y: number) =>
        x >= bay.x && x < bay.x + bay.w && y >= bay.y && y < bay.y + bay.h;
      const steps = new Map<string, number>([[`${door.tile.x},${door.tile.y}`, 0]]);
      const queue = [door.tile];
      let found: number | undefined;
      for (let head = 0; head < queue.length && found === undefined; head++) {
        const t = queue[head] as { x: number; y: number };
        const here = steps.get(`${t.x},${t.y}`) ?? 0;
        if (inBay(t.x, t.y)) found = here;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const n = { x: t.x + dx, y: t.y + dy };
          if (!floor(n.x, n.y) || steps.has(`${n.x},${n.y}`)) continue;
          steps.set(`${n.x},${n.y}`, here + 1);
          queue.push(n);
        }
      }
      expect(found, dock.id).toBeDefined();
      expect(found, dock.id).toBeLessThanOrEqual(8);
    }
  });

  it("stocks each port differently (D47)", () => {
    const stock = Object.values(ports).map((p) =>
      p.market.map((l) => `${l.itemDefId}:${l.count}:${l.price}`).join(","),
    );
    expect(new Set(stock).size).toBe(stock.length);
  });
});
