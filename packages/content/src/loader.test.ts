import { describe, expect, it } from "vitest";
import { loadBundle, rawBundle } from "./loader";
import { interestTagSchema } from "./schemas/primitives";
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

  it("calls the narrator in the aftermath on alertCleared, navHazard and faultRepaired, and no longer on fieldCleared (§notable-event-hook)", () => {
    const narrator = authoredBundle().config.narrator;
    expect(narrator.aftermathHookOnEvents).toEqual(["alertCleared", "navHazard", "faultRepaired"]);
    expect(narrator.hookOnEvents).not.toContain("fieldCleared");
  });

  it("gates every docking-fee chat line on a paid fee, so none comes up at a site (§ambient-chat)", () => {
    const lines = authoredBundle().config.social.templateLines;
    const aboutTheFee = lines.filter((line) =>
      (typeof line === "string" ? line : line.line).includes("docking fee"),
    );
    expect(aboutTheFee.length).toBeGreaterThan(0);
    for (const line of aboutTheFee) expect(line).toMatchObject({ when: "paidDockingFee" });
  });

  it("gates every coolant-pump chat line on a pump with a fault (§chat-line-conditions)", () => {
    const lines = authoredBundle().config.social.templateLines;
    const aboutThePump = lines.filter((line) =>
      (typeof line === "string" ? line : line.line).includes("coolant pump"),
    );
    expect(aboutThePump.length).toBeGreaterThan(0);
    for (const line of aboutThePump) expect(line).toMatchObject({ when: "pumpSymptom" });
  });

  it("tells the arrival card at the Lazaret what holding the ramp comes to (§the-lazaret)", () => {
    const docks = Object.values(authoredBundle().docks ?? {});
    expect(docks.find((d) => d.id === "dock.lazaret")?.holdWhy).toMatch(/lifeboat lock/);
    // The other sites keep the usual words: holding works there.
    const others = docks.filter((d) => d.kind === "site" && d.id !== "dock.lazaret");
    expect(others.length).toBeGreaterThan(0);
    for (const dock of others) expect(dock.holdWhy).toBeUndefined();
  });

  it("stows a welder torch aboard, which the generator's short needs and only Ossory sells (§scenario-tools)", () => {
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

  it("gives every crew member a voice of their own (§crew-lines)", () => {
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

  it("gives every port a market, well stocked at the Hub and bare at Green Meridian (§market-stock)", () => {
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

  it("has 9 crew plus the passenger template, 10 traits, the default scenario, 24 items, 41 thoughts, 15 activities and 10 topics", () => {
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
    expect(Object.keys(bundle.items)).toHaveLength(24);
    expect(Object.keys(bundle.traits)).toHaveLength(10);
    expect(Object.keys(bundle.scenarios)).toHaveLength(1);
    expect(Object.keys(bundle.activities)).toHaveLength(15);
    expect(Object.keys(bundle.topics)).toHaveLength(10);
    expect(Object.keys(bundle.thoughts).sort()).toEqual([
      "argued",
      "ateATreat",
      "ateInDirtyMess",
      "ateInFilthyMess",
      "ateRationPack",
      "ateWell",
      "bakedForTheCrew",
      "burntDinner",
      "cookedWell",
      "doubleWatch",
      "dressedDown",
      "enjoyedMusic",
      "fixedIt",
      "goodCompany",
      "gotLectured",
      "grieving",
      "hatedTheNoise",
      "heardOut",
      "heartened",
      "heldTheLine",
      "helmCleanPass",
      "helmScrape",
      "keepsBeatingMe",
      "killedSomeone",
      "lostContest",
      "nearMiss",
      "noBunkOfMyOwn",
      "nobodyJoinedIn",
      "noisyBunkroom",
      "ownCabin",
      "ranFromAFight",
      "satWithTheCaptain",
      "sawCrewHurt",
      "shaken",
      "sparringBruise",
      "spiritedTalk",
      "squaredAway",
      "stoodLongWatch",
      "wonContest",
      "worriedAbout",
      "wounded",
    ]);
  });

  it("stands the default scenario's watch in three sections, Blue with a deckhand for the gangway, and two dayworkers (§sections-and-dayworkers)", () => {
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

  it("sails the default scenario on Freighter Mk2 with nine crew, the captain first (§the-ships)", () => {
    const bundle = authoredBundle();
    const scenario =
      bundle.scenarios["scenario.default_freighter_run" as keyof typeof bundle.scenarios];
    expect(scenario?.deckId).toBe("deck.freighter_mk2");
    expect(scenario?.crew).toHaveLength(9);
    expect(scenario?.crew[0]).toBe("crew.mara_osei");
    expect(scenario?.crew).toContain("crew.noor_haddad");
  });

  it("keeps Mk1 loadable as a second footprint beside Mk2 (§the-ships)", () => {
    const bundle = authoredBundle();
    expect(Object.keys(bundle.decks).sort()).toEqual(["deck.freighter_mk1", "deck.freighter_mk2"]);
  });

  it("gives Mk2 a bed for every crew member and a spare, and every bunk a locker (§what-a-deck-must-offer)", () => {
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

  it("puts no crew spawn point of either deck on a machine or its interaction tile (§what-a-deck-must-offer)", () => {
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

  it("puts every topic on some activity's list, so none is authored and never picked (§outcomes)", () => {
    const bundle = authoredBundle();
    const listed = new Set(Object.values(bundle.activities).flatMap((a) => a.topics ?? []));
    expect([...listed].sort()).toEqual(Object.keys(bundle.topics).sort());
    expect(bundle.activities["activity.debate" as keyof typeof bundle.activities]?.topics).toEqual(
      expect.arrayContaining(["topic.salvage_rights", "topic.ghost_ships"]),
    );
  });

  it("names every interest in some activity, and gives readers a group one (§activities-and-interests)", () => {
    const bundle = authoredBundle();
    const named = new Set(Object.values(bundle.activities).map((a) => a.interest));
    expect([...named].sort()).toEqual([...interestTagSchema.options].sort());
    const reading = Object.values(bundle.activities).filter((a) => a.interest === "reading");
    // A reader can sit alone with a book or host the book club, which is a group.
    expect(reading.map((a) => a.participants.max).sort()).toEqual([1, 3]);
  });

  it("keeps each machine's first fault the likelier draw beside the variety pack's milder one (§wear-and-fault-draws)", () => {
    const bundle = authoredBundle();
    const faults = (id: string) =>
      bundle.machines[id as keyof typeof bundle.machines]?.faults.map((f) => [f.key, f.weight]);
    expect(faults("machine.engine")).toEqual([
      ["failed_controller", 1],
      ["fouled_injector", 0.5],
    ]);
    expect(faults("machine.coolant_pump")).toEqual([
      ["worn_bearing", 1],
      ["air_locked_line", 0.5],
    ]);
    // Neither new repair spends a part: a wrench (and the engine's multimeter) is all they need.
    for (const id of ["machine.engine", "machine.coolant_pump"]) {
      const added = bundle.machines[id as keyof typeof bundle.machines]?.faults[1];
      expect(added?.effect.kind).toBe("derate");
      expect(added?.repair.steps.flatMap((s) => s.consumes)).toEqual([]);
    }
  });

  it("breaks down beyond the engine room: life support, battery bank, stove and nav terminal each have a fault (§authored-faults)", () => {
    const bundle = authoredBundle();
    const machine = (id: string) => bundle.machines[id as keyof typeof bundle.machines];
    const shape = (id: string) =>
      machine(id)?.faults.map((f) => [f.key, f.effect, f.symptom.channel, f.repair.steps.length]);
    expect(shape("machine.life_support")).toEqual([
      ["scrubber_clog", { kind: "derate", outputFactor: 0.7 }, "sensor", 3],
    ]);
    expect(shape("machine.battery_bank")).toEqual([
      ["cell_degradation", { kind: "derate", outputFactor: 0.5 }, "sensor", 3],
    ]);
    expect(shape("machine.galley_stove")).toEqual([
      ["burner_fault", { kind: "inoperable" }, "visual", 3],
    ]);
    expect(shape("machine.nav_terminal")).toEqual([
      ["chart_fault", { kind: "inoperable" }, "sensor", 3],
    ]);
    // Diagnosis and repair stand at a `repair` position, so the stove and the terminal have one.
    for (const id of ["machine.galley_stove", "machine.nav_terminal"]) {
      expect(machine(id)?.interactionPositions.some((p) => p.purposes.includes("repair"))).toBe(
        true,
      );
    }
    // The chart fault spends no part: a ship that cannot plot cannot sail to buy one.
    expect(
      machine("machine.nav_terminal")?.faults[0]?.repair.steps.flatMap((s) => s.consumes),
    ).toEqual([]);
  });

  it("carries the new spares from the start and sells each at two or more ports (§reserve-kinds)", () => {
    const bundle = authoredBundle();
    const scenario =
      bundle.scenarios["scenario.default_freighter_run" as keyof typeof bundle.scenarios];
    for (const id of ["item.filter_cartridge", "item.heating_element"]) {
      expect(bundle.items[id as keyof typeof bundle.items]?.tags).toContain("spare");
      const carried = scenario?.startingItems
        .filter((line) => line.itemDefId === id)
        .reduce((sum, line) => sum + line.count, 0);
      expect(carried, id).toBe(bundle.config.commerce.sparesReserve);
      const selling = Object.values(bundle.ports).filter((port) =>
        port.market.some((line) => line.itemDefId === id && line.count > 0),
      );
      expect(selling.length, id).toBeGreaterThanOrEqual(2);
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
  // Expeditions A1 (call 1): the landing site is a port of `kind: "site"`, not one of the six.
  const ports = Object.fromEntries(
    Object.entries(bundle.ports).filter(([, port]) => port.kind !== "site"),
  ) as typeof bundle.ports;
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

  it("puts every far port on a single long spur off one core port, a watch long (§the-ships-day)", () => {
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
    const docks = Object.values(bundle.docks ?? {}).filter((d) => d.kind !== "site");
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

  it("puts every dock's warehouse door a short walk from its delivery bay (§dock-map-validation)", () => {
    // The delivery's receiver waits at the warehouse door and is sent for the crates only once
    // the hand truck is parked, which is when departure prep begins: a long walk (Kessler's was
    // 27 steps round the conveyor) loses the race to the cast-off.
    for (const dock of Object.values(bundle.docks ?? {}).filter((d) => d.kind !== "site")) {
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

  it("has three landing sites, the Boathouse, Harrow End and the Lazaret, that no port lists (expeditions A1, call 1)", () => {
    const sites = Object.values(bundle.ports).filter((p) => p.kind === "site");
    expect(sites.map((s) => s.id)).toEqual(["port.boathouse", "port.harrow_end", "port.lazaret"]);
    const expected = [
      {
        id: "port.boathouse",
        near: "port.terns_rest",
        cast: ["Corran Vale", "Hesk Marrow", "Darrow Finch", "Old Pell"],
      },
      {
        id: "port.harrow_end",
        near: "port.green_meridian",
        cast: ["Teodor Lusk", "Rhee Castellan", "Mattie Lusk", "Amos Wray", "Wenna Brae"],
      },
      {
        id: "port.lazaret",
        near: "port.vesper_gate",
        cast: ["Orrin Sallow", "Brannoch Teale", "Sister Hedda Vosk", "Dace Corley", "Ines Haddow"],
      },
    ];
    for (const { id, near, cast } of expected) {
      const site = sites.find((s) => s.id === id);
      expect(site?.nearPortId, id).toBe(near);
      expect(site?.routes, id).toEqual([{ toPortId: near, distance: 20 }]);
      expect(site?.market, id).toEqual([]);
      for (const port of Object.values(ports)) {
        expect(
          port.routes.some((r) => r.toPortId === id),
          port.id,
        ).toBe(false);
      }
      const map = Object.values(bundle.docks ?? {}).find((d) => d.portId === id);
      expect(map?.kind, id).toBe("site");
      expect(
        map?.defaultCast?.map((c) => c.name),
        id,
      ).toEqual(cast);
    }
  });

  it("sells patch kits wherever it sells hull plating, so a scarred ship restocks both (§plating-and-kits-at-port)", () => {
    const all = Object.values(ports);
    const sells = (port: (typeof all)[number], itemDefId: string) =>
      port.market.some((line) => line.itemDefId === itemDefId);
    for (const port of all.filter((p) => sells(p, "item.hull_plating"))) {
      expect(sells(port, "item.patch_kit"), port.id).toBe(true);
    }
  });

  it("stocks each port differently (§market-stock)", () => {
    const stock = Object.values(ports).map((p) =>
      p.market.map((l) => `${l.itemDefId}:${l.count}:${l.price}`).join(","),
    );
    expect(new Set(stock).size).toBe(stock.length);
  });
});
