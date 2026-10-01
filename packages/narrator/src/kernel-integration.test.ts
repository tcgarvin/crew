/**
 * A narrow end-to-end check that the two commands this task added handlers for really do round
 * trip: `translateIntents` builds them from a plan, and the real kernel (with commerce
 * registered, D6's owner for `spawnAtBoundary`) accepts them, not just a mocked snapshot.
 */
import { createKernel, createRegistry, registerCommerce } from "@crew/sim";
import { describe, expect, it } from "vitest";
import type { NarratorPlan, TranslationCtx } from "./contract";
import { FIXTURE_SCENARIO } from "./fixtures";
import { content, emptyPlan } from "./test-support";
import { translateIntents } from "./translate";

describe("translateIntents -> kernel.enqueueCommand (real world)", () => {
  it("accepts a translated spawnAtBoundary and surfaceDecision", () => {
    const bundle = content();
    const registry = createRegistry();
    registerCommerce(registry);
    const kernel = createKernel(registry);
    const world = kernel.createWorld(FIXTURE_SCENARIO, 7, bundle, {
      values: bundle.config,
      hash: bundle.hash,
    });

    const ctx: TranslationCtx = {
      snapshot: kernel.serialize(world),
      content: bundle,
      hookTick: world.state.tick,
      callId: "call-real-world",
    };

    const plan: NarratorPlan = emptyPlan({
      intents: [
        {
          kind: "spawnAtBoundary",
          port: "port.kessler_drift",
          store: "warehouse",
          cargoItem: "item.crate_general",
          quantity: "few",
        },
        {
          kind: "surfaceDecision",
          title: "A quiet moment",
          speaker: null,
          situation: "Nothing much is happening, but someone should decide something.",
          left: { label: "Carry on", effect: "none", coursePort: null },
          right: { label: "Take a break", effect: "none", coursePort: null },
          leftAftermath: "Everyone goes back to what they were doing.",
          rightAftermath: "The crew down tools for a cup of something hot.",
        },
      ] as unknown as NarratorPlan["intents"],
    });

    const { commands, dropped } = translateIntents(plan, ctx);
    expect(dropped).toEqual([]);
    expect(commands.map((c) => c.kind)).toEqual(["spawnAtBoundary", "surfaceDecision"]);

    for (const command of commands) {
      const result = kernel.enqueueCommand(world, command);
      expect(result.status).toBe("accepted");
    }
  });
});
