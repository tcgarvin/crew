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

  it("rejects a save from a newer schema, a gap, or other content", () => {
    const { world, registry } = tinyTestWorld();
    const envelope = serialize(world);
    expect(() =>
      restore({ ...envelope, schemaVersion: SCHEMA_VERSION + 1 }, world.content, registry),
    ).toThrow(/newer than this build supports/);
    expect(() => migrateState({}, SCHEMA_VERSION - 1, {})).toThrow(SaveCompatibilityError);
    expect(() => restore(envelope, { ...tinyContent(), hash: "other" }, registry)).toThrow(
      /content/,
    );
  });

  it("rejects a corrupt state", () => {
    const { world, registry } = tinyTestWorld();
    const envelope = serialize(world);
    const broken = JSON.parse(JSON.stringify(envelope));
    broken.state.money.balance = -5;
    expect(() => restore(broken, world.content, registry)).toThrow(/money.balance/);
  });
});
