/**
 * D40, D46: the narrator is the only source of work. The sim never offers a job on its own; the
 * `jobBoard` hook is the captain looking for work, raised when nothing is on and raised again,
 * not more often than `commerce.reofferSeconds`, while the captain stays idle at that port, and
 * not within that cooldown of a declined or expired offer there.
 */
import { describe, expect, it } from "vitest";
import { configTicks } from "../../core/clock";
import type { Command } from "../../core/types/commands";
import type { CommandId, HookId, JobId } from "../../core/types/ids";
import type { Kernel, World } from "../../core/types/kernel";
import { FIX, PORTS, advanceThroughHooks, freightTestWorld } from "../travel/fixtures";

let counter = 0;
function cmd<C extends Omit<Command, "id">>(command: C): C & { id: CommandId } {
  counter += 1;
  return { ...command, id: `cmd:job-board-test:${counter}` as CommandId };
}

function jobDraft() {
  return {
    issuer: "Test Shipper",
    description: { key: "test.job", params: {} },
    fromPortId: PORTS.a,
    toPortId: PORTS.b,
    cargo: [{ itemDefId: FIX.crate, count: 2 }],
    pay: 100,
  };
}

function acknowledgePendingHook(kernel: Kernel, world: World): void {
  const hookId = world.state.narrator.pendingHook?.id as HookId | undefined;
  if (hookId === undefined) throw new Error("no pending hook");
  kernel.enqueueCommand(
    world,
    cmd({ source: "system", kind: "acknowledgeHook", payload: { hookId } }),
  );
}

/** Make the board eligible again without waiting out the cooldown (a fixture nudge). */
function forgetThisDockingsAsk(world: World): void {
  // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
  delete world.state.narrator.jobBoardLastAsk;
}

function reofferTicks(world: World): number {
  return configTicks(world.config.values, world.config.values.commerce.reofferSeconds);
}

/** A fresh world past its first-tick `jobBoard` ask. */
function dockedWorldAfterFirstAsk() {
  const fixture = freightTestWorld();
  const first = fixture.kernel.advance(fixture.world, 1);
  expect(first.halt).toEqual({ kind: "hook" });
  expect(fixture.world.state.narrator.pendingHook?.kind).toBe("jobBoard");
  acknowledgePendingHook(fixture.kernel, fixture.world);
  return fixture;
}

describe("commerce: the sim never offers work on its own (D40)", () => {
  it("stays docked for a long while with an empty job table and no offer command", () => {
    const { world, kernel } = freightTestWorld();
    const result = advanceThroughHooks(kernel, world, 5_000);
    expect(result.halt).toEqual({ kind: "completed" });
    expect(world.state.travel.stage).toBe("docked");
    expect(world.state.jobs).toEqual({});
    expect(world.state.decisions.queue).toEqual([]);
    expect(world.state.commands.queue.filter((c) => c.kind === "offerJob")).toEqual([]);
  });
});

