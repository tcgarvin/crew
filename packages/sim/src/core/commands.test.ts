import { describe, expect, it } from "vitest";
import { NO_TEMP_REFS, ok, reject } from "./commands";
import { cmd, tinyTestWorld } from "./fixtures/test-world";
import { allocateId } from "./ids";
import { checkInvariants } from "./invariants";
import type { CommandDraft } from "./types/commands";
import type { SimEvent } from "./types/events";
import type { ActorId, DecisionId, JobId } from "./types/ids";
import type { WorldState } from "./types/state";

function firstActor(state: WorldState): ActorId {
  const id = Object.keys(state.actors)[0];
  if (id === undefined) throw new Error("no actor");
  return id as ActorId;
}

function addDecision(
  state: WorldState,
  left: CommandDraft[],
  options: { queued?: boolean; nextDecisionId?: DecisionId } = {},
): DecisionId {
  const id = allocateId(state, "decision");
  state.decisions.records[id] = {
    id,
    origin: "narrator",
    perspectiveActorId: firstActor(state),
    prompt: { key: "decision.test", params: {} },
    left: {
      label: { key: "accept", params: {} },
      commands: left,
      ...(options.nextDecisionId === undefined ? {} : { nextDecisionId: options.nextDecisionId }),
    },
    right: { label: { key: "decline", params: {} }, commands: [] },
    status: "pending",
    createdTick: state.tick,
  };
  if (options.queued ?? true) state.decisions.queue.push(id);
  return id;
}

const types = (events: readonly SimEvent[]) => events.map((e) => e.type);

describe("enqueueCommand", () => {
  it("rejects a kind the source is not authorised for, without touching state", () => {
    const { kernel, world } = tinyTestWorld();
    const before = JSON.stringify(world.state);
    const result = kernel.enqueueCommand(
      world,
      cmd({
        source: "narrator",
        kind: "scenarioSetNeeds",
        payload: { actorId: firstActor(world.state), needs: { hunger: 1 } },
      }),
    );
    expect(result.status).toBe("rejected");
    expect(result.status === "rejected" && result.rejection.code).toBe("unauthorized");
    expect(JSON.stringify(world.state)).toBe(before);
  });

  it("dedupes by command id, both while queued and after applying", () => {
    const { kernel, world } = tinyTestWorld();
    const command = cmd({
      source: "scenario",
      kind: "scenarioSetNeeds",
      payload: { actorId: firstActor(world.state), needs: { hunger: 0.4 } },
    });
    expect(kernel.enqueueCommand(world, command).status).toBe("accepted");
    const again = kernel.enqueueCommand(world, command);
    expect(again.status === "rejected" && again.rejection.code).toBe("duplicate");
    kernel.advance(world, 1);
    expect(world.state.commands.queue).toHaveLength(0);
    const afterApply = kernel.enqueueCommand(world, command);
    expect(afterApply.status === "rejected" && afterApply.rejection.code).toBe("duplicate");
  });

  it("defers a command with a future targetTick until that tick", () => {
    const { kernel, world } = tinyTestWorld();
    const actorId = firstActor(world.state);
    const result = kernel.enqueueCommand(
      world,
      cmd({
        source: "scenario",
        kind: "scenarioSetNeeds",
        targetTick: 5,
        payload: { actorId, needs: { fatigue: 0.75 } },
      }),
    );
    expect(result).toMatchObject({ status: "accepted", applyAtTick: 5 });
    kernel.advance(world, 4);
    expect(world.state.actors[actorId]?.needs.fatigue).toBe(0);
    const step5 = kernel.advance(world, 1);
    expect(world.state.actors[actorId]?.needs.fatigue).toBe(0.75);
    expect(types(step5.events)).toContain("commandApplied");
  });

  it("orders the queue by (applyAtTick, seq)", () => {
    const { kernel, world } = tinyTestWorld();
    const actorId = firstActor(world.state);
    for (const [targetTick, hunger] of [
      [3, 0.3],
      [2, 0.2],
      [3, 0.31],
    ] as const) {
      kernel.enqueueCommand(
        world,
        cmd({
          source: "scenario",
          kind: "scenarioSetNeeds",
          targetTick,
          payload: { actorId, needs: { hunger } },
        }),
      );
    }
    expect(world.state.commands.queue.map((c) => c.applyAtTick)).toEqual([2, 3, 3]);
    kernel.advance(world, 3);
    expect(world.state.actors[actorId]?.needs.hunger).toBe(0.31);
  });

  it("rejects past ticks, unknown entities and kinds with no handler", () => {
    const { kernel, world } = tinyTestWorld();
    kernel.advance(world, 2);
    const past = kernel.enqueueCommand(
      world,
      cmd({
        source: "scenario",
        kind: "scenarioSetNeeds",
        targetTick: 2,
        payload: { actorId: firstActor(world.state), needs: {} },
      }),
    );
    expect(past.status === "rejected" && past.rejection.code).toBe("tickInPast");
    const unknown = kernel.enqueueCommand(
      world,
      cmd({
        source: "scenario",
        kind: "scenarioSetNeeds",
        payload: { actorId: "a99" as ActorId, needs: {} },
      }),
    );
    expect(unknown.status === "rejected" && unknown.rejection.code).toBe("unknownEntity");
    const unhandled = kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "declineJob", payload: { jobId: "j1" as JobId } }),
    );
    expect(unhandled.status === "rejected" && unhandled.rejection.code).toBe("invalidPayload");
  });

  it("revalidates at apply time and emits commandRejected with no mutation", () => {
    const { kernel, world, registry } = tinyTestWorld();
    let allowed = true;
    let applied = 0;
    registry.registerCommandHandler("declineJob", {
      validate: () => (allowed ? ok(null) : reject("preconditionFailed", "closed")),
      apply: () => {
        applied += 1;
        return NO_TEMP_REFS;
      },
    });
    const command = cmd({
      source: "player",
      kind: "declineJob",
      payload: { jobId: "j1" as JobId },
    });
    expect(kernel.enqueueCommand(world, command).status).toBe("accepted");
    allowed = false;
    const result = kernel.advance(world, 1);
    expect(applied).toBe(0);
    const rejected = result.events.find((e) => e.type === "commandRejected");
    expect(rejected?.causeIds).toEqual([command.id]);
    expect(rejected?.significance).toBe("notable");
  });
});

