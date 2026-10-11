/**
 * §follow-up-cards: a card side's `next` card is minted with the card, comes up straight after its
 * side is chosen, and is dropped when the other side is; a follow-up has none of its own.
 */
import { describe, expect, it } from "vitest";
import { advanceThroughHooks, freightTestWorld } from "../systems/travel/fixtures";
import { checkInvariants } from "./invariants";
import type { Command, DecisionCardSpec } from "./types/commands";
import type { SimEvent } from "./types/events";
import type { CommandId, DecisionId } from "./types/ids";

let counter = 0;
function cmd<C extends Omit<Command, "id">>(command: C): C & { id: CommandId } {
  counter += 1;
  return { ...command, id: `cmd:follow-up-test:${counter}` as CommandId };
}

const text = (prose: string) => ({ key: "narrator.side", params: {}, prose });

function card(title: string, next: { left?: DecisionCardSpec; right?: DecisionCardSpec } = {}) {
  return {
    prompt: { key: "narrator.situation", params: { title }, prose: `${title}.` },
    left: { label: text(`${title} yes`), commands: [], ...(next.left ? { next: next.left } : {}) },
    right: {
      label: text(`${title} no`),
      commands: [],
      ...(next.right ? { next: next.right } : {}),
    },
  } satisfies DecisionCardSpec;
}

function surfaced(spec: DecisionCardSpec) {
  const { world, kernel } = freightTestWorld();
  const result = kernel.enqueueCommand(
    world,
    cmd({ source: "narrator", kind: "surfaceDecision", payload: { card: spec } }),
  );
  advanceThroughHooks(kernel, world, 5);
  const head = world.state.decisions.queue[0];
  return { world, kernel, result, head };
}

function choose(
  { world, kernel }: ReturnType<typeof surfaced>,
  decisionId: DecisionId,
  side: "left" | "right",
): SimEvent[] {
  const result = kernel.enqueueCommand(
    world,
    cmd({ source: "player", kind: "resolveDecision", payload: { decisionId, side } }),
  );
  expect(result.status).toBe("accepted");
  return advanceThroughHooks(kernel, world, 1).events as SimEvent[];
}

describe("follow-up cards (§follow-up-cards)", () => {
  it("mints a follow-up as its own pending record, neither queued nor held", () => {
    const game = surfaced(card("Main", { left: card("After yes") }));
    expect(game.result.status).toBe("accepted");
    const head = game.head;
    if (head === undefined) throw new Error("no card queued");
    const main = game.world.state.decisions.records[head];
    const followUpId = main?.left.nextDecisionId;
    expect(followUpId).toBeDefined();
    expect(main?.right.nextDecisionId).toBeUndefined();
    const followUp =
      followUpId === undefined ? undefined : game.world.state.decisions.records[followUpId];
    expect(followUp).toMatchObject({ status: "pending", origin: "narrator" });
    expect(followUp?.perspectiveActorId).toBe(main?.perspectiveActorId);
    expect(game.world.state.decisions.queue).toEqual([head]);
    expect(game.world.state.decisions.held).toEqual([]);
    expect(checkInvariants(game.world.state)).toEqual([]);
  });

  it("puts the chosen side's follow-up at the head of the queue", () => {
    const game = surfaced(card("Main", { left: card("After yes") }));
    const head = game.head as DecisionId;
    const followUpId = game.world.state.decisions.records[head]?.left.nextDecisionId;
    choose(game, head, "left");
    expect(game.world.state.decisions.queue).toEqual([followUpId]);
    expect(game.world.state.decisions.records[followUpId as DecisionId]?.status).toBe("pending");
  });

  it("drops the follow-up when the captain chooses the side without one", () => {
    const game = surfaced(card("Main", { left: card("After yes") }));
    const head = game.head as DecisionId;
    const followUpId = game.world.state.decisions.records[head]?.left.nextDecisionId;
    const events = choose(game, head, "right");
    expect(game.world.state.decisions.queue).toEqual([]);
    expect(game.world.state.decisions.records[followUpId as DecisionId]?.status).toBe("dropped");
    const types = events.map((e) => e.type);
    expect(types.indexOf("decisionResolved")).toBeLessThan(types.indexOf("decisionDropped"));
    expect(events.find((e) => e.type === "decisionDropped")?.payload).toMatchObject({
      decisionId: followUpId,
    });
  });

  it("gives each side its own follow-up when both have one, and drops the other", () => {
    const game = surfaced(card("Main", { left: card("After yes"), right: card("After no") }));
    const head = game.head as DecisionId;
    const main = game.world.state.decisions.records[head];
    const left = main?.left.nextDecisionId as DecisionId;
    const right = main?.right.nextDecisionId as DecisionId;
    expect(left).not.toBe(right);
    choose(game, head, "right");
    expect(game.world.state.decisions.queue).toEqual([right]);
    expect(game.world.state.decisions.records[left]?.status).toBe("dropped");
  });

  it("refuses a follow-up that has a follow-up of its own", () => {
    const nested = card("After yes", { left: card("Deeper") });
    const game = surfaced(card("Main", { left: nested }));
    expect(game.result.status).toBe("rejected");
    expect(game.result.status === "rejected" && game.result.rejection.reason).toMatch(
      /follow-up of its own/,
    );
    expect(game.world.state.decisions.queue).toEqual([]);
  });

  it("checks a follow-up's side commands when the card goes up", () => {
    const bad = {
      ...card("After yes"),
      left: {
        label: text("Go"),
        commands: [{ kind: "scenarioSetNeeds" as const, payload: { actorId: "a", needs: {} } }],
      },
    } as unknown as DecisionCardSpec;
    const game = surfaced(card("Main", { left: bad }));
    expect(game.result.status).toBe("rejected");
    expect(game.result.status === "rejected" && game.result.rejection.code).toBe("unauthorized");
  });
});
