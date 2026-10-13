/**
 * Breakdowns beyond the engine room, found and fixed on the real content (§authored-faults): each
 * new fault is drawn by wear far less often than a test can wait for, so each is injected into a
 * real-content world and the crew must diagnose and repair it with what the ship carries.
 */
import {
  type Command,
  type CommandId,
  type LocalKey,
  type MachineId,
  type World,
  createKernel,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import { createPacingRegistry, loadPacingContent } from "./pacing";

describe("the new faults: injected on the real content, found and fixed", () => {
  it.each([
    ["machine.life_support", "scrubber_clog"],
    ["machine.battery_bank", "cell_degradation"],
    ["machine.galley_stove", "burner_fault"],
    ["machine.nav_terminal", "chart_fault"],
  ])(
    "%s's %s is diagnosed and repaired within five sim-minutes",
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
          id: `cmd:breakdowns:${sent}` as CommandId,
        } as Command);
        if (result.status !== "accepted") throw new Error(JSON.stringify(result));
      };
      send({
        source: "scenario",
        kind: "scenarioInjectFault",
        payload: { machineId: machine.id as MachineId, faultKey: faultKey as LocalKey },
      });
      const seen: string[] = [];
      let advances = 0;
      const endTick = 5 * 60 * world.config.values.time.tickRate;
      while (world.state.tick < endTick && !seen.includes("faultRepaired")) {
        // Yield now and then so the worker's RPC is answered (`yielding.ts`).
        advances += 1;
        if (advances % 100 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        const result = kernel.advance(world, 20);
        for (const event of result.events) {
          const about = "machineId" in event.payload && event.payload.machineId === machine.id;
          const counted = ["faultOccurred", "faultDiagnosed", "faultRepaired"].includes(event.type);
          if (about && counted) seen.push(event.type);
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
      expect(seen).toEqual(["faultOccurred", "faultDiagnosed", "faultRepaired"]);
      const repaired = world.state.machines[machine.id];
      expect(repaired?.faults).toEqual([]);
      expect(repaired?.actualMode).toBe("on");
    },
    120_000,
  );
});
