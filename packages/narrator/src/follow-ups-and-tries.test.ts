/**
 * §follow-up-cards and §tried-sides in the translator: a card's `followUps` become its sides'
 * `next` (or a tried side's `failNext`) cards, and a side with `odds` becomes a try with its
 * failure branch: `failEffect`, the `failLevers` it names by intent index, and its fail aftermath.
 * The last test round-trips one through the real kernel.
 */
import {
  type CommandId,
  type DecisionCardSpec,
  type DecisionId,
  type NarratorCommand,
  type PortDefId,
  type SaveEnvelope,
  type SimEvent,
  createKernel,
  createRegistry,
  registerCommerce,
  registerTravel,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import type { NarratorPlan, NarratorRequest, TranslationCtx } from "./contract";
import { buildDigest } from "./digest";
import { FIXTURE_SCENARIO, quietTooLongRequest } from "./fixtures";
import { applyDecisionEvents } from "./history";
import { type CardShown, EMPTY_NOTES } from "./notes";
import { content, emptyPlan, withCardFields } from "./test-support";
import { translateIntents } from "./translate";

function ctxOf(req: NarratorRequest): TranslationCtx {
  return {
    snapshot: req.snapshot,
    content: content(),
    hookTick: req.hook.tick,
    callId: "call1",
    hook: req.hook,
  };
}

function docked(req: NarratorRequest, portId = "port.kessler_drift"): NarratorRequest {
  const snapshot = structuredClone(req.snapshot) as SaveEnvelope;
  snapshot.state.travel = { stage: "docked", portId: portId as PortDefId };
  return { ...req, snapshot };
}

const plain = (label: string) => ({
  label,
  effect: "none",
  coursePort: "",
  talkWith: "",
  tone: "",
});

const followCard = (title: string, overrides: Record<string, unknown> = {}) => ({
  title,
  speaker: "Dane Whitcross",
  situation: `Dane comes back to the captain. “${title}, Captain.”`,
  left: plain(`${title}: go on`),
  right: plain(`${title}: leave it`),
  leftAftermath: "Dane goes to see to it.",
  rightAftermath: "Dane lets it lie.",
  ...overrides,
});

/** A card at the gate: left bluffs past the guard (a try when given odds), right pays. */
function gateCard(overrides: Record<string, unknown> = {}, left: Record<string, unknown> = {}) {
  return withCardFields({
    kind: "surfaceDecision",
    beat: "",
    title: "The gate guard",
    speaker: "Dane Whitcross",
    situation: "Dane leans in at the hatch. “The guard wants a look at the hold, Captain.”",
    left: { ...plain("Bluff past him"), ...left },
    right: plain("Let him look"),
    leftAftermath: "Dane waves the guard off with a story.",
    rightAftermath: "The guard climbs aboard with his lamp.",
    beatOfThread: "",
    closesThread: "",
    ...overrides,
  });
}

const fine = { kind: "transact", beat: "", amount: -40, memo: "the gate fine", counterparty: "" };

function translate(intents: unknown[], req = docked(quietTooLongRequest(content()))) {
  return translateIntents(emptyPlan({ intents: intents as NarratorPlan["intents"] }), ctxOf(req));
}

function cardOf(commands: readonly NarratorCommand[]): DecisionCardSpec {
  const command = commands.find((c) => c.kind === "surfaceDecision");
  if (command?.kind !== "surfaceDecision") throw new Error("no card");
  return command.payload.card as DecisionCardSpec;
}

describe("follow-up cards in the translator (§follow-up-cards)", () => {
  it("puts a follow-up after the side it names, and none after the other", () => {
    const res = translate([
      gateCard({ followUps: [{ on: "left", card: followCard("He bought it") }] }),
    ]);
    expect(res.dropped).toEqual([]);
    const card = cardOf(res.commands);
    expect(card.left.next?.prompt).toMatchObject({
      params: { title: "He bought it", speaker: "Dane Whitcross" },
    });
    expect(card.left.next?.left.label.prose).toBe("He bought it: go on");
    expect(card.left.next?.left.aftermath?.prose).toBe("Dane goes to see to it.");
    expect(card.right.next).toBeUndefined();
  });

  it("puts the same follow-up after both sides for either", () => {
    const res = translate([gateCard({ followUps: [{ on: "either", card: followCard("After") }] })]);
    const card = cardOf(res.commands);
    expect(card.left.next).toEqual(card.right.next);
    expect(card.left.next).toBeDefined();
  });

  it("lets the follow-up's speaker differ, and keeps it to the text checks", () => {
    const other = followCard("Words", { speaker: "Jax Okonkwo" });
    const ok = translate([gateCard({ followUps: [{ on: "right", card: other }] })]);
    expect(cardOf(ok.commands).right.next?.prompt.params).toMatchObject({ speaker: "Jax Okonkwo" });
    const numbered = followCard("Words", { situation: "Jax says it cost us 200 credits." });
    const bad = translate([gateCard({ followUps: [{ on: "right", card: numbered }] })]);
    expect(bad.commands.filter((c) => c.kind === "surfaceDecision")).toEqual([]);
    expect(bad.dropped[0]?.reason).toMatch(/followUps\[0\].*numeric consequence/);
  });

  it("refuses two follow-ups after one side, and a follow-up of a follow-up at the schema", () => {
    const twice = translate([
      gateCard({
        followUps: [
          { on: "left", card: followCard("One") },
          { on: "either", card: followCard("Two") },
        ],
      }),
    ]);
    expect(twice.dropped[0]?.reason).toMatch(/a second follow-up after left/);
    const nested = translate([
      gateCard({
        followUps: [{ on: "left", card: { ...followCard("One"), followUps: [] } }],
      }),
    ]);
    expect(nested.commands.some((c) => c.kind === "surfaceDecision")).toBe(false);
    expect(nested.dropped[0]?.kind).toBe("surfaceDecision");
  });

  it("counts a card and its follow-up as the call's one card", () => {
    const res = translate([
      gateCard({ followUps: [{ on: "left", card: followCard("After") }] }),
      gateCard({ title: "Another" }),
    ]);
    expect(res.commands.filter((c) => c.kind === "surfaceDecision")).toHaveLength(1);
    expect(res.dropped.map((d) => d.reason)).toContain("surfaceDecision: only one card per call");
  });
});

describe("tried sides in the translator (§tried-sides)", () => {
  it("makes a side with odds a try: the odds, the failure effect and aftermath", () => {
    const res = translate([
      gateCard(
        { leftFailAftermath: "The guard is not fooled; he calls for his sergeant." },
        { odds: "70", failEffect: "none", failLevers: [1] },
      ),
      fine,
    ]);
    expect(res.dropped).toEqual([]);
    const attempt = cardOf(res.commands).left.attempt;
    expect(attempt).toMatchObject({ odds: 70, failCommands: [] });
    expect(attempt?.failAftermath?.prose).toBe(
      "The guard is not fooled; he calls for his sergeant.",
    );
    expect(cardOf(res.commands).right.attempt).toBeUndefined();
  });

  it("puts the levers a try names on its failure branch only, whatever their order", () => {
    const res = translate([fine, gateCard({}, { odds: "60", failLevers: [0] })]);
    expect(res.dropped).toEqual([]);
    expect(res.commands.map((c) => c.kind)).toEqual(["surfaceDecision"]);
    expect(cardOf(res.commands).left.attempt?.failLevers).toEqual([
      { kind: "transact", payload: { amount: -40, memo: "the gate fine", counterparty: "" } },
    ]);
  });

  it("drops a card whose failLevers name no outcome lever, and a lever whose card did not go up", () => {
    const notLever = translate([
      gateCard({}, { odds: "60", failLevers: [1] }),
      {
        kind: "stockMarket",
        beat: "",
        port: "port.kessler_drift",
        cargoItem: "item.spare_parts_stack",
        count: "1",
        priceTier: "fair",
      },
    ]);
    expect(notLever.commands.map((c) => c.kind)).toEqual(["stockMarket"]);
    expect(notLever.dropped[0]?.reason).toMatch(/intent 1 is not one of strike/);
    const orphan = translate([
      gateCard({ title: "Costs us 5 credits" }, { odds: "60", failLevers: [1] }),
      fine,
    ]);
    expect(orphan.commands).toEqual([]);
    expect(orphan.dropped.map((d) => d.reason)).toContain(
      "transact: a failLever of a card that did not go up, so it never applies",
    );
  });

  it("refuses odds that are not a whole percent, and a failure branch without odds", () => {
    for (const odds of ["seventy", "101", "50.5", "-5"]) {
      const res = translate([gateCard({ leftFailAftermath: "No." }, { odds })]);
      expect(res.dropped[0]?.reason).toMatch(/not a whole percent from 0 to 100/);
    }
    const stray = translate([gateCard({ leftFailAftermath: "He calls his sergeant." })]);
    expect(stray.dropped[0]?.reason).toMatch(/need odds/);
  });

  it("refuses odds on a beat card and on a closing card", () => {
    const tried = { odds: "50" };
    const beat = translate([
      gateCard({ beatOfThread: "the gate", leftFailAftermath: "He frowns." }, tried),
    ]);
    expect(beat.dropped[0]?.reason).toMatch(/beat or closing card/);
    const closing = translate([
      gateCard({ closesThread: "the gate", leftFailAftermath: "He frowns." }, tried),
    ]);
    expect(closing.dropped[0]?.reason).toMatch(/beat or closing card/);
  });

  it("refuses a try whose failure is the same as its success", () => {
    const same = translate([gateCard({}, { odds: "40" })]);
    expect(same.dropped[0]?.reason).toMatch(/failure is the same as its success/);
    const echoed = translate([
      gateCard({ leftFailAftermath: "Dane waves the guard off with a story." }, { odds: "40" }),
    ]);
    expect(echoed.dropped[0]?.reason).toMatch(/failure is the same as its success/);
    const withFollowUp = translate([
      gateCard({ followUps: [{ on: "failed", card: followCard("Caught") }] }, { odds: "40" }),
    ]);
    expect(withFollowUp.dropped).toEqual([]);
  });

  it("hangs a failed follow-up on the tried side's failure, and needs a tried side for it", () => {
    const res = translate([
      gateCard(
        {
          followUps: [
            { on: "left", card: followCard("Through") },
            { on: "failed", card: followCard("Caught") },
          ],
        },
        { odds: "55" },
      ),
    ]);
    const left = cardOf(res.commands).left;
    expect(left.next?.prompt.params).toMatchObject({ title: "Through" });
    expect(left.attempt?.failNext?.prompt.params).toMatchObject({ title: "Caught" });
    const none = translate([gateCard({ followUps: [{ on: "failed", card: followCard("C") }] })]);
    expect(none.dropped[0]?.reason).toMatch(/on failed needs a side with odds/);
  });

  it("lets the situation and the tried side's label state its odds, and nothing else", () => {
    const stated = {
      situation: "Dane leans in. “I make it 70% he buys it, Captain.”",
      leftFailAftermath: "He does not buy it.",
    };
    const ok = translate([gateCard(stated, { odds: "70", label: "Bluff it (70%)" })]);
    expect(ok.dropped).toEqual([]);
    const otherNumber = translate([gateCard(stated, { odds: "60" })]);
    expect(otherNumber.dropped[0]?.reason).toMatch(/numeric consequence/);
    const otherSide = translate([
      gateCard({ ...stated, right: plain("Pay him (70%)") }, { odds: "70" }),
    ]);
    expect(otherSide.dropped[0]?.reason).toMatch(/numeric consequence/);
  });

  it("a failure effect uses the side's own parameters", () => {
    const res = translate([
      gateCard(
        { leftFailAftermath: "We are turned back to the Hub." },
        { odds: "50", failEffect: "setCourse", coursePort: "port.crossroads_hub" },
      ),
    ]);
    expect(res.dropped).toEqual([]);
    expect(cardOf(res.commands).left.attempt?.failCommands).toEqual([
      { kind: "setCourse", payload: { destinationPortId: "port.crossroads_hub" } },
    ]);
  });
});

describe("a tried side, translated and played by the real kernel (§tried-sides)", () => {
  function played(odds: string) {
    const bundle = content();
    const registry = createRegistry();
    registerTravel(registry);
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
      callId: "call-try",
    };
    const res = translateIntents(
      emptyPlan({
        intents: [
          gateCard(
            {
              leftFailAftermath: "The guard sees through it and writes us up.",
              followUps: [{ on: "failed", card: followCard("Written up") }],
            },
            { odds, failLevers: [1] },
          ),
          fine,
        ] as unknown as NarratorPlan["intents"],
      }),
      ctx,
    );
    expect(res.dropped).toEqual([]);
    for (const command of res.commands) {
      expect(kernel.enqueueCommand(world, command).status).toBe("accepted");
    }
    for (let i = 0; i < 20 && world.state.decisions.queue.length === 0; i++) {
      const hook = world.state.narrator.pendingHook;
      if (hook !== undefined) {
        kernel.enqueueCommand(world, {
          id: `cmd:ack:${hook.id}` as CommandId,
          source: "system",
          kind: "acknowledgeHook",
          payload: { hookId: hook.id },
        });
      }
      kernel.advance(world, 1);
    }
    const decisionId = world.state.decisions.queue[0] as DecisionId;
    const balance = world.state.money.balance;
    kernel.enqueueCommand(world, {
      id: "cmd:test:resolve" as CommandId,
      source: "player",
      kind: "resolveDecision",
      payload: { decisionId, side: "left" },
    });
    kernel.advance(world, 1);
    return { world, decisionId, balance };
  }

  it("at 0 the fine is paid and the follow-up comes up", () => {
    const { world, decisionId, balance } = played("0");
    expect(world.state.decisions.records[decisionId]?.tried).toEqual({ odds: 0, worked: false });
    expect(world.state.money.balance).toBe(balance - 40);
    const next = world.state.decisions.queue[0];
    expect(
      next === undefined ? undefined : world.state.decisions.records[next]?.prompt.params,
    ).toMatchObject({ title: "Written up" });
  });

  it("at 100 nothing is paid and nothing follows", () => {
    const { world, decisionId, balance } = played("100");
    expect(world.state.decisions.records[decisionId]?.tried).toEqual({ odds: 100, worked: true });
    expect(world.state.money.balance).toBe(balance);
    expect(world.state.decisions.queue).toEqual([]);
  });
});