describe("resolveDecision", () => {
  it("applies the chosen side as player commands, then queues the next decision", () => {
    const { kernel, world, registry } = tinyTestWorld();
    const accepted: string[] = [];
    registry.registerCommandHandler("acceptContract", {
      validate: (_ctx, command) =>
        command.source === "player" ? ok(command.payload.jobId) : reject("unauthorized", "x"),
      apply: (_ctx, _command, jobId) => {
        accepted.push(jobId);
        return NO_TEMP_REFS;
      },
    });
    const state = world.state;
    const follow = addDecision(state, [], { queued: false });
    const head = addDecision(
      state,
      [{ kind: "acceptContract", payload: { jobId: "j7" as JobId } }],
      { nextDecisionId: follow },
    );

    // A pending decision halts the world until it is resolved.
    expect(kernel.advance(world, 5)).toMatchObject({
      ticksAdvanced: 0,
      halt: { kind: "decision" },
    });

    const resolve = cmd({
      source: "player",
      kind: "resolveDecision",
      payload: { decisionId: head, side: "left" },
    });
    expect(kernel.enqueueCommand(world, resolve).status).toBe("accepted");
    const result = kernel.advance(world, 5);

    expect(accepted).toEqual(["j7"]);
    expect(state.decisions.records[head]).toMatchObject({
      status: "resolved",
      chosen: "left",
      resolvedTick: 1,
    });
    expect(state.decisions.queue).toEqual([follow]);
    expect(types(result.events)).toEqual([
      "commandApplied", // acceptContract, as player
      "decisionResolved",
      "commandApplied", // resolveDecision itself
      "decisionPending", // the follow-up decision
    ]);
    expect(result.events[0]).toMatchObject({ source: "player", causeIds: [resolve.id] });
    expect(result).toMatchObject({ ticksAdvanced: 1, halt: { kind: "decision" } });
    expect(checkInvariants(state)).toEqual([]);
  });

  it("rejects an unknown decision id", () => {
    const { kernel, world } = tinyTestWorld();
    const result = kernel.enqueueCommand(
      world,
      cmd({
        source: "player",
        kind: "resolveDecision",
        payload: { decisionId: "x42" as DecisionId, side: "right" },
      }),
    );
    expect(result.status === "rejected" && result.rejection.code).toBe("unknownEntity");
  });

  it("rejects an option command outside the player's authority", () => {
    const { kernel, world } = tinyTestWorld();
    const id = addDecision(world.state, [
      {
        kind: "scenarioSetNeeds",
        payload: { actorId: firstActor(world.state), needs: { hunger: 1 } },
      },
    ]);
    const result = kernel.enqueueCommand(
      world,
      cmd({ source: "player", kind: "resolveDecision", payload: { decisionId: id, side: "left" } }),
    );
    expect(result.status === "rejected" && result.rejection.code).toBe("unauthorized");
    expect(world.state.decisions.records[id]?.status).toBe("pending");
  });

  it("rejects a decision that is not at the head of the queue", () => {
    const { kernel, world } = tinyTestWorld();
    addDecision(world.state, []);
    const second = addDecision(world.state, []);
    const result = kernel.enqueueCommand(
      world,
      cmd({
        source: "player",
        kind: "resolveDecision",
        payload: { decisionId: second, side: "right" },
      }),
    );
    expect(result.status === "rejected" && result.rejection.code).toBe("preconditionFailed");
  });
});

