/**
 * §tried-sides: a side with an `attempt` rolls its odds once on the seeded narrator stream when
 * chosen and runs the branch the roll gives: its own commands, aftermath and follow-up, or the
 * failure branch's, with the failure levers applied as the narrator only then.
 */
import { describe, expect, it } from "vitest";
import { PORTS, advanceThroughHooks, freightTestWorld } from "../systems/travel/fixtures";
import type { Command, CommandDraft, DecisionCardSpec } from "./types/commands";
import type { SimEvent } from "./types/events";
import type { CommandId, DecisionId } from "./types/ids";

let counter = 0;
function cmd<C extends Omit<Command, "id">>(command: C): C & { id: CommandId } {
  counter += 1;
  return { ...command, id: `cmd:tried-test:${counter}` as CommandId };
}

const text = (prose: string) => ({ key: "narrator.side", params: {}, prose });
const fine: CommandDraft = {
  kind: "transact",
  payload: { amount: -50, memo: "the fine", counterparty: "" },
};

function plainCard(title: string): DecisionCardSpec {
  return {
    prompt: { key: "narrator.situation", params: { title }, prose: `${title}.` },
    left: { label: text(`${title} yes`), commands: [] },
    right: { label: text(`${title} no`), commands: [] },
  };
}

/** A card whose left side is a try: success sets course, failure only pays the fine. */
function triedCard(
  odds: number,
  extra: { next?: DecisionCardSpec; failNext?: DecisionCardSpec; failLevers?: CommandDraft[] } = {},
): DecisionCardSpec {
  return {
    prompt: { key: "narrator.situation", params: { title: "The gate" }, prose: "The gate." },
    left: {
      label: text("Bluff past"),
      commands: [{ kind: "setCourse", payload: { destinationPortId: PORTS.b } }],
      aftermath: text("They wave us through."),
      ...(extra.next === undefined ? {} : { next: extra.next }),
      attempt: {
        odds,
        failCommands: [],
        failLevers: extra.failLevers ?? [fine],
        failAftermath: text("They see through it."),
        ...(extra.failNext === undefined ? {} : { failNext: extra.failNext }),
      },
    },
    right: { label: text("Pay up"), commands: [] },
  };
}

function surfaced(spec: DecisionCardSpec, source: "narrator" | "system" = "narrator") {
  const fixture = freightTestWorld();
  const result = fixture.kernel.enqueueCommand(
    fixture.world,
    cmd({ source, kind: "surfaceDecision", payload: { card: spec } }),
  );
  advanceThroughHooks(fixture.kernel, fixture.world, 5);
  const head = fixture.world.state.decisions.queue[0] as DecisionId;
  return { ...fixture, result, head };
}

function choose(game: ReturnType<typeof surfaced>, side: "left" | "right"): SimEvent[] {
  const accepted = game.kernel.enqueueCommand(
    game.world,
    cmd({ source: "player", kind: "resolveDecision", payload: { decisionId: game.head, side } }),
  );
  expect(accepted.status).toBe("accepted");
  return advanceThroughHooks(game.kernel, game.world, 1).events as SimEvent[];
}