describe("a tried side in the card history (§card-history, §tried-sides)", () => {
  function answered(worked: boolean) {
    const req = structuredClone(quietTooLongRequest(content())) as NarratorRequest;
    const state = req.snapshot.state as SaveEnvelope["state"];
    const id = "decision:gate" as DecisionId;
    const side = (prose: string) => ({
      label: { key: "narrator.side", params: {}, prose },
      commands: [],
    });
    state.decisions.records[id] = {
      id,
      origin: "narrator",
      perspectiveActorId: Object.keys(state.actors)[0] as never,
      prompt: {
        key: "narrator.situation",
        params: { title: "The gate guard", speaker: "Dane Whitcross" },
        prose: "The guard wants a look at the hold.",
      },
      left: { ...side("Bluff past him"), attempt: { odds: 70, failCommands: [], failLevers: [] } },
      right: side("Let him look"),
      status: "resolved",
      createdTick: req.hook.tick,
      resolvedTick: req.hook.tick,
      chosen: "left",
      tried: { odds: 70, worked },
    };
    const entry: CardShown = {
      tick: req.hook.tick,
      decisionId: id,
      title: "The gate guard",
      speaker: "Dane Whitcross",
      gist: "The guard wants a look at the hold.",
      leftLabel: "Bluff past him",
      rightLabel: "Let him look",
      chosen: "left",
      closedThread: null,
    };
    const event = {
      id: "e:1",
      tick: req.hook.tick,
      seq: 0,
      type: "attemptRolled",
      significance: "notable",
      subjectIds: [id],
      causeIds: [],
      source: "player",
      payload: { decisionId: id, side: "left", odds: 70, worked },
    } as unknown as SimEvent;
    return { req, state, id, entry, event };
  }

  it("records the roll from the kernel's event, or from the record when the event was lost", () => {
    const { state, entry, event, id } = answered(false);
    const record = state.decisions.records[id];
    if (record === undefined) throw new Error("no record");
    const { tried: _t, ...noRoll } = record;
    const fromEvent = applyDecisionEvents(
      [entry],
      [event],
      { ...state, decisions: { ...state.decisions, records: { [id]: noRoll } } },
      content(),
    );
    expect(fromEvent[0]?.tried).toEqual({ odds: 70, worked: false, kind: "try" });
    const fromRecord = applyDecisionEvents([entry], [], state, content());
    expect(fromRecord[0]?.tried).toEqual({ odds: 70, worked: false, kind: "try" });
  });

  it("tells the next call the chance and how it went", () => {
    for (const worked of [false, true]) {
      const { req, entry } = answered(worked);
      const notes = {
        ...EMPTY_NOTES,
        cardsShown: [{ ...entry, tried: { odds: 70, worked, kind: "try" as const } }],
      };
      const { text } = buildDigest(req.snapshot, [], notes, content(), req.hook);
      expect(text).toContain(`→ chose "Bluff past him" (70%): it ${worked ? "worked" : "failed"}`);
    }
  });
});
