import { describe, expect, it } from "vitest";
import { cmd, tinyTestWorld } from "./fixtures/test-world";
import { tinyContent } from "./fixtures/tiny-content";
import { SaveCompatibilityError, migrateState, restore, serialize } from "./save";
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
