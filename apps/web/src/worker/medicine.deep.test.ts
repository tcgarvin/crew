/**
 * §medicine on the real content and the full registry: a crew member shot in the leg aboard (the
 * narrator's `strike`) walks to the medbay bed, someone with the skill fetches a med kit from the
 * hold and treats the wound there, and the ship has one kit fewer. Hooks are acknowledged and cards
 * answered by their left side as they come.
 */
import type { Command, CommandId, SimEvent, World } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { assertInvariants, newGame } from "./testGame";

function kitsAboard(world: World): number {
  return Object.values(world.state.items)
    .filter((item) => item.defId === "item.med_kit" && item.location.kind !== "inExternalStore")
    .reduce((n, item) => n + (item.stacking === "stack" ? item.count : 1), 0);
}

describe("medicine aboard (§medicine)", () => {
  it("a crew member wounded aboard is treated at the medbay bed within minutes, with one kit", () => {
    const { kernel, world } = newGame(4242);
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
});
