/**
 * §machines-in-the-blast: what a rock does to a machine (slice 5 call 7). The effect table's
 * weights are the shares a thousand rolls come out at. A graze takes 0.2 of integrity and a damage
 * 0.5 (derated, still running); a knockout takes it all, so one hit takes a whole machine out
 * (`machineKnockedOut`); a fault is one of the machine's own through the fault path, and a machine
 * with none takes damage instead. Until damage response lands (W2) a hit raises no problem: the
 * stub only lowers integrity.
 */
import { describe, expect, it } from "vitest";
import { createRngApi } from "../../core/rng";
import { MACHINE_EFFECTS, type MachineEffect } from "../../core/types/content";
import type { MachineId } from "../../core/types/ids";
import { rollEffect } from "./effects";
import {
  FIELD,
  engineOf,
  fieldWorld,
  fieldWorldViolations,
  ofType,
  runUntil,
  scheduleField,
  underWay,
} from "./fixtures/field-deck";

/** A world under way with one scripted hit on `machine` with `effect`, landed; its events. */
function hitWith(machine: "engine" | "helm", effect: MachineEffect) {
  const test = fieldWorld();
  underWay(test);
  const target =
    machine === "engine"
      ? engineOf(test.world)
      : Object.values(test.world.state.machines).find((m) => m.defId === FIELD.helm);
  if (target === undefined) throw new Error(`no ${machine}`);
  const field = scheduleField(test, {
    severity: "light",
    detection: "rolled",
    windowTicks: [0, 0],
    scripted: [
      { atSeconds: 0, target: { kind: "machine", machineId: target.id }, rock: "small", effect },
    ],
  });
  const events = runUntil(test, 30, () => field.scripted[0]?.firedTick !== undefined);
  const impact = ofType(events, "asteroidImpact").find((e) => e.payload.scripted);
  return { test, machine: target, events, impact };
}

const hitOn = (
  impact: ReturnType<typeof hitWith>["impact"],
  machineId: MachineId,
): MachineEffect | undefined => impact?.payload.hits.find((h) => h.machineId === machineId)?.effect;

describe("machine effects (§machines-in-the-blast, call 7)", { timeout: 30_000 }, () => {
  it("rolls the effect table at its weights over a thousand rolls", () => {
    const { world } = fieldWorld({ seed: 3 });
    const rng = createRngApi(world.state);
    const weights = world.config.values.field.machineEffects;
    const total = MACHINE_EFFECTS.reduce((sum, effect) => sum + weights[effect], 0);
    const counts = new Map<MachineEffect, number>();
    for (let i = 0; i < 1000; i++) {
      const effect = rollEffect(rng, weights);
      counts.set(effect, (counts.get(effect) ?? 0) + 1);
    }
    for (const effect of MACHINE_EFFECTS) {
      expect(Math.abs((counts.get(effect) ?? 0) / 1000 - weights[effect] / total)).toBeLessThan(
        0.04,
      );
    }
  });

  it("grazes for 0.2 and damages for 0.5: derated, not out", () => {
    const graze = hitWith("engine", "graze");
    expect(graze.machine.integrity).toBeCloseTo(0.8, 10);
    expect(hitOn(graze.impact, graze.machine.id)).toBe("graze");
    const damage = hitWith("engine", "damage");
    expect(damage.machine.integrity).toBeCloseTo(0.5, 10);
    expect(ofType(damage.events, "machineKnockedOut")).toEqual([]);
  });

  it("knocks a whole machine out in one hit", () => {
    const { machine, events, impact, test } = hitWith("helm", "knockout");
    expect(machine.integrity).toBe(0);
    expect(hitOn(impact, machine.id)).toBe("knockout");
    expect(ofType(events, "machineKnockedOut").map((e) => e.payload.machineId)).toEqual([
      machine.id,
    ]);
    // Until W2, a hit raises no problem of its own.
    expect(fieldWorldViolations(test.world)).toEqual([]);
  });

  it("faults a machine with one of its own faults, through the fault path", () => {
    const { machine, events, impact } = hitWith("engine", "fault");
    expect(hitOn(impact, machine.id)).toBe("fault");
    const faults = ofType(events, "faultOccurred").filter(
      (e) => e.payload.machineId === machine.id,
    );
    expect(faults).toHaveLength(1);
    expect(["wornBearing", "hotPanel"]).toContain(faults[0]?.payload.faultKey);
    expect(machine.faults.map((f) => f.faultKey)).toEqual([faults[0]?.payload.faultKey]);
    expect(machine.integrity).toBe(1);
  });

  it("damages a machine with no fault to take instead", () => {
    const { machine, events, impact } = hitWith("helm", "fault");
    expect(hitOn(impact, machine.id)).toBe("damage");
    expect(machine.integrity).toBeCloseTo(0.5, 10);
    expect(ofType(events, "faultOccurred")).toEqual([]);
  });
});
