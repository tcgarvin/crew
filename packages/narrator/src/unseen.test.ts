/**
 * D105: the way in unseen. The arrival card's `card.unseen` side becomes `markUnseen` with that
 * side's plan, checked by the kernel's own rules so the real kernel accepts whatever passes, and is
 * dropped with a reason anywhere else; the card's prose never depends on it.
 */
import {
  type DecisionId,
  type SaveEnvelope,
  type SimEvent,
  createKernel,
  createRegistry,
  planMenu,
  registerExpedition,
  registerSpatial,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import type { NarratorPlan, NarratorRequest, TranslationCtx } from "./contract";
import { buildDigest } from "./digest";
import {
  departureGateRequest,
  passengerOverdueRequest,
  quietTooLongRequest,
  siteArrivalRequest,
  siteItemArrivalRequest,
} from "./fixtures";
import { applyDecisionEvents } from "./history";
import { type CardShown, EMPTY_NOTES, parseNotes } from "./notes";
import { content, emptyPlan } from "./test-support";
import { translateIntents } from "./translate";

type Side = "" | "left" | "right";

function ctxOf(req: NarratorRequest): TranslationCtx {
  return {
    snapshot: req.snapshot,
    content: content(),
    hookTick: req.hook.tick,
    callId: "call-unseen",
    hook: req.hook,
  };
}

/** A dressed arrival card with `unseen` on `side`, at `unseenOdds` (and any prose changed). */
function cardPlan(
  unseen: Side,
  unseenOdds = "",
  prose: Partial<NonNullable<NarratorPlan["card"]>> = {},
): NarratorPlan {
  return emptyPlan({
    card: {
      title: "The silo yard",
      speaker: "Dane Whitcross",
      situation:
        "Dane, at the ramp head: “Three of them by the weigh-house, and a gleaner off in the grain. The back lane runs behind it all. Your call, Captain.”",
      leftLabel: "Keep low and quiet",
      rightLabel: "Straight at them",
      leftAftermath: "We go along the back lane, nobody fires first.",
      rightAftermath: "We go in fast across the yard.",
      unseen,
      unseenOdds,
      ...prose,
    },
  });
}

/** A copy of `req` to change. */
function copy(req: NarratorRequest): NarratorRequest & { snapshot: SaveEnvelope } {
  return { ...req, snapshot: structuredClone(req.snapshot) as SaveEnvelope };
}

function arrivalOf(req: NarratorRequest) {
  const id = req.snapshot.state.expedition?.cards?.arrival;
  const card = id === undefined ? undefined : req.snapshot.state.decisions.records[id];
  if (id === undefined || card === undefined) throw new Error("no arrival card");
  return { id, params: card.prompt.params };
}

/** The prompt params of card `id` in a copied snapshot, to change. */
function mutableParams(
  req: NarratorRequest & { snapshot: SaveEnvelope },
  id: DecisionId,
): Record<string, string | number> | undefined {
  return req.snapshot.state.decisions.records[id]?.prompt.params as
    | Record<string, string | number>
    | undefined;
}

const unseenDrops = (result: ReturnType<typeof translateIntents>) =>
  result.dropped.filter((d) => d.reason.startsWith("card.unseen"));

describe("translateIntents: the way in unseen (D105)", () => {
  it('unseen "left" on the item arrival card → markUnseen with the left plan, at the tick after the hook', () => {
    const req = siteItemArrivalRequest(content());
    const { id, params } = arrivalOf(req);
    expect(params.leftPlan).toBe("creep-holdFire-armed");
    const result = translateIntents(cardPlan("left"), ctxOf(req));
    expect(result.dropped).toEqual([]);
    expect(result.commands).toEqual([
      {
        id: "cmd:narrator:call-unseen:0",
        source: "narrator",
        targetTick: req.hook.tick + 1,
        kind: "markUnseen",
        // §unseen-odds: no number named is D105's certain mark.
        payload: { decisionId: id, planId: "creep-holdFire-armed", odds: 100 },
      },
    ]);
  });

  it('unseen "right" → the right plan: going in hard can be the way in unseen (an ambush)', () => {
    const req = siteArrivalRequest(content());
    const { params } = arrivalOf(req);
    const result = translateIntents(cardPlan("right"), ctxOf(req));
    expect(result.dropped).toEqual([]);
    expect(result.commands.map((c) => c.payload)).toEqual([
      { decisionId: arrivalOf(req).id, planId: params.rightPlan, odds: 100 },
    ]);
  });

  it("drops a side that holds the ramp, with the reason", () => {
    // The person errand's card: left holds the ramp, right goes in. Swapped, right is the hold.
    const req = copy(siteArrivalRequest(content()));
    const { id } = arrivalOf(req);
    const params = mutableParams(req, id);
    const { leftPlan, rightPlan } = params ?? {};
    if (params === undefined || leftPlan === undefined || rightPlan === undefined) {
      throw new Error("no plans on the card");
    }
    params.leftPlan = rightPlan;
    params.rightPlan = leftPlan;
    expect(params.rightPlan).toBe("hold-lethal-armed");
    const result = translateIntents(cardPlan("right"), ctxOf(req));
    expect(result.commands).toEqual([]);
    expect(result.dropped).toEqual([
      {
        intentIndex: -1,
        kind: "card",
        reason: 'card.unseen "right": that side holds the ramp; holding the ramp never goes unseen',
      },
    ]);
    // The unswapped card's left is the same hold plan.
    const left = translateIntents(cardPlan("left"), ctxOf(siteArrivalRequest(content())));
    expect(left.commands).toEqual([]);
    expect(unseenDrops(left)).toHaveLength(1);
  });

  it.each([
    ["the departure-gate card", departureGateRequest],
    ["the overdue-passenger card", passengerOverdueRequest],
  ])("drops a side on %s: only the arrival card has a way in unseen", (_name, fixture) => {
    const req = fixture(content());
    const result = translateIntents(cardPlan("left"), ctxOf(req));
    expect(result.commands.filter((c) => c.kind === "markUnseen")).toEqual([]);
    expect(unseenDrops(result).map((d) => d.reason)).toEqual([
      'card.unseen "left": only the arrival card at a site has a way in unseen',
    ]);
    expect(result.card).toBeDefined();
  });

  it("drops a side on a call that is not a policy decision", () => {
    const result = translateIntents(cardPlan("left"), ctxOf(quietTooLongRequest(content())));
    expect(result.commands).toEqual([]);
    expect(unseenDrops(result)).toHaveLength(1);
  });

  it('"" marks nothing and drops nothing', () => {
    const result = translateIntents(cardPlan(""), ctxOf(siteItemArrivalRequest(content())));
    expect(result.commands).toEqual([]);
    expect(result.dropped).toEqual([]);
    expect(result.card).toBeDefined();
  });

  it("leaves the card's prose as it is: the same card with or without a side marked", () => {
    const req = siteItemArrivalRequest(content());
    const marked = translateIntents(cardPlan("left"), ctxOf(req));
    const unmarked = translateIntents(cardPlan(""), ctxOf(req));
    expect(marked.card).toEqual(unmarked.card);
    expect(marked.card?.leftLabel).toBe("Keep low and quiet");
  });

  it("drops a side once the plan is chosen, once a side is marked, or when the card names no plan for it", () => {
    const chosen = copy(siteItemArrivalRequest(content()));
    const state = chosen.snapshot.state;
    const expedition = state.expedition;
    if (expedition === undefined) throw new Error("no expedition");
    const creep = planMenu(state, content(), chosen.snapshot.config).find(
      (o) => o.id === "creep-holdFire-armed",
    );
    if (creep === undefined) throw new Error("no creep plan");
    expedition.plan = creep.plan;
    expect(unseenDrops(translateIntents(cardPlan("left"), ctxOf(chosen)))[0]?.reason).toBe(
      'card.unseen "left": the captain has already chosen the plan',
    );

    const marked = copy(siteItemArrivalRequest(content()));
    if (marked.snapshot.state.expedition === undefined) throw new Error("no expedition");
    marked.snapshot.state.expedition.unseenPlanId = "creep-holdFire-armed";
    expect(unseenDrops(translateIntents(cardPlan("right"), ctxOf(marked)))[0]?.reason).toBe(
      'card.unseen "right": a side is already marked unseen',
    );

    const bare = copy(siteItemArrivalRequest(content()));
    const params = mutableParams(bare, arrivalOf(bare).id);
    if (params === undefined) throw new Error("no params");
    // biome-ignore lint/performance/noDelete: the card must lack the param, not hold undefined.
    delete params.leftPlan;
    expect(unseenDrops(translateIntents(cardPlan("left"), ctxOf(bare)))[0]?.reason).toBe(
      'card.unseen "left": the card names no plan for its left side',
    );
  });

  it("drops a side on an arrival card that is no longer pending", () => {
    const req = copy(siteItemArrivalRequest(content()));
    const record = req.snapshot.state.decisions.records[arrivalOf(req).id as DecisionId];
    if (record === undefined) throw new Error("no card");
    record.status = "resolved";
    expect(unseenDrops(translateIntents(cardPlan("left"), ctxOf(req)))[0]?.reason).toBe(
      'card.unseen "left": the arrival card is no longer pending',
    );
  });

  it("the real kernel accepts the translated mark and writes it on the expedition", () => {
    const bundle = content();
    const req = siteItemArrivalRequest(bundle);
    const [command] = translateIntents(cardPlan("left", "100"), ctxOf(req)).commands;
    if (command === undefined) throw new Error("no command");
    const registry = createRegistry();
    registerSpatial(registry);
    registerExpedition(registry);
    const kernel = createKernel(registry);
    const world = kernel.restore(structuredClone(req.snapshot) as SaveEnvelope, bundle);
    expect(kernel.enqueueCommand(world, command).status).toBe("accepted");
    // The host's order at the hook: the narrator's commands, the acknowledgement, then the
    // captain's answer; the world halts on the card until then.
    const hookId = world.state.narrator.pendingHook?.id;
    if (hookId === undefined) throw new Error("no hook");
    const targetTick = world.state.tick + 1;
    const host = [
      { source: "system", kind: "acknowledgeHook", payload: { hookId } },
      {
        source: "player",
        kind: "resolveDecision",
        payload: { decisionId: arrivalOf(req).id, side: "left" },
      },
    ] as const;
    host.forEach((c, n) => {
      const sent = kernel.enqueueCommand(world, { id: `cmd:test:${n}`, targetTick, ...c } as never);
      expect(sent.status).toBe("accepted");
    });
    kernel.advance(world, 1);
    expect(world.state.expedition?.unseenPlanId).toBe("creep-holdFire-armed");
    expect(world.state.expedition?.notice).toBe("unseen");
    expect(world.state.expedition?.unseenRoll).toEqual({ odds: 100, worked: true });
  });
});

describe("translateIntents: the odds on the way in unseen (§unseen-odds)", () => {
  const marks = (result: ReturnType<typeof translateIntents>) =>
    result.commands.flatMap((c) => (c.kind === "markUnseen" ? [c.payload] : []));
  const cardDrops = (result: ReturnType<typeof translateIntents>) =>
    result.dropped.filter((d) => d.kind === "card").map((d) => d.reason);

  it("carries the narrator's whole percent on the mark, unclamped from 0 to 100", () => {
    const req = siteItemArrivalRequest(content());
    for (const [written, odds] of [
      ["70", 70],
      [" 5 ", 5],
      ["0", 0],
      ["100", 100],
      ["", 100],
    ] as const) {
      const result = translateIntents(cardPlan("left", written), ctxOf(req));
      expect(result.dropped).toEqual([]);
      expect(marks(result)).toEqual([
        { decisionId: arrivalOf(req).id, planId: "creep-holdFire-armed", odds },
      ]);
    }
  });

  it.each(["seventy", "101", "-5", "50.5", "70%", "007"])(
    'drops a mark whose odds "%s" are not a whole percent, with the reason',
    (written) => {
      const result = translateIntents(
        cardPlan("left", written),
        ctxOf(siteItemArrivalRequest(content())),
      );
      expect(marks(result)).toEqual([]);
      expect(unseenDrops(result).map((d) => d.reason)).toEqual([
        `card.unseen "left": unseenOdds "${written}" is not a whole percent from 0 to 100`,
      ]);
    },
  );

  it("tells the narrator when it gave odds with no side marked", () => {
    const result = translateIntents(cardPlan("", "40"), ctxOf(siteItemArrivalRequest(content())));
    expect(marks(result)).toEqual([]);
    expect(cardDrops(result)).toEqual([
      'card.unseenOdds "40": no side is marked unseen (card.unseen is empty)',
    ]);
  });

  it("lets the situation and the marked side's label state the chance, and only that number", () => {
    const req = siteItemArrivalRequest(content());
    const scientist = {
      situation: "Dane, at the ramp head: “Captain, I estimate 70% odds the back lane is clear.”",
      leftLabel: "The back lane, 70 percent",
    };
    const stated = translateIntents(cardPlan("left", "70", scientist), ctxOf(req));
    expect(cardDrops(stated)).toEqual([]);
    expect(stated.card?.situation).toBe(scientist.situation);
    expect(stated.card?.leftLabel).toBe(scientist.leftLabel);

    // A different number, a number with no mark, a number on the other side, or any other
    // numeric consequence beside the chance: refused, the template card instead.
    const refused = [
      cardPlan("left", "60", scientist),
      cardPlan("", "", scientist),
      cardPlan("left", "70", { rightLabel: "Straight at them, 70%" }),
      cardPlan("left", "70", { situation: "70% odds, and they pay 200 credits for it." }),
      cardPlan("left", "70", { situation: "70% odds, +70% if it rains." }),
      cardPlan("left", "70", { leftAftermath: "We go in, 70% we are not seen." }),
    ];
    for (const plan of refused) {
      const result = translateIntents(plan, ctxOf(req));
      expect(result.card?.leftLabel).not.toBe(scientist.leftLabel);
      expect(cardDrops(result)).toContain("card: player-facing text states a numeric consequence");
    }
  });

  it("still drops a mark on a side that holds the ramp, and then exempts no number", () => {
    const req = siteArrivalRequest(content());
    expect(arrivalOf(req).params.leftPlan).toBe("hold-lethal-armed");
    const result = translateIntents(
      cardPlan("left", "70", { situation: "I make it 70% they never see us at the ramp." }),
      ctxOf(req),
    );
    expect(marks(result)).toEqual([]);
    expect(cardDrops(result)).toEqual([
      'card.unseen "left": that side holds the ramp; holding the ramp never goes unseen',
      "card: player-facing text states a numeric consequence",
    ]);
  });
});

describe("card history: the roll on the way in unseen (§unseen-odds, §card-history)", () => {
  /** The item arrival card resolved for the marked creep side, the roll in the snapshot. */
  function rolled(worked: boolean) {
    const req = copy(siteItemArrivalRequest(content()));
    const { id } = arrivalOf(req);
    const state = req.snapshot.state;
    const record = state.decisions.records[id as DecisionId];
    const expedition = state.expedition;
    if (record === undefined || expedition === undefined) throw new Error("no card");
    record.status = "resolved";
    record.chosen = "left";
    expedition.unseenPlanId = "creep-holdFire-armed";
    expedition.unseenOdds = 70;
    expedition.unseenRoll = { odds: 70, worked };
    const entry: CardShown = {
      tick: req.hook.tick,
      decisionId: id,
      title: "The silo yard",
      speaker: "Dane Whitcross",
      gist: "Three of them by the weigh-house.",
      leftLabel: "Keep low and quiet",
      rightLabel: "Straight at them",
      chosen: "left",
      closedThread: null,
    };
    const event = {
      id: "e:1",
      tick: req.hook.tick + 1,
      seq: 0,
      type: "unseenRolled",
      significance: "notable",
      subjectIds: [id],
      causeIds: [],
      source: "player",
      payload: {
        siteId: expedition.siteId,
        decisionId: id,
        planId: "creep-holdFire-armed",
        odds: 70,
        worked,
      },
    } as unknown as SimEvent;
    return { req, id, entry, event };
  }

  it("records the roll on the arrival card's entry from the kernel's event", () => {
    const { req, entry, event } = rolled(false);
    // Take the roll off the snapshot, so only the event can put it there.
    // biome-ignore lint/performance/noDelete: the snapshot must lack the roll, not hold undefined.
    delete req.snapshot.state.expedition?.unseenRoll;
    const [card] = applyDecisionEvents([entry], [event], req.snapshot.state, content());
    expect(card?.tried).toEqual({ odds: 70, worked: false });
  });

  it("fills the roll in from the snapshot when its event was lost", () => {
    const { req, entry } = rolled(true);
    const [card] = applyDecisionEvents([entry], [], req.snapshot.state, content());
    expect(card?.tried).toEqual({ odds: 70, worked: true });
  });

  it("puts no roll on any other card", () => {
    const { req, entry } = rolled(true);
    const other = { ...entry, decisionId: "decision:other", title: "Another card" };
    const cards = applyDecisionEvents([other], [], req.snapshot.state, content());
    expect(cards[0]).not.toHaveProperty("tried");
  });

  it("shows the digest the odds and how it went after the choice, and keeps it in the stored notes", () => {
    const { req, entry } = rolled(false);
    const notes = {
      ...EMPTY_NOTES,
      cardsShown: [{ ...entry, tried: { odds: 70, worked: false } }],
    };
    const hook = quietTooLongRequest(content()).hook;
    const { text } = buildDigest(req.snapshot, [], notes, content(), hook);
    expect(text).toContain(
      '"The silo yard" (Dane Whitcross): Three of them by the weigh-house. → chose "Keep low and quiet" (the way in unseen, 70%): it failed, they were waiting',
    );
    const worked = { ...notes, cardsShown: [{ ...entry, tried: { odds: 70, worked: true } }] };
    expect(buildDigest(req.snapshot, [], worked, content(), hook).text).toContain(
      '→ chose "Keep low and quiet" (the way in unseen, 70%): it worked, they got in unseen',
    );
    const stored = parseNotes(JSON.parse(JSON.stringify(notes)));
    expect(stored.cardsShown[0]?.tried).toEqual({ odds: 70, worked: false });
    const old = parseNotes(JSON.parse(JSON.stringify({ ...notes, cardsShown: [entry] })));
    expect(old.cardsShown[0]).not.toHaveProperty("tried");
  });
});