describe("tried sides (§tried-sides)", () => {
  it("copies the attempt onto the option and links the failure follow-up", () => {
    const game = surfaced(triedCard(70, { failNext: plainCard("Caught") }));
    expect(game.result.status).toBe("accepted");
    const option = game.world.state.decisions.records[game.head]?.left;
    expect(option?.attempt).toMatchObject({ odds: 70, failLevers: [fine] });
    const failNext = option?.attempt?.failNextDecisionId;
    expect(failNext).toBeDefined();
    expect(game.world.state.decisions.records[failNext as DecisionId]?.status).toBe("pending");
  });

  it("at 100 runs the side: its commands, its follow-up, no lever, the other follow-up dropped", () => {
    const game = surfaced(
      triedCard(100, { next: plainCard("Through"), failNext: plainCard("Caught") }),
    );
    const option = game.world.state.decisions.records[game.head]?.left;
    const balance = game.world.state.money.balance;
    const events = choose(game, "left");
    const decision = game.world.state.decisions.records[game.head];
    expect(decision?.tried).toEqual({ odds: 100, worked: true });
    expect(events.find((e) => e.type === "attemptRolled")?.payload).toEqual({
      decisionId: game.head,
      side: "left",
      odds: 100,
      worked: true,
    });
    expect(game.world.state.money.balance).toBe(balance);
    const kinds = events.filter((e) => e.type === "commandApplied").map((e) => e.payload.kind);
    expect(kinds).toContain("setCourse");
    expect(kinds).not.toContain("transact");
    expect(game.world.state.decisions.queue).toEqual([option?.nextDecisionId]);
    const failNext = option?.attempt?.failNextDecisionId as DecisionId;
    expect(game.world.state.decisions.records[failNext]?.status).toBe("dropped");
  });

  it("at 0 runs the failure branch: the lever as the narrator, its follow-up, not the side's commands", () => {
    const game = surfaced(
      triedCard(0, { next: plainCard("Through"), failNext: plainCard("Caught") }),
    );
    const option = game.world.state.decisions.records[game.head]?.left;
    const balance = game.world.state.money.balance;
    const events = choose(game, "left");
    expect(game.world.state.decisions.records[game.head]?.tried).toEqual({
      odds: 0,
      worked: false,
    });
    expect(game.world.state.money.balance).toBe(balance - 50);
    const applied = events.find(
      (e) => e.type === "commandApplied" && e.payload.kind === "transact",
    );
    expect(applied?.source).toBe("narrator");
    const kinds = events.filter((e) => e.type === "commandApplied").map((e) => e.payload.kind);
    expect(kinds).toContain("transact");
    expect(kinds).not.toContain("setCourse");
    expect(game.world.state.decisions.queue).toEqual([option?.attempt?.failNextDecisionId]);
    expect(game.world.state.decisions.records[option?.nextDecisionId as DecisionId]?.status).toBe(
      "dropped",
    );
  });

  it("never applies the failure lever when the other side is chosen, and rolls nothing", () => {
    const game = surfaced(triedCard(0));
    const balance = game.world.state.money.balance;
    const narratorStream = JSON.stringify(game.world.state.rng.narrator);
    const events = choose(game, "right");
    expect(events.some((e) => e.type === "attemptRolled")).toBe(false);
    expect(game.world.state.decisions.records[game.head]?.tried).toBeUndefined();
    expect(game.world.state.money.balance).toBe(balance);
    expect(JSON.stringify(game.world.state.rng.narrator)).toBe(narratorStream);
  });

  it("rolls the same way for the same seed and state", () => {
    const outcomes = [0, 1].map(() => {
      const game = surfaced(triedCard(50));
      choose(game, "left");
      return game.world.state.decisions.records[game.head]?.tried;
    });
    expect(outcomes[0]).toBeDefined();
    expect(outcomes[1]).toEqual(outcomes[0]);
  });

  it("refuses a failure lever that is no longer possible without undoing the choice", () => {
    const game = surfaced(
      triedCard(0, {
        failLevers: [
          { kind: "transact", payload: { amount: -10, memo: "a bribe", counterparty: "" } },
        ],
      }),
    );
    // The money is spent between the card going up and the choice.
    game.world.state.money.balance = 0;
    const events = choose(game, "left");
    expect(game.world.state.decisions.records[game.head]?.status).toBe("resolved");
    expect(events.find((e) => e.type === "failLeverRefused")?.payload).toMatchObject({
      decisionId: game.head,
      kind: "transact",
    });
    expect(game.world.state.money.balance).toBe(0);
  });

  it("refuses odds outside 0 to 100, a lever that is not an outcome lever, and levers from a system card", () => {
    const bad = triedCard(101);
    expect(surfaced(bad).result.status).toBe("rejected");
    const notLever = triedCard(50, {
      failLevers: [{ kind: "requestCall", payload: { when: "nextPort", why: "" } }],
    });
    const refused = surfaced(notLever).result;
    expect(refused.status === "rejected" && refused.rejection.reason).toMatch(/outcome lever/);
    const fromSystem = surfaced(triedCard(50), "system").result;
    expect(fromSystem.status === "rejected" && fromSystem.rejection.reason).toMatch(
      /only from the narrator/,
    );
  });
});