describe("scenario commands", () => {
  it("spawns items into a container spawned in the same command and reports temp refs", () => {
    const { kernel, world } = tinyTestWorld();
    const result = kernel.enqueueCommand(
      world,
      cmd({
        source: "scenario",
        kind: "scenarioSpawn",
        payload: {
          spawns: [
            {
              kind: "item",
              tempRef: "$crate",
              itemDefId: "item.tiny.crate" as never,
              count: 1,
              location: {
                kind: "inExternalStore",
                portId: "port.tiny.dock" as never,
                storeKey: "warehouse",
              },
            },
            {
              kind: "item",
              tempRef: "$food",
              itemDefId: "item.tiny.rations" as never,
              count: 4,
              location: { kind: "inContainer", containerId: "$crate" as never },
            },
          ],
        },
      }),
    );
    expect(result.status).toBe("accepted");
    const { events } = kernel.advance(world, 1);
    const applied = events.find((e) => e.type === "commandApplied");
    const refs = applied?.type === "commandApplied" ? applied.payload.tempRefs : {};
    const crateId = refs.$crate as string;
    const food = world.state.items[refs.$food as never];
    expect(food?.location).toEqual({ kind: "inContainer", containerId: crateId });
    expect(world.caches.index.itemsByContainer[crateId as never]).toEqual([refs.$food]);
    expect(checkInvariants(world.state)).toEqual([]);
  });

  it("rejects spawning onto void or outside the deck", () => {
    const { kernel, world } = tinyTestWorld();
    const result = kernel.enqueueCommand(
      world,
      cmd({
        source: "scenario",
        kind: "scenarioSpawn",
        payload: {
          spawns: [
            {
              kind: "item",
              tempRef: "$w",
              itemDefId: "item.tiny.wrench" as never,
              count: 1,
              location: { kind: "onDeck", deckId: "deck.tiny.main" as never, x: 9, y: 1 },
            },
          ],
        },
      }),
    );
    expect(result.status === "rejected" && result.rejection.code).toBe("invalidPayload");
  });

  it("injects a fault once", () => {
    const { kernel, world } = tinyTestWorld();
    const machineId = Object.keys(world.state.machines)[0] as never;
    const inject = () =>
      cmd({
        source: "scenario",
        kind: "scenarioInjectFault",
        payload: { machineId, faultKey: "wornBearing" },
      });
    expect(kernel.enqueueCommand(world, inject()).status).toBe("accepted");
    kernel.advance(world, 1);
    expect(world.state.machines[machineId]?.faults).toHaveLength(1);
    const twice = kernel.enqueueCommand(world, inject());
    expect(twice.status === "rejected" && twice.rejection.code).toBe("preconditionFailed");
  });
});
