/**
 * Integration 2 regression: with a host that resolves every decision the moment it surfaces, the
 * job source used to surface a fresh offer every tick (and, on accept, spawn a fresh manifest
 * every tick). One offer at a time, a cooldown after a decline, and a quiet board after an accept.
 */
import { describe, expect, it } from "vitest";
import type { Command } from "../../core/types/commands";
import type { CommandId } from "../../core/types/ids";
import type { Kernel, World } from "../../core/types/kernel";
import { freightTestWorld } from "../travel/fixtures";

const FIVE_MINUTES = 20 * 300;

interface Tally {
  decisions: number;
  accepted: number;
  maxPendingJobDecisions: number;
}

/** Drive `ticks`, acknowledging hooks and resolving every decision on `side` as it surfaces. */
function runWithPolicy(kernel: Kernel, world: World, ticks: number, side: "left" | "right") {
  const tally: Tally = { decisions: 0, accepted: 0, maxPendingJobDecisions: 0 };
  let n = 0;
  const send = (command: Omit<Command, "id">) => {
    n += 1;
    const result = kernel.enqueueCommand(world, {
      ...command,
      id: `cmd:policy:${n}` as CommandId,
    } as Command);
    expect(result.status).toBe("accepted");
  };
  while (world.state.tick < ticks) {
    const result = kernel.advance(world, ticks - world.state.tick);
    tally.accepted += result.events.filter((e) => e.type === "jobAccepted").length;
    const pendingJobDecisions = world.state.decisions.queue.filter(
      (id) => world.state.decisions.records[id]?.jobId !== undefined,
    ).length;
    tally.maxPendingJobDecisions = Math.max(tally.maxPendingJobDecisions, pendingJobDecisions);
    if (result.halt.kind === "hook") {
      const hook = world.state.narrator.pendingHook;
      if (hook === undefined) throw new Error("hook halt without a pending hook");
      send({ source: "system", kind: "acknowledgeHook", payload: { hookId: hook.id } });
    } else if (result.halt.kind === "decision") {
      const head = world.state.decisions.queue[0];
      if (head === undefined) throw new Error("decision halt without a queued decision");
      tally.decisions += 1;
      send({ source: "player", kind: "resolveDecision", payload: { decisionId: head, side } });
    } else if (result.ticksAdvanced === 0) {
      break;
    }
  }
  return tally;
}

describe("commerce: job board with an auto-resolving host", () => {
  it("auto-accept: at most one offer at a time and a quiet board after accepting", () => {
    // No crew haul in this fixture (no work system), so the freight never loads and the ship
    // stays docked with its course planned for the whole run.
    const { world, kernel } = freightTestWorld();
    const tally = runWithPolicy(kernel, world, FIVE_MINUTES, "left");
    expect(tally.accepted).toBeGreaterThanOrEqual(1);
    expect(tally.accepted).toBeLessThanOrEqual(2);
    expect(tally.decisions).toBeLessThanOrEqual(3);
    expect(tally.maxPendingJobDecisions).toBeLessThanOrEqual(1);
    expect(world.state.travel.stage).toBe("docked");
    const items = Object.keys(world.state.items).length;
    kernel.advance(world, 200);
    expect(Object.keys(world.state.items).length).toBe(items);
  });

  it("auto-decline: re-offers no sooner than reofferSeconds", () => {
    const { world, kernel } = freightTestWorld();
    const tally = runWithPolicy(kernel, world, FIVE_MINUTES, "right");
    const reofferSeconds = world.config.values.commerce.reofferSeconds;
    expect(tally.accepted).toBe(0);
    expect(tally.decisions).toBeGreaterThanOrEqual(2);
    expect(tally.decisions).toBeLessThanOrEqual(Math.ceil(300 / reofferSeconds) + 1);
    const offeredTicks = Object.values(world.state.jobs)
      .map((j) => j.offeredTick)
      .sort((a, b) => a - b);
    for (let i = 1; i < offeredTicks.length; i++) {
      const gap = (offeredTicks[i] ?? 0) - (offeredTicks[i - 1] ?? 0);
      expect(gap).toBeGreaterThanOrEqual(reofferSeconds * 20);
    }
  });
});
