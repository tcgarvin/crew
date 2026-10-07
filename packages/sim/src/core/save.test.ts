import { describe, expect, it } from "vitest";
import { cmd, tinyTestWorld } from "./fixtures/test-world";
import { TINY, tinyConfig, tinyContent, tinyEffectiveConfig } from "./fixtures/tiny-content";
import { createKernel } from "./kernel";
import { migrations } from "./migrations";
import { createRegistry } from "./registry";
import { SaveCompatibilityError, migrateState, restore, serialize } from "./save";
import type { ContentBundle } from "./types/content";
import type { ItemDefId } from "./types/ids";
import { SIM_VERSION } from "./types/save";
import { SCHEMA_VERSION } from "./types/state";

describe("serialize / restore", () => {
  it("round-trips state exactly and rebuilds caches", () => {
    const { world, kernel, registry } = tinyTestWorld();
    kernel.enqueueCommand(
      world,
      cmd({
        source: "scenario",
        kind: "scenarioSetNeeds",
        targetTick: 30,
        payload: { actorId: "a1" as never, needs: { social: 0.5 } },
      }),
    );
    kernel.advance(world, 12);
    const envelope = serialize(world);
    expect(envelope).toMatchObject({
      schemaVersion: SCHEMA_VERSION,
      simVersion: SIM_VERSION,
      contentHash: world.content.hash,
      configHash: world.config.hash,
      savedAtTick: 12,
    });
    // The envelope is a detached copy.
    expect(envelope.state).not.toBe(world.state);
    expect(envelope.state).toStrictEqual(world.state);

    const blob = JSON.parse(JSON.stringify(envelope));
    const restored = restore(blob, world.content, registry);
    expect(restored.state).toStrictEqual(world.state);
    expect(restored.config).toEqual(world.config);
    expect(restored.caches.dirty).toEqual({ navigation: true, power: true, inventory: true });
    expect(restored.caches.index.itemsByHolder).toEqual(world.caches.index.itemsByHolder);

    // Both copies continue identically, including the queued command.
    kernel.advance(world, 20);
    kernel.advance(restored, 20);
    expect(restored.state).toStrictEqual(world.state);
    expect(restored.state.actors["a1" as never]?.needs.social).toBe(0.5);
  });

  it("applies a registered migration from the previous schema version", () => {
    const { world, registry } = tinyTestWorld();
    const envelope = serialize(world);
    const oldState = JSON.parse(JSON.stringify(envelope.state));
    // Pretend v(N-1) called the narrator field `quietSince` and had no recentHookIds.
    const { lastNarrativeTick, recentHookIds: _dropped, ...narratorRest } = oldState.narrator;
    oldState.narrator = { ...narratorRest, quietSince: lastNarrativeTick };
    oldState.schemaVersion = SCHEMA_VERSION - 1;
    const old = { ...envelope, schemaVersion: SCHEMA_VERSION - 1, state: oldState };

    const migrations = {
      [SCHEMA_VERSION - 1]: (raw: unknown) => {
        const s = raw as { narrator: Record<string, unknown> };
        const { quietSince, ...rest } = s.narrator;
        return { ...s, narrator: { ...rest, lastNarrativeTick: quietSince, recentHookIds: [] } };
      },
    };
    const restored = restore(old, world.content, registry, { migrations });
    expect(restored.state).toStrictEqual(world.state);
    expect(restored.state.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("rejects a save from a newer schema or with a migration gap", () => {
    const { world, registry } = tinyTestWorld();
    const envelope = serialize(world);
    expect(() =>
      restore({ ...envelope, schemaVersion: SCHEMA_VERSION + 1 }, world.content, registry),
    ).toThrow(/newer than this build supports/);
    expect(() =>
      migrateState(
        {},
        SCHEMA_VERSION - 1,
        { content: world.content, config: world.config.values },
        {},
      ),
    ).toThrow(SaveCompatibilityError);
  });

  it("refuses a schema-6 save rather than migrating its pre-ship-life geometry (D74)", () => {
    const { world, registry } = tinyTestWorld();
    const envelope = serialize(world);
    const old = { ...envelope, schemaVersion: 6, state: { ...envelope.state, schemaVersion: 6 } };
    expect(() => restore(old, world.content, registry)).toThrow(SaveCompatibilityError);
    expect(() => restore(old, world.content, registry)).toThrow(/predates ship life/);
  });

  it("migrates a schema-7 save to 8: sections from the scenario's bill, empty thoughts and hazards, the hazard budget (D77-D79)", () => {
    const { world, kernel, registry } = tinyTestWorld();
    kernel.advance(world, 40);
    const envelope = serialize(world);
    // Schema 7's shape: shifts, no thoughts, no watch or hazards, a two-line budget, staffing
    // problems owned by travel without a post.
    type Json = Record<string, unknown>;
    const at = (value: unknown, key: string) => (value as Json)[key] as Json;
    const raw = JSON.parse(JSON.stringify(envelope.state)) as Json;
    raw.schemaVersion = 7;
    for (const actor of Object.values(at(raw, "actors")) as Json[]) {
      actor.schedule = { shiftKey: "alpha" };
    }
    const strip = (value: Json, key: string) => {
      const { [key]: _gone, ...rest } = value;
      return rest;
    };
    const stripped = strip(strip(raw, "watch"), "hazards");
    stripped.nextId = strip(at(raw, "nextId"), "hazard");
    stripped.actors = Object.fromEntries(
      Object.entries(at(raw, "actors")).map(([id, actor]) => [
        id,
        strip(actor as Json, "thoughts"),
      ]),
    );
    const narrator = strip(at(raw, "narrator"), "budgetRefilledTick");
    narrator.budget = strip(at(narrator, "budget"), "hazardsRemaining");
    stripped.narrator = narrator;
    const problems = at(at(stripped, "work"), "problems");
    problems.p99 = {
      id: "p99",
      kind: "stationToStaff",
      payload: { machineId: "m1" },
      owner: "travel",
      visibility: "public",
      dedupeKey: "stationToStaff:m1",
      status: "resolved",
      createdTick: 1,
      revision: 1,
      baseUrgency: "essentialOperation",
      location: { kind: "machine", machineId: "m1" },
    };
    const nextId = at(stripped, "nextId");
    nextId.problem = Math.max(nextId.problem as number, 100);
    const old = { ...envelope, schemaVersion: 7, state: stripped } as unknown as typeof envelope;

    const restored = restore(old, world.content, registry);
    const state = restored.state;
    expect(state.schemaVersion).toBe(SCHEMA_VERSION);
    expect(state.actors["a1" as never]?.schedule).toEqual({ section: { key: "alpha", index: 0 } });
    expect(state.actors["a1" as never]?.thoughts).toEqual([]);
    expect(state.watch).toEqual({ lastBellWatch: 0, helm: {} });
    expect(state.hazards).toEqual([]);
    expect(state.nextId.hazard).toBe(1);
    expect(state.narrator.budget.hazardsRemaining).toBe(world.config.values.narrator.hazardBudget);
    expect(state.narrator.budgetRefilledTick).toBe(40);
    expect(state.work.problems["p99" as never]).toMatchObject({
      owner: "watch",
      payload: { machineId: "m1", post: "watch" },
    });
    kernel.advance(restored, 20);
    expect(restored.state.tick).toBe(60);
  });

  it("migrates a schema-8 save to 9: dirt zeroed, boots, the galley's bookkeeping, and the scenario's provisions and mop stowed (D81-D83)", () => {
    const PROVISIONS = "item.tiny.provisions" as ItemDefId;
    const MOP = "item.tiny.mop" as ItemDefId;
    // The tiny content with a pantry and a cleaning locker stocked by the scenario.
    const galleyContent = (): ContentBundle => {
      const base = tinyContent(tinyConfig());
      const deck = base.decks[TINY.deck];
      const scenario = base.scenarios[TINY.scenario];
      if (deck === undefined || scenario === undefined) throw new Error("tiny content");
      return {
        ...base,
        decks: {
          [TINY.deck]: {
            ...deck,
            zones: [
              ...deck.zones,
              { key: "pantry", name: "Pantry", tags: ["pantry"], tiles: [{ x: 2, y: 3 }] },
              {
                key: "cleaning_locker",
                name: "Cleaning Locker",
                tags: ["cleaningLocker"],
                tiles: [{ x: 1, y: 3 }],
              },
            ],
          },
        },
        items: {
          ...base.items,
          [PROVISIONS]: {
            id: PROVISIONS,
            name: "Provisions",
            stacking: "stackable",
            maxStack: 2,
            tags: ["provisions"],
            toolKinds: [],
            mass: 2,
          },
          [MOP]: {
            id: MOP,
            name: "Mop",
            stacking: "unique",
            maxStack: 1,
            tags: ["tool"],
            toolKinds: ["mop"],
            mass: 1,
          },
        },
        scenarios: {
          [TINY.scenario]: {
            ...scenario,
            startingItems: [
              ...scenario.startingItems,
              { itemDefId: PROVISIONS, count: 3, zoneKey: "pantry" },
              { itemDefId: MOP, count: 1, zoneKey: "cleaning_locker" },
            ],
          },
        },
      };
    };
    const registry = createRegistry();
    const kernel = createKernel(registry);
    const world = kernel.createWorld(TINY.scenario, 42, galleyContent(), tinyEffectiveConfig());
    kernel.advance(world, 40);
    const envelope = serialize(world);
    type Json = Record<string, unknown>;
    const at = (value: unknown, key: string) => (value as Json)[key] as Json;
    const strip = (value: Json, key: string) => {
      const { [key]: _gone, ...rest } = value;
      return rest;
    };
    // Schema 8's shape: no dirt or galley slice, no boots, and no galley stores aboard.
    const raw = JSON.parse(JSON.stringify(envelope.state)) as Json;
    raw.schemaVersion = 8;
    const stripped = strip(strip(raw, "dirt"), "galley");
    stripped.actors = Object.fromEntries(
      Object.entries(at(raw, "actors")).map(([id, actor]) => [id, strip(actor as Json, "boots")]),
    );
    const items = at(raw, "items");
    stripped.items = Object.fromEntries(
      Object.entries(items).filter(([, item]) => {
        const defId = (item as Json).defId;
        return defId !== PROVISIONS && defId !== MOP;
      }),
    );
    const old = { ...envelope, schemaVersion: 8, state: stripped } as unknown as typeof envelope;

    const restored = restore(old, world.content, registry);
    const state = restored.state;
    const deck = world.content.decks[TINY.deck];
    if (deck === undefined) throw new Error("no deck");
    expect(state.schemaVersion).toBe(SCHEMA_VERSION);
    expect(state.dirt.cells[TINY.deck]).toEqual(new Array(deck.width * deck.height).fill(0));
    expect(state.dirt.tiers).toEqual({});
    expect(state.dirt.dustThisVisit).toBe(0);
    expect(state.galley).toEqual({ lastMealWatch: 0 });
    for (const actor of Object.values(state.actors)) expect(actor.boots).toBe(0);
    // The stores came back in their zones, as fresh items below the moved counter.
    const stores = Object.values(state.items).filter(
      (item) => item.defId === PROVISIONS || item.defId === MOP,
    );
    const pantry = deck.zones.find((z) => z.key === "pantry")?.tiles ?? [];
    const locker = deck.zones.find((z) => z.key === "cleaning_locker")?.tiles ?? [];
    const crates = stores.filter((i) => i.defId === PROVISIONS);
    expect(crates.reduce((sum, i) => sum + (i.stacking === "stack" ? i.count : 0), 0)).toBe(3);
    for (const crate of crates) {
      const at = crate.location;
      if (at.kind !== "onDeck") throw new Error("crate not on deck");
      expect(pantry).toContainEqual({ x: Math.floor(at.x), y: Math.floor(at.y) });
    }
    const mop = stores.find((i) => i.defId === MOP);
    if (mop?.location.kind !== "onDeck") throw new Error("no mop on deck");
    expect(locker).toContainEqual({ x: Math.floor(mop.location.x), y: Math.floor(mop.location.y) });
    // Two crate stacks and the mop took three fresh ids off the save's own counter.
    expect(state.nextId.item).toBe(envelope.state.nextId.item + 3);
    expect(restored.warnings.some((w) => /predates the galley/.test(w))).toBe(true);
    kernel.advance(restored, 20);
    expect(restored.state.tick).toBe(60);
  });

  it("migrates a schema-9 save to 10: recreation, interests from the crew def, an empty social slice and the scenario's books shelved (slice 4)", () => {
    const BOOK = "item.tiny.book" as ItemDefId;
    const interests = {
      likes: ["cards" as const, "vids" as const],
      strong: "cards" as const,
      dislikes: [],
    };
    const values = { orderFreedom: 2, faithReason: 1, loyaltyAmbition: 2 };
    // The tiny content with a book shelf the scenario stocks, and Mara's interests authored.
    const shelfContent = (): ContentBundle => {
      const base = tinyContent(tinyConfig());
      const deck = base.decks[TINY.deck];
      const scenario = base.scenarios[TINY.scenario];
      const mara = base.crew[TINY.mara];
      if (deck === undefined || scenario === undefined || mara === undefined) {
        throw new Error("tiny content");
      }
      return {
        ...base,
        decks: {
          [TINY.deck]: {
            ...deck,
            zones: [
              ...deck.zones,
              {
                key: "book_shelf",
                name: "Book Shelf",
                tags: ["bookShelf"],
                tiles: [{ x: 4, y: 3 }],
              },
            ],
          },
        },
        items: {
          ...base.items,
          [BOOK]: {
            id: BOOK,
            name: "Book",
            stacking: "stackable",
            maxStack: 6,
            tags: ["book"],
            toolKinds: [],
            mass: 0.3,
          },
        },
        crew: { [TINY.mara]: { ...mara, interests, values } },
        scenarios: {
          [TINY.scenario]: {
            ...scenario,
            startingItems: [
              ...scenario.startingItems,
              { itemDefId: BOOK, count: 3, zoneKey: "book_shelf" },
            ],
          },
        },
      };
    };
    const registry = createRegistry();
    const kernel = createKernel(registry);
    const world = kernel.createWorld(TINY.scenario, 42, shelfContent(), tinyEffectiveConfig());
    kernel.advance(world, 40);
    const envelope = serialize(world);
    type Json = Record<string, unknown>;
    const at = (value: unknown, key: string) => (value as Json)[key] as Json;
    const strip = (value: Json, key: string) => {
      const { [key]: _gone, ...rest } = value;
      return rest;
    };
    // Schema 9's shape: no social slice or session counter, no recreation, interests or values,
    // and no books aboard.
    const raw = JSON.parse(JSON.stringify(envelope.state)) as Json;
    raw.schemaVersion = 9;
    const stripped = strip(raw, "social");
    stripped.nextId = strip(at(raw, "nextId"), "session");
    stripped.actors = Object.fromEntries(
      Object.entries(at(raw, "actors")).map(([id, actor]) => {
        const old = strip(strip(actor as Json, "interests"), "values");
        return [id, { ...old, needs: strip(at(actor, "needs"), "recreation") }];
      }),
    );
    stripped.items = Object.fromEntries(
      Object.entries(at(raw, "items")).filter(([, item]) => (item as Json).defId !== BOOK),
    );
    const old = { ...envelope, schemaVersion: 9, state: stripped } as unknown as typeof envelope;

    const restored = restore(old, world.content, registry);
    const state = restored.state;
    expect(state.schemaVersion).toBe(SCHEMA_VERSION);
    expect(state.social).toEqual({
      relationships: {},
      rivalries: {},
      sessions: {},
      captainsTableDay: -1,
    });
    expect(state.nextId.session).toBe(1);
    for (const actor of Object.values(state.actors)) {
      expect(actor.needs.recreation).toBe(0.3);
      expect(actor.interests).toEqual(interests);
      expect(actor.values).toEqual(values);
    }
    // The books came back on the shelf, as a fresh stack below the moved counter.
    const books = Object.values(state.items).filter((item) => item.defId === BOOK);
    expect(books.reduce((sum, i) => sum + (i.stacking === "stack" ? i.count : 0), 0)).toBe(3);
    for (const book of books) {
      if (book.location.kind !== "onDeck") throw new Error("book not on deck");
      expect({ x: Math.floor(book.location.x), y: Math.floor(book.location.y) }).toEqual({
        x: 4,
        y: 3,
      });
    }
    expect(state.nextId.item).toBe(envelope.state.nextId.item + 1);
    expect(restored.warnings.some((w) => /predates off watch/.test(w))).toBe(true);
    kernel.advance(restored, 20);
    expect(restored.state.tick).toBe(60);
  });

  it("migrates a schema-10 save to 11: affinities dropped for memories, chat times kept (D88)", () => {
    const raw = {
      social: {
        relationships: {
          a1: { a2: { affinity: 7, lastChatTick: 3 } },
          a2: { a1: { affinity: -2 } },
        },
      },
    };
    const migrate = migrations[10];
    if (migrate === undefined) throw new Error("no 10 → 11 migration");
    expect(migrate(raw, { content: tinyContent(tinyConfig()), config: tinyConfig() })).toEqual({
      social: {
        relationships: {
          a1: { a2: { memories: [], lastChatTick: 3 } },
          a2: { a1: { memories: [] } },
        },
      },
    });
  });

  it("migrates a schema-11 save to 12: a whole hull, no field, a retired asteroid belt a debris field, kits in the lockers (slice 5)", () => {
    const KIT = "item.tiny.patch_kit" as ItemDefId;
    // The tiny content with a locker the scenario stocks with two patch kits.
    const lockerContent = (): ContentBundle => {
      const base = tinyContent(tinyConfig());
      const deck = base.decks[TINY.deck];
      const scenario = base.scenarios[TINY.scenario];
      if (deck === undefined || scenario === undefined) throw new Error("tiny content");
      return {
        ...base,
        decks: {
          [TINY.deck]: {
            ...deck,
            zones: [
              ...deck.zones,
              { key: "locker_1", name: "Locker", tags: ["locker"], tiles: [{ x: 4, y: 3 }] },
            ],
          },
        },
        items: {
          ...base.items,
          [KIT]: {
            id: KIT,
            name: "Patch Kit",
            stacking: "stackable",
            maxStack: 10,
            tags: ["consumable", "patchKit"],
            toolKinds: [],
            mass: 2,
          },
        },
        scenarios: {
          [TINY.scenario]: {
            ...scenario,
            startingItems: [
              ...scenario.startingItems,
              { itemDefId: KIT, count: 2, zoneKey: "locker_1" },
            ],
          },
        },
      };
    };
    const registry = createRegistry();
    const kernel = createKernel(registry);
    const world = kernel.createWorld(TINY.scenario, 42, lockerContent(), tinyEffectiveConfig());
    kernel.advance(world, 40);
    const envelope = serialize(world);
    type Json = Record<string, unknown>;
    const at = (value: unknown, key: string) => (value as Json)[key] as Json;
    const strip = (value: Json, key: string) => {
      const { [key]: _gone, ...rest } = value;
      return rest;
    };
    // Schema 11's shape: no hull, no field or scar counters, a waiting asteroid belt, no kits.
    const raw = JSON.parse(JSON.stringify(envelope.state)) as Json;
    const stripped = strip(raw, "hull");
    stripped.schemaVersion = 11;
    stripped.nextId = { ...strip(strip(at(raw, "nextId"), "field"), "scar"), hazard: 2 };
    stripped.hazards = [{ id: "h1", kind: "asteroidBelt", difficulty: 4, fireAtTick: 900 }];
    stripped.items = Object.fromEntries(
      Object.entries(at(raw, "items")).filter(([, item]) => (item as Json).defId !== KIT),
    );
    const old = { ...envelope, schemaVersion: 11, state: stripped } as unknown as typeof envelope;

    const restored = restore(old, world.content, registry);
    const state = restored.state;
    expect(state.schemaVersion).toBe(SCHEMA_VERSION);
    expect(state.hull).toEqual({ integrity: 100, max: 100, scars: [] });
    expect(state.field).toBeUndefined();
    expect(state.alert).toBeUndefined();
    expect(state.nextId.field).toBe(1);
    expect(state.nextId.scar).toBe(1);
    expect(state.hazards).toEqual([
      { id: "h1", kind: "debrisField", difficulty: 4, fireAtTick: 900 },
    ]);
    const kits = Object.values(state.items).filter((item) => item.defId === KIT);
    expect(kits.reduce((sum, i) => sum + (i.stacking === "stack" ? i.count : 0), 0)).toBe(2);
    expect(restored.warnings.some((w) => /predates the asteroid field/.test(w))).toBe(true);
    kernel.advance(restored, 20);
    expect(restored.state.tick).toBe(60);
  });

  it("restores a schema-10 save's config with the memory table from content (D88)", () => {
    const { world, kernel, registry } = tinyTestWorld();
    kernel.advance(world, 20);
    const envelope = serialize(world);
    const raw = { ...envelope.state, schemaVersion: 10 };
    // Schema 10's config: the chat moved affinity itself, and there was no memory table.
    const {
      chatMemoryEveryDays: _every,
      chatSour: _sour,
      compatibility: _compatibility,
      memories: _memories,
      ...social
    } = envelope.config.social;
    const old = {
      ...envelope,
      schemaVersion: 10,
      state: raw,
      config: { ...envelope.config, social: { ...social, chatAffinity: 1 } },
    } as unknown as typeof envelope;
    const restored = restore(old, world.content, registry);
    expect(restored.state.schemaVersion).toBe(SCHEMA_VERSION);
    expect(restored.config.values.social.memories).toEqual(world.content.config.social.memories);
    expect(restored.config.values.social.compatibility).toEqual(
      world.content.config.social.compatibility,
    );
    kernel.advance(restored, 20);
    expect(restored.state.tick).toBe(40);
  });

  it("restores a save whose config has the pre-D76 seconds names: new names from content, old ones unread", () => {
    const { world, kernel, registry } = tinyTestWorld();
    const envelope = serialize(world);
    // A schema-7 save from before the day units: the same knobs under their seconds names.
    const { mealDays: _meal, ...needs } = envelope.config.needs;
    const { quietTooLongDays: _quiet, ...narrator } = envelope.config.narrator;
    const { daySeconds: _day, watchesPerDay: _watches, ...time } = envelope.config.time;
    const old = {
      ...envelope,
      config: {
        ...envelope.config,
        time,
        needs: { ...needs, mealSeconds: 10 },
        narrator: { ...narrator, quietTooLongSeconds: 600 },
      },
    } as unknown as typeof envelope;

    const restored = restore(old, world.content, registry);
    const values = restored.config.values;
    expect(values.needs.mealDays).toBe(world.content.config.needs.mealDays);
    expect(values.narrator.quietTooLongDays).toBe(world.content.config.narrator.quietTooLongDays);
    expect(values.time.daySeconds).toBe(world.content.config.time.daySeconds);
    expect(values.time.watchesPerDay).toBe(world.content.config.time.watchesPerDay);
    expect(restored.warnings.join("\n")).toMatch(
      /config\.needs\.mealDays.*config\.narrator\.quietTooLongDays/s,
    );
    // The world runs on: the quiet timer reads the filled key, not the stale one.
    kernel.advance(restored, 20);
    expect(restored.state.tick).toBe(world.state.tick + 20);
  });

  it("restores a save made with other content, with a warning", () => {
    const { world, registry } = tinyTestWorld();
    const envelope = serialize(world);
    const restored = restore(envelope, { ...tinyContent(), hash: "other" }, registry);
    expect(restored.state).toStrictEqual(world.state);
    expect(restored.warnings).toHaveLength(1);
    expect(restored.warnings[0]).toMatch(/content/);
    expect(restore(envelope, world.content, registry).warnings).toEqual([]);
  });

  it("rejects a corrupt state", () => {
    const { world, registry } = tinyTestWorld();
    const envelope = serialize(world);
    const broken = JSON.parse(JSON.stringify(envelope));
    broken.state.money.balance = -5;
    expect(() => restore(broken, world.content, registry)).toThrow(/money.balance/);
  });
});
