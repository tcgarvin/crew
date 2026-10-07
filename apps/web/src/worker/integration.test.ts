/**
 * Worker wiring smoke test: the registry `sim.worker.ts` builds (`createFullRegistry`) plus the
 * real authored bundle. Covers what the inspector needs — an `AgentView` for a crew member, and
 * its structured-clone-safe snapshot — which Integration 1 could not provide.
 */
import type { ActorId, Command, CommandId, SimEvent } from "@crew/sim";
import { checkInvariants, createKernel, toAgentViewSnapshot, watchTicks } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { personWords } from "../ui/actorWords";
import { loadWebContent } from "./content";
import { createFullRegistry } from "./registry";

describe("worker registry + real content", () => {
  it("builds a world, advances it, and serves the inspector's AgentView", () => {
    const { bundle, config, scenarioId } = loadWebContent();
    const kernel = createKernel(createFullRegistry());
    const world = kernel.createWorld(scenarioId, 12345, bundle, config);
    const actorIds = Object.keys(world.state.actors) as ActorId[];
    expect(actorIds.length).toBe(9);

    // Initial needs come from `config.needs.initialRange`, so nobody starts at zero hunger.
    const range = config.values.needs.initialRange.hunger;
    for (const id of actorIds) {
      const hunger = world.state.actors[id]?.needs.hunger ?? -1;
      expect(hunger).toBeGreaterThanOrEqual(range.min);
      expect(hunger).toBeLessThanOrEqual(range.max);
    }

    kernel.advance(world, 1);
    expect(checkInvariants(world.state)).toEqual([]);

    const first = actorIds[0] as ActorId;
    const view = kernel.getAgentView(world, first);
    const snapshot = toAgentViewSnapshot(view);
    expect(snapshot.self.id).toBe(first);
    expect(structuredClone(snapshot)).toEqual(snapshot);

    // D92/D93: the frame the canvas and the top bar read: a whole hull, no alert, no rocks.
    const frame = kernel.getRenderFrame(world);
    expect(frame.hull).toEqual({ integrity: 100, max: 100, scars: [], lost: false });
    expect(frame.alert).toBe(false);
    expect(frame.field).toBeUndefined();
    expect(frame.impacts).toEqual([]);
  });

  it("registers the watch: the inspector reads each person's section, and the bell rings at the end of the watch (D77)", () => {
    const { bundle, config, scenarioId } = loadWebContent();
    const kernel = createKernel(createFullRegistry());
    const world = kernel.createWorld(scenarioId, 12345, bundle, config);
    kernel.advance(world, 1);

    const byName = (name: string) => {
      const actor = Object.values(world.state.actors).find((a) => a.name === name);
      if (actor === undefined) throw new Error(`no ${name}`);
      const view = toAgentViewSnapshot(kernel.getAgentView(world, actor.id));
      return personWords(view, bundle.thoughts, config.values.mood);
    };
    // The authored bill: Noor in Red (the first watch), Jax in White, Bettina a dayworker.
    expect(byName("Noor Haddad").watch).toBe("Red section, on watch");
    expect(byName("Jax Okonkwo").watch).toBe("White section, off watch");
    expect(byName("Bettina Solheim").watch).toBe("Dayworker, on duty");
    expect(byName("Noor Haddad").mood).toBe("steady");

    // Run to the first bell, answering hooks at once and cards by their left side.
    const bells: SimEvent[] = [];
    let n = 0;
    const send = (command: Omit<Command, "id">) => {
      n += 1;
      kernel.enqueueCommand(world, { ...command, id: `cmd:int:${n}` as CommandId } as Command);
    };
    const end = watchTicks(config.values);
    while (world.state.tick < end) {
      const result = kernel.advance(world, Math.min(50, end - world.state.tick));
      bells.push(...result.events.filter((e) => e.type === "bell"));
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
    expect(bells.map((e) => [e.tick, e.type === "bell" ? e.payload.sectionKey : ""])).toEqual([
      [end, "white"],
    ]);
    expect(byName("Jax Okonkwo").watch).toBe("White section, on watch");
    expect(byName("Noor Haddad").watch).toBe("Red section, off watch");
    // A watch of the whole ship on real content: seconds alone, more under the parallel suite.
  }, 30_000);
});
