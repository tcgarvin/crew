/**
 * The variety pack in play: the book club, gossip, the new debate and gossip topics, the new
 * thoughts and the new faults, on the real content (§activities-and-interests, §thoughts,
 * §faults-and-symptoms). A ship's day of each pacing voyage shows the off-watch content; the
 * faults are drawn by wear far less often than that, so each is injected into a real-content
 * world and the crew must find and fix it with what the ship carries.
 */
import {
  type Command,
  type CommandId,
  type LocalKey,
  type MachineId,
  type SimEvent,
  type World,
  createKernel,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import { runBeatsAsync } from "./beats";
import { type PacingScenario, createPacingRegistry, loadPacingContent } from "./pacing";

/** How often each key turned up in a run, by what it is known as. */
type Tally = Map<string, number>;

const bump = (tally: Tally, key: string): void => {
  tally.set(key, (tally.get(key) ?? 0) + 1);
};

/** One ship's day of a pacing voyage, tallied by activity, topic and thought. */
async function dayOf(scenario: PacingScenario): Promise<Tally> {
  const tally: Tally = new Map();
  const observe = (events: readonly SimEvent[]): void => {
    for (const event of events) {
      if (event.type === "sessionStarted") bump(tally, event.payload.activityId);
      if (event.type === "sessionEnded" && event.payload.topicId !== undefined) {
        bump(tally, event.payload.topicId);
      }
      if (event.type === "thoughtAdded") bump(tally, event.payload.key);
    }
  };
  await runBeatsAsync({ scenario, days: 1, seed: 1, fields: "none", observe });
  return tally;
}

describe("the variety pack off watch: a ship's day of each pacing voyage, seed 1", () => {
  let days: Promise<Tally[]> | undefined;
  const count = async (key: string): Promise<number> => {
    days ??= Promise.all([dayOf("plain"), dayOf("freight")]);
    return (await days).reduce((sum, tally) => sum + (tally.get(key) ?? 0), 0);
  };

  it("a book club and a round of gossip start", async () => {
    expect(await count("activity.book_club")).toBeGreaterThan(0);
    expect(await count("activity.gossip")).toBeGreaterThan(0);
  }, 300_000);

  it("a new topic comes up", async () => {
    const topics = ["topic.salvage_rights", "topic.ghost_ships", "topic.sweethearts"];
    const counts = await Promise.all(topics.map(count));
    expect(counts.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  }, 300_000);

  it("the cook, a repairer and a host nobody joined have the new thoughts", async () => {
    for (const key of ["cookedWell", "fixedIt", "nobodyJoinedIn"]) {
      expect(await count(key), key).toBeGreaterThan(0);
    }
  }, 300_000);
});

describe("the variety pack's faults: injected on the real content, found and fixed", () => {
  it.each([
    ["machine.engine", "fouled_injector"],
    ["machine.coolant_pump", "air_locked_line"],
  ])(
    "%s's %s derates it, and the crew diagnose and repair it within five sim-minutes",
    async (defId, faultKey) => {
      const { bundle, config, scenarioId } = loadPacingContent();
      const kernel = createKernel(createPacingRegistry());
      const world: World = kernel.createWorld(scenarioId, 1, bundle, config);
      const machine = Object.values(world.state.machines).find((m) => m.defId === defId);
      if (machine === undefined) throw new Error(`no ${defId} aboard`);
      let sent = 0;
      const send = (command: Omit<Command, "id">): void => {
        sent += 1;
        const result = kernel.enqueueCommand(world, {
          ...command,
          id: `cmd:variety:${sent}` as CommandId,
        } as Command);
        if (result.status !== "accepted") throw new Error(JSON.stringify(result));
      };
      send({
        source: "scenario",
        kind: "scenarioInjectFault",
        payload: { machineId: machine.id as MachineId, faultKey: faultKey as LocalKey },
      });
      const seen = new Set<string>();
      let advances = 0;
      const endTick = 5 * 60 * world.config.values.time.tickRate;
      while (world.state.tick < endTick && !seen.has("faultRepaired")) {
        // Yield now and then so the worker's RPC is answered (`yielding.ts`).
        advances += 1;
        if (advances % 100 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        const result = kernel.advance(world, 20);
        for (const event of result.events) {
          if ("machineId" in event.payload && event.payload.machineId === machine.id) {
            seen.add(event.type);
          }
        }
        if (result.halt.kind === "hook") {
          const hook = world.state.narrator.pendingHook;
          if (hook === undefined) throw new Error("hook halt without a pending hook");
          send({ source: "system", kind: "acknowledgeHook", payload: { hookId: hook.id } });
        } else if (result.halt.kind === "decision") {
          const head = world.state.decisions.queue[0];
          if (head === undefined) throw new Error("decision halt without a queued decision");
          send({
            source: "player",
            kind: "resolveDecision",
            payload: { decisionId: head, side: "left" },
          });
        }
      }
      expect([...seen]).toEqual([
        "faultOccurred",
        "machineDerated",
        "faultDiagnosed",
        "faultRepaired",
      ]);
      expect(world.state.machines[machine.id]?.faults).toEqual([]);
      const fixers = Object.values(world.state.actors).filter((a) =>
        a.thoughts.some((t) => t.key === "fixedIt"),
      );
      expect(fixers).toHaveLength(1);
    },
    120_000,
  );
});
