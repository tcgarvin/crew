/**
 * `surfaceDecision` tests (D6, D8): the kernel-owned command that queues a `Decision`, mirroring
 * `resolveDecision`'s own test coverage in `commands.test.ts`. Uses the travel+commerce freight
 * fixture (not the tiny core fixture) because a meaningful option command (`setCourse`) needs a
 * docked ship with routes, and a second crew member to exercise the D8 perspective fallback.
 */
import { describe, expect, it } from "vitest";
import { FIX, PORTS, advanceThroughHooks, freightTestWorld } from "../systems/travel/fixtures";
import type { Command } from "./types/commands";
import type { ActorId, CommandId } from "./types/ids";

let counter = 0;
function cmd<C extends Omit<Command, "id">>(command: C): C & { id: CommandId } {
  counter += 1;
  return { ...command, id: `cmd:surface-decision-test:${counter}` as CommandId };
}

function setCourseCard(coursePortId = PORTS.b) {
  return {
    prompt: { key: "decision.test", params: {} },
    left: {
      label: { key: "decision.test.left", params: {} },
      commands: [{ kind: "setCourse" as const, payload: { destinationPortId: coursePortId } }],
    },
    right: { label: { key: "decision.test.right", params: {} }, commands: [] },
  };
}

describe("surfaceDecision", () => {
  it("queues a decision and halts advance with kind 'decision'", () => {
    const { world, kernel } = freightTestWorld();
    const result = kernel.enqueueCommand(
      world,
      cmd({ source: "narrator", kind: "surfaceDecision", payload: { card: setCourseCard() } }),
    );
    expect(result.status).toBe("accepted");
    const advanceResult = advanceThroughHooks(kernel, world, 5);
    expect(advanceResult.halt).toEqual({ kind: "decision" });
    expect(world.state.decisions.queue).toHaveLength(1);
    const decisionId = world.state.decisions.queue[0];
    const decision =
      decisionId === undefined ? undefined : world.state.decisions.records[decisionId];
    expect(decision?.origin).toBe("narrator");
    expect(decision?.status).toBe("pending");
    const captain = Object.values(world.state.actors).find((a) => a.roleTags.includes("captain"));
    expect(decision?.perspectiveActorId).toBe(captain?.id);
  });

  it("resolveDecision applies the chosen side's setCourse while docked", () => {
    const { world, kernel } = freightTestWorld();
    kernel.enqueueCommand(
      world,
      cmd({
        source: "narrator",
        kind: "surfaceDecision",
        payload: { card: setCourseCard(PORTS.b) },
      }),
    );
    advanceThroughHooks(kernel, world, 5);
    const decisionId = world.state.decisions.queue[0];
    if (decisionId === undefined) throw new Error("no decision queued");
    const result = kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "resolveDecision", payload: { decisionId, side: "left" } }),
    );
    expect(result.status).toBe("accepted");
    advanceThroughHooks(kernel, world, 1);
    expect(world.state.decisions.records[decisionId]?.status).toBe("resolved");
    // `setCourse` only records intent while docked (SD §17.1: departure takes time); run it
    // through to transit, mirroring `commerce.test.ts`'s own "rejects setCourse while in transit".
    advanceThroughHooks(kernel, world, 60);
    expect(world.state.travel.stage).not.toBe("docked");
    expect(world.state.travel.stage === "docked" ? undefined : world.state.travel.toPortId).toBe(
      PORTS.b,
    );
  });

  it("rejects an option command kind that is not authorized for source player", () => {
    const { world, kernel } = freightTestWorld();
    const card = {
      prompt: { key: "decision.test", params: {} },
      left: {
        label: { key: "decision.test.left", params: {} },
        commands: [
          {
            kind: "scenarioSetNeeds" as const,
            payload: { actorId: FIX.captain as unknown as ActorId, needs: { hunger: 0 } },
          },
        ],
      },
      right: { label: { key: "decision.test.right", params: {} }, commands: [] },
    };
    const result = kernel.enqueueCommand(
      world,
      cmd({ source: "narrator", kind: "surfaceDecision", payload: { card } }),
    );
    expect(result.status).toBe("rejected");
    expect(result.status === "rejected" && result.rejection.code).toBe("unauthorized");
  });

  it("rejects surfaceDecision from source player (players don't surface decisions)", () => {
    const { world, kernel } = freightTestWorld();
    const result = kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "surfaceDecision", payload: { card: setCourseCard() } }),
    );
    expect(result.status).toBe("rejected");
    expect(result.status === "rejected" && result.rejection.code).toBe("unauthorized");
  });
});