describe("commerce: jobBoard is the ask (D40)", () => {
  it("raises jobBoard on the first docked tick, with the port, and not again within the cooldown", () => {
    const { world, kernel } = freightTestWorld();
    const first = kernel.advance(world, 1);
    expect(first.halt).toEqual({ kind: "hook" });
    expect(world.state.narrator.pendingHook).toMatchObject({
      kind: "jobBoard",
      context: { portId: PORTS.a },
    });
    expect(world.state.narrator.jobBoardLastAsk).toEqual({ portId: PORTS.a, tick: 1 });
    acknowledgePendingHook(kernel, world);
    const cooldownTicks = reofferTicks(world);
    expect(cooldownTicks).toBeGreaterThan(100);
    const during = kernel.advance(world, cooldownTicks - 50);
    expect(during.halt).toEqual({ kind: "completed" });
    expect(world.state.narrator.pendingHook).toBeUndefined();
  });

  it("asks again after the cooldown while the captain is still idle here (D46)", () => {
    const { world, kernel } = dockedWorldAfterFirstAsk();
    const cooldownTicks = reofferTicks(world);
    const again = kernel.advance(world, cooldownTicks + 100);
    expect(again.halt).toEqual({ kind: "hook" });
    expect(world.state.narrator.pendingHook).toMatchObject({
      kind: "jobBoard",
      context: { portId: PORTS.a },
    });
    expect(world.state.tick).toBeGreaterThanOrEqual(cooldownTicks);
    expect(world.state.narrator.jobBoardLastAsk).toEqual({
      portId: PORTS.a,
      tick: world.state.tick,
    });
    acknowledgePendingHook(kernel, world);

    // And a third time, as long as nothing is on.
    const third = kernel.advance(world, cooldownTicks + 100);
    expect(third.halt).toEqual({ kind: "hook" });
    expect(world.state.narrator.pendingHook?.kind).toBe("jobBoard");
  });

  it("stays quiet while an offer at this port is open, even past the cooldown", () => {
    const { world, kernel } = dockedWorldAfterFirstAsk();
    kernel.enqueueCommand(
      world,
      cmd({ source: "narrator", kind: "offerJob", payload: { job: jobDraft(), surface: false } }),
    );
    kernel.advance(world, 1);
    expect(Object.values(world.state.jobs).map((j) => j.status)).toEqual(["offered"]);
    forgetThisDockingsAsk(world);
    const result = kernel.advance(world, 100);
    expect(result.halt).toEqual({ kind: "completed" });
    expect(world.state.narrator.pendingHook).toBeUndefined();

    const job = Object.values(world.state.jobs)[0];
    if (job === undefined) throw new Error("no job");
    const ticksLeft = job.expiresAtTick - world.state.tick;
    expect(ticksLeft).toBeGreaterThan(reofferTicks(world) + 100);
    const later = kernel.advance(world, reofferTicks(world) + 100);
    expect(later.halt).toEqual({ kind: "completed" });
    expect(world.state.narrator.pendingHook).toBeUndefined();
    expect(job.status).toBe("offered");
  });

  it("stays quiet while a job decision is queued, and while the accepted job plans a course", () => {
    const { world, kernel } = dockedWorldAfterFirstAsk();
    kernel.enqueueCommand(
      world,
      cmd({ source: "narrator", kind: "offerJob", payload: { job: jobDraft(), surface: true } }),
    );
    const untilDecision = kernel.advance(world, 1);
    expect(untilDecision.halt).toEqual({ kind: "decision" });
    forgetThisDockingsAsk(world);
    expect(world.state.narrator.pendingHook).toBeUndefined();

    const decisionId = world.state.decisions.queue[0];
    if (decisionId === undefined) throw new Error("no decision queued");
    kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "resolveDecision", payload: { decisionId, side: "left" } }),
    );
    kernel.advance(world, 1);
    const job = Object.values(world.state.jobs)[0];
    expect(job?.status).toBe("accepted");
    expect(world.state.travel).toMatchObject({ stage: "docked", plannedDestinationId: PORTS.b });
    forgetThisDockingsAsk(world);
    const result = kernel.advance(world, 5);
    expect(result.halt).toEqual({ kind: "completed" });
    expect(world.state.narrator.pendingHook).toBeUndefined();
  });

  it("waits reofferSeconds after a decline before asking again", () => {
    const { world, kernel } = dockedWorldAfterFirstAsk();
    kernel.enqueueCommand(
      world,
      cmd({ source: "narrator", kind: "offerJob", payload: { job: jobDraft(), surface: false } }),
    );
    kernel.advance(world, 1);
    const jobId = Object.keys(world.state.jobs)[0] as JobId | undefined;
    if (jobId === undefined) throw new Error("no job");
    kernel.enqueueCommand(world, cmd({ source: "player", kind: "declineJob", payload: { jobId } }));
    kernel.advance(world, 1);
    const job = world.state.jobs[jobId];
    expect(job?.status).toBe("declined");
    if (job?.closedTick === undefined) throw new Error("declined job has no closedTick");
    forgetThisDockingsAsk(world);

    const cooldownTicks = reofferTicks(world);
    const during = kernel.advance(world, cooldownTicks - 50);
    expect(during.halt).toEqual({ kind: "completed" });
    expect(world.state.narrator.pendingHook).toBeUndefined();

    const after = kernel.advance(world, 100);
    expect(after.halt).toEqual({ kind: "hook" });
    expect(world.state.narrator.pendingHook).toMatchObject({
      kind: "jobBoard",
      context: { portId: PORTS.a },
    });
    expect(world.state.tick - job.closedTick).toBeGreaterThanOrEqual(cooldownTicks);
  });

  it("asks again at the next port, after approachingPort fires on the way in", () => {
    const { world, kernel } = dockedWorldAfterFirstAsk();
    kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "setCourse", payload: { destinationPortId: PORTS.b } }),
    );
    const untilApproach = kernel.advance(world, 1_000);
    expect(untilApproach.halt).toEqual({ kind: "hook" });
    expect(world.state.narrator.pendingHook?.kind).toBe("approachingPort");
    // The record of the ask at Alpha stays; a different port asks at once regardless.
    expect(world.state.narrator.jobBoardLastAsk).toEqual({ portId: PORTS.a, tick: 1 });
    acknowledgePendingHook(kernel, world);

    const untilBoard = kernel.advance(world, 1_000);
    expect(untilBoard.halt).toEqual({ kind: "hook" });
    expect(world.state.travel).toEqual({ stage: "docked", portId: PORTS.b });
    expect(world.state.narrator.pendingHook).toMatchObject({
      kind: "jobBoard",
      context: { portId: PORTS.b },
    });
    expect(world.state.narrator.jobBoardLastAsk).toEqual({
      portId: PORTS.b,
      tick: world.state.tick,
    });
  });
});
