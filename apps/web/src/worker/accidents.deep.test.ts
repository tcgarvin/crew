/**
 * §accidents-aboard on the real content and the full registry, with every accident chance fifty
 * times the authored one (a throw is then certain): a sim-day of the Mk2 from the hub, across a
 * heavy asteroid field on the leg to Kessler Drift, hurts someone and kills nobody, and every wound
 * an accident makes is treated at the medbay bed while kits last. Hooks are acknowledged and cards
 * answered by their left side as they come.
 */
import type { Command, CommandId, ConfigDef, PortDefId, SimEvent, World } from "@crew/sim";
import { createKernel } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { loadWebContent } from "./content";
import { createFullRegistry } from "./registry";
import { assertInvariants } from "./testGame";

const KESSLER = "port.kessler_drift" as PortDefId;

function kitsAboard(world: World): number {
  return Object.values(world.state.items)
    .filter((item) => item.defId === "item.med_kit" && item.location.kind !== "inExternalStore")
    .reduce((n, item) => n + (item.stacking === "stack" ? item.count : 1), 0);
}

function harsher(values: ConfigDef): ConfigDef {
  const a = values.accidents;
  return {
    ...values,
    accidents: {
      ...a,
      hotWorkPerSecond: Math.min(1, a.hotWorkPerSecond * 50),
      slipPerSecond: Math.min(1, a.slipPerSecond * 50),
      impactThrowChance: Math.min(1, a.impactThrowChance * 50),
    },
  };
}

describe("accidents aboard (§accidents-aboard)", () => {
  it("hurt someone on an ordinary voyage, and their wounds are treated at the bed", () => {
    const { bundle, config, scenarioId } = loadWebContent();
    const kernel = createKernel(createFullRegistry());
    const world = kernel.createWorld(scenarioId, 777, bundle, {
      ...config,
      values: harsher(config.values),
    });
    const tickRate = world.config.values.time.tickRate;
    let n = 0;
    const send = (command: Omit<Command, "id">) => {
      n += 1;
      const result = kernel.enqueueCommand(world, {
        ...command,
        id: `cmd:acc:${n}` as CommandId,
      } as Command);
      if (result.status !== "accepted") {
        throw new Error(`${command.kind} rejected: ${JSON.stringify(result)}`);
      }
    };
    const events: SimEvent[] = [];
    let courseSet = false;
    let fieldSent = false;
    const day = world.config.values.time.daySeconds * tickRate;
    const kitsPerTreatment = world.config.values.medical.kitsPerTreatment;
    const untreated = () =>
      Object.values(world.state.actors).flatMap((actor) =>
        actor.body.wounds.filter((w) => w.type !== "stun" && w.treatedTick === undefined),
      );
    // A day, then up to five minutes more for the last wounds to reach the bed.
    const settled = () => untreated().length === 0 || kitsAboard(world) < kitsPerTreatment;
    while (world.state.tick < day || (world.state.tick < day + 300 * tickRate && !settled())) {
      const result = kernel.advance(world, 20);
      events.push(...result.events);
      assertInvariants(world);
      // As a player would: set course once the captain's ask at the hub is answered, and the
      // narrator puts a heavy field on the leg.
      const narrator = world.state.narrator;
      if (!courseSet && narrator.captainAshoreLastAsk !== undefined && !narrator.pendingHook) {
        courseSet = true;
        send({ source: "scenario", kind: "setCourse", payload: { destinationPortId: KESSLER } });
      } else if (courseSet && !fieldSent && world.state.travel.stage !== "docked") {
        fieldSent = true;
        send({
          source: "narrator",
          kind: "scheduleField",
          payload: { severity: "heavy", detection: "rolled", windowTicks: [0, 0], scripted: [] },
        });
      }
      const hook = world.state.narrator.pendingHook;
      if (result.halt.kind === "hook" && hook !== undefined) {
        send({ source: "system", kind: "acknowledgeHook", payload: { hookId: hook.id } });
      }
      const head = world.state.decisions.queue[0];
      if (result.halt.kind === "decision" && head !== undefined) {
        send({
          source: "player",
          kind: "resolveDecision",
          payload: { decisionId: head, side: "left" },
        });
      }
    }

    const accidents = events.filter(
      (e): e is Extract<SimEvent, { type: "accident" }> => e.type === "accident",
    );
    expect(accidents.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "died")).toBe(false);
    const treated = events.filter((e) => e.type === "woundTreated");
    expect(treated.length).toBeGreaterThan(0);
    // Every wound still open is treated, unless the ship is out of kits.
    if (kitsAboard(world) >= kitsPerTreatment) expect(untreated()).toEqual([]);
  }, 600_000);
});
