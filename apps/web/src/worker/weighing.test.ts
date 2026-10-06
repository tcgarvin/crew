import { type ActorId, URGENCY_CLASSES, createKernel } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { loadWebContent } from "./content";
import { createFullRegistry } from "./registry";
import { weighAgent } from "./weighing";

function game(seed: number) {
  const { bundle, config, scenarioId } = loadWebContent();
  const kernel = createKernel(createFullRegistry());
  const world = kernel.createWorld(scenarioId, seed, bundle, config);
  const words = (actorId: ActorId) =>
    weighAgent(kernel.getAgentView(world, actorId), world, bundle);
  return { kernel, world, words };
}

const RAW_ID = /\b(task|actor|machine|item|problem):|\b[tpmia]\d+\b|undefined/;

describe("weighingWords (D90)", () => {
  it("words every crew member's options and rejections, best first, at most one next", () => {
    const { kernel, world, words } = game(7);
    // Into the first watch, past the first meal call, so there is work and leisure to weigh.
    kernel.advance(world, 300 * world.config.values.time.tickRate);
    for (const actor of Object.values(world.state.actors)) {
      if (!actor.crew || actor.availability !== "available") continue;
      const weighing = words(actor.id);
      expect(structuredClone(weighing)).toEqual(weighing);
      expect(weighing.verdict).not.toBe("");
      const ranks = weighing.options.map((o) => URGENCY_CLASSES.indexOf(o.urgency));
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      expect(weighing.options.filter((o) => o.mark === "next").length).toBeLessThanOrEqual(1);
      for (const line of [
        ...weighing.options.map((o) => o.text),
        ...weighing.ruledOut.flatMap((r) => [r.text, r.reason]),
      ]) {
        expect(line, actor.name).not.toMatch(RAW_ID);
      }
    }
  });

  it("names worn-out machines' servicing among the engineers' options, or says why it is out", () => {
    const { kernel, world, words } = game(7);
    kernel.advance(world, world.config.values.time.tickRate);
    const pump = Object.values(world.state.machines).find(
      (m) => m.defId === "machine.coolant_pump",
    );
    if (pump === undefined) throw new Error("no coolant pump");
    pump.condition = 0.2;
    kernel.advance(world, 2 * world.config.values.time.tickRate);
    const priya = Object.values(world.state.actors).find((a) => a.name === "Priya Kessler");
    if (priya === undefined) throw new Error("no Priya");
    const weighing = words(priya.id);
    const lines = [
      ...weighing.options.map((o) => o.text),
      ...weighing.ruledOut.map((r) => `${r.text}: ${r.reason}`),
    ];
    expect(lines.some((l) => l.startsWith("servicing the coolant pump"))).toBe(true);
  });
});
