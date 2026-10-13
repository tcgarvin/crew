/**
 * §medicine on the real content and the full registry: a crew member shot in the leg aboard (the
 * narrator's `strike`) walks to the medbay bed, someone with the skill fetches a med kit from the
 * hold and treats the wound there, and the ship has one kit fewer; and (§extraction) a crew member
 * downed aboard by a grave wound to each leg is carried to the bed by a crewmate and treated there.
 * Hooks are acknowledged and cards answered by their left side as they come.
 */
import type { Command, CommandId, SimEvent, World } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { assertInvariants, newGame } from "./testGame";

function kitsAboard(world: World): number {
  return Object.values(world.state.items)
    .filter((item) => item.defId === "item.med_kit" && item.location.kind !== "inExternalStore")
    .reduce((n, item) => n + (item.stacking === "stack" ? item.count : 1), 0);
}

/** A new game, hooks acknowledged and cards answered left as they come, and its events. */
function harness(seed: number) {
  const { kernel, world } = newGame(seed);
  let n = 0;
  const send = (command: Omit<Command, "id">) => {
    n += 1;
    kernel.enqueueCommand(world, { ...command, id: `cmd:med:${n}` as CommandId } as Command);
  };
  const events: SimEvent[] = [];
  const step = (ticks: number) => {
    const result = kernel.advance(world, ticks);
    events.push(...result.events);
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
  };
  // A minute for the crew to settle in and look round (the brief tells them where the kits are).
  const tickRate = world.config.values.time.tickRate;
  while (world.state.tick < 60 * tickRate) step(20);
  return { world, send, step, events, tickRate };
}

describe("medicine aboard (§medicine)", () => {
  it("a crew member wounded aboard is treated at the medbay bed within minutes, with one kit", () => {
    const { world, send, step, events, tickRate } = harness(4242);
    const priya = Object.values(world.state.actors).find((a) => a.name === "Priya Kessler");
    if (priya === undefined) throw new Error("no Priya Kessler aboard");
    const kits = kitsAboard(world);
    expect(kits).toBeGreaterThan(0);

    send({
      source: "narrator",
      kind: "strike",
      payload: {
        actorId: priya.id,
        severity: "serious",
        type: "blaster",
        part: "leftLeg",
        how: "a stray shot from the dock clips Priya Kessler's leg",
      },
    });
    const struckAt = world.state.tick;
    const limit = struckAt + 5 * 60 * tickRate;
    while (world.state.tick < limit && !events.some((e) => e.type === "woundTreated")) {
      step(10);
      assertInvariants(world);
    }

    const treated = events.find(
      (e): e is Extract<SimEvent, { type: "woundTreated" }> => e.type === "woundTreated",
    );
    expect(treated?.payload.actorId).toBe(priya.id);
    expect(treated?.payload.byActorId).not.toBe(priya.id);
    const wound = world.state.actors[priya.id]?.body.wounds.find((w) => w.part === "leftLeg");
    expect(wound?.treatedTick).toBeDefined();
    expect(wound?.bleeding).toBe(false);
    expect(kitsAboard(world)).toBe(kits - 1);
    // Treated inside the bleed's own minute or a few after it: walking time, not hours.
    expect((world.state.tick - struckAt) / tickRate).toBeLessThan(5 * 60);
  }, 120_000);

  it("a crew member downed aboard is carried to the medbay bed and treated there (§extraction)", () => {
    const { world, send, step, events, tickRate } = harness(4242);
    const priya = Object.values(world.state.actors).find((a) => a.name === "Priya Kessler");
    if (priya === undefined) throw new Error("no Priya Kessler aboard");
    // A fall down a ladder: both legs broken, a grave wound to each, and she cannot move.
    for (const part of ["leftLeg", "rightLeg"] as const) {
      send({
        source: "narrator",
        kind: "strike",
        payload: {
          actorId: priya.id,
          severity: "grave",
          type: "blunt",
          part,
          how: "Priya Kessler falls down the ladder",
        },
      });
    }
    const struckAt = world.state.tick;
    step(1);
    expect(world.state.actors[priya.id]?.availability).toBe("incapacitated");
    const treated = () => events.some((e) => e.type === "woundTreated");
    while (world.state.tick < struckAt + 5 * 60 * tickRate && !treated()) {
      step(10);
      assertInvariants(world);
    }

    const carried = events.find(
      (e): e is Extract<SimEvent, { type: "casualtyCarried" }> => e.type === "casualtyCarried",
    );
    expect(carried?.payload.actorId).toBe(priya.id);
    expect(carried?.payload.byActorId).not.toBe(priya.id);
    const treatment = events.find(
      (e): e is Extract<SimEvent, { type: "woundTreated" }> => e.type === "woundTreated",
    );
    expect(treatment?.payload.actorId).toBe(priya.id);
    expect(treatment?.payload.woundIds).toHaveLength(2);
    expect(world.state.actors[priya.id]?.availability).toBe("incapacitated");
    expect((world.state.tick - struckAt) / tickRate).toBeLessThan(5 * 60);
  }, 120_000);
});
