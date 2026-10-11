/**
 * D105: the way in unseen. The arrival card's `card.unseen` side becomes `markUnseen` with that
 * side's plan, checked by the kernel's own rules so the real kernel accepts whatever passes, and is
 * dropped with a reason anywhere else; the card's prose never depends on it.
 */
import {
  type DecisionId,
  type SaveEnvelope,
  createKernel,
  createRegistry,
  planMenu,
  registerExpedition,
  registerSpatial,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import type { NarratorPlan, NarratorRequest, TranslationCtx } from "./contract";
import {
  departureGateRequest,
  passengerOverdueRequest,
  quietTooLongRequest,
  siteArrivalRequest,
  siteItemArrivalRequest,
} from "./fixtures";
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

/** A dressed arrival card with `unseen` on `side`. */
function cardPlan(unseen: Side): NarratorPlan {
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
        payload: { decisionId: id, planId: "creep-holdFire-armed" },
      },
    ]);
  });

  it('unseen "right" → the right plan: going in hard can be the way in unseen (an ambush)', () => {
    const req = siteArrivalRequest(content());
    const { params } = arrivalOf(req);
    const result = translateIntents(cardPlan("right"), ctxOf(req));
    expect(result.dropped).toEqual([]);
    expect(result.commands.map((c) => c.payload)).toEqual([
      { decisionId: arrivalOf(req).id, planId: params.rightPlan },
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
    const [command] = translateIntents(cardPlan("left"), ctxOf(req)).commands;
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
  });
});
