/**
 * D105 gate: the narrator's mark on the arrival card (`markUnseen`), what `adoptPlan` makes of it
 * (`Expedition.notice`), the plan menu and the arrival pair for a `fetchItem` errand, and the
 * notice on `expeditionResolved`. On the kernel's test site (`fixtures/landing.ts`).
 */
import { describe, expect, it } from "vitest";
import type { TestWorld } from "../../core/fixtures/test-world";
import type { EnqueueResult } from "../../core/types/commands";
import type { Decision } from "../../core/types/decisions";
import type { SimEvent } from "../../core/types/events";
import type { DecisionId } from "../../core/types/ids";
import type { ErrandKind } from "../../core/types/travel";
import { PLAN_MENU_SIZE, planMenu } from "../../view/planMenu";
import { CREW } from "../work/fixtures/crew-deck";
import { startExpedition, violations } from "./fixtures/fight";
import {
  type LandingWorld,
  acknowledge,
  answer,
  flyToSite,
  landingWorld,
  sendAs,
  step,
} from "./fixtures/landing";
import { SITE, siteWorld } from "./fixtures/site";

const RATE = 20;

/** Set down for an errand of `kind`: the arrival card queued, its hook raised, not acknowledged. */
function landed(kind: ErrandKind = "fetchPerson"): LandingWorld {
  const test = landingWorld({ scenario: CREW.scenario8, kind });
  flyToSite(test);
  test.kernel.advance(test.world, 1);
  expect(violations(test)).toEqual([]);
  return test;
}

function arrival(test: TestWorld): Decision {
  const id = test.world.state.expedition?.cards?.arrival;
  const record = id === undefined ? undefined : test.world.state.decisions.records[id];
  if (record === undefined) throw new Error("no arrival card");
  return record;
}

function mark(
  test: TestWorld,
  planId: string,
  decisionId: DecisionId = arrival(test).id,
  source: "narrator" | "scenario" | "player" = "narrator",
): EnqueueResult {
  return sendAs(test, { source, kind: "markUnseen", payload: { decisionId, planId } });
}

const refusal = (result: EnqueueResult) =>
  result.status === "rejected" ? result.rejection : undefined;

/**
 * The host's order at the hook: the narrator's commands, then the acknowledgement; the world halts
 * on the card, and what was queued applies with the captain's answer, `side`. Returns that tick's
 * events.
 */
function choose(test: TestWorld, side: "left" | "right"): readonly SimEvent[] {
  acknowledge(test);
  const answered = answer(test, arrival(test).id, side);
  if (answered.status !== "accepted") throw new Error(`refused: ${JSON.stringify(answered)}`);
  return test.kernel.advance(test.world, 1).events;
}

const rejectedMarks = (events: readonly SimEvent[]) =>
  events.flatMap((e) =>
    e.type === "commandRejected" && e.payload.kind === "markUnseen" ? [e.payload.rejection] : [],
  );

describe("markUnseen (D105)", () => {
  it("is taken for a side of the pending arrival card, from the narrator or the scenario", () => {
    const test = landed();
    expect(mark(test, "assault-lethal-armed").status).toBe("accepted");
    expect(mark(landed(), "assault-lethal-armed", undefined, "scenario").status).toBe("accepted");
    expect(refusal(mark(landed(), "assault-lethal-armed", undefined, "player"))?.code).toBe(
      "unauthorized",
    );
    const events = choose(test, "right");
    expect(rejectedMarks(events)).toEqual([]);
    expect(test.world.state.expedition).toMatchObject({
      unseenPlanId: "assault-lethal-armed",
      notice: "unseen",
    });
  });

  it("is refused for an expedition with no arrival card, and for another decision", () => {
    const test = siteWorld({ scenario: CREW.scenario8 });
    startExpedition(test, undefined);
    test.kernel.advance(test.world, 1);
    expect(refusal(mark(test, "assault-lethal-armed", "d.nothing" as DecisionId))?.reason).toMatch(
      /has no arrival card/,
    );
    const landedTest = landed();
    const other = mark(landedTest, "assault-lethal-armed", "d.other" as DecisionId);
    expect(refusal(other)?.reason).toMatch(/is not the expedition's arrival card/);
  });

  it("is refused for a plan not on the card, and for a hold side", () => {
    const test = landed();
    const card = arrival(test);
    expect(card.prompt.params).toMatchObject({
      leftPlan: "hold-lethal-armed",
      rightPlan: "assault-lethal-armed",
    });
    const offCard = refusal(mark(test, "flank-lethal-armed"));
    expect(offCard?.code).toBe("preconditionFailed");
    expect(offCard?.reason).toMatch(/is not a side of the arrival card/);
    expect(refusal(mark(test, "hold-lethal-armed"))?.reason).toMatch(/holds the ramp/);
    expect(refusal(mark(test, ""))?.reason).toMatch(/is not a side/);
  });

  it("is refused once the plan is adopted, and a second mark never lands", () => {
    const test = landed();
    expect(mark(test, "assault-lethal-armed").status).toBe("accepted");
    // Valid when queued (nothing is marked yet), refused when the kernel revalidates it at apply.
    expect(mark(test, "assault-lethal-armed").status).toBe("accepted");
    const events = choose(test, "left");
    expect(rejectedMarks(events).map((r) => r.reason)).toEqual([
      'markUnseen: "assault-lethal-armed" is already marked unseen',
    ]);
    expect(refusal(mark(test, "assault-lethal-armed"))?.reason).toMatch(/the plan is already/);
  });
});

describe("adoptPlan writes the notice (D105)", () => {
  it("unseen for the marked side, seen for the other, nothing with no mark", () => {
    const marked = landed();
    mark(marked, "assault-lethal-armed");
    choose(marked, "left");
    expect(marked.world.state.expedition?.plan?.id).toBe("hold-lethal-armed");
    expect(marked.world.state.expedition?.notice).toBe("seen");

    const unmarked = landed();
    choose(unmarked, "right");
    const expedition = unmarked.world.state.expedition;
    expect(expedition?.plan?.id).toBe("assault-lethal-armed");
    expect(expedition).not.toHaveProperty("notice");
    expect(expedition).not.toHaveProperty("unseenPlanId");
  });

  it("puts the notice on expeditionResolved, and nothing when no side was marked", () => {
    const resolvedEvent = (test: TestWorld): SimEvent | undefined => {
      const events: SimEvent[] = [];
      const done = () => test.world.state.expedition?.phase === "resolved";
      const end = test.world.state.tick + 300 * RATE;
      while (!done() && test.world.state.tick < end) {
        events.push(...step(test, end - test.world.state.tick, done, false));
        const head = test.world.state.decisions.queue[0];
        if (head !== undefined) answer(test, head, "left");
      }
      return events.find((e) => e.type === "expeditionResolved");
    };
    const marked = landed();
    mark(marked, "assault-lethal-armed");
    choose(marked, "right");
    expect(resolvedEvent(marked)?.payload).toMatchObject({ notice: "unseen" });

    const unmarked = landed();
    choose(unmarked, "right");
    expect(resolvedEvent(unmarked)?.payload).not.toHaveProperty("notice");
  });
});

describe("a fetchItem errand's plans (D105)", () => {
  it("offers creep holding fire or going in, both for the item, and the narrator may mark creep", () => {
    const test = landed("fetchItem");
    const menu = planMenu(test.world.state, test.world.content, test.world.config.values);
    expect(menu.length).toBeLessThanOrEqual(PLAN_MENU_SIZE);
    expect(menu.slice(0, 2).map((o) => o.id)).toEqual([
      "creep-holdFire-armed",
      "assault-lethal-armed",
    ]);
    expect(new Set(menu.map((o) => o.plan.objective))).toEqual(new Set(["takeItem"]));
    expect(arrival(test).prompt.params).toMatchObject({
      kind: "fetchItem",
      leftPlan: "creep-holdFire-armed",
      rightPlan: "assault-lethal-armed",
    });
    expect(mark(test, "creep-holdFire-armed").status).toBe("accepted");
    choose(test, "left");
    expect(test.world.state.expedition?.plan).toMatchObject({
      id: "creep-holdFire-armed",
      objective: "takeItem",
    });
    expect(test.world.state.expedition?.notice).toBe("unseen");
  });

  it("leaves the menu as it was for a person, with no errand, and once the expedition is over", () => {
    const person = landed("fetchPerson");
    const personMenu = planMenu(
      person.world.state,
      person.world.content,
      person.world.config.values,
    );
    expect(personMenu.slice(0, 2).map((o) => o.id)).toEqual([
      "hold-lethal-armed",
      "assault-lethal-armed",
    ]);
    expect(new Set(personMenu.map((o) => o.plan.objective))).toEqual(new Set(["takeTarget"]));
    expect(arrival(person).prompt.params.kind).toBe("fetchPerson");

    // The same world with the errand taken off the expedition: the menu is the very same.
    const expedition = person.world.state.expedition;
    if (expedition === undefined) throw new Error("no expedition");
    const { jobId: _jobId, ...withoutErrand } = expedition;
    person.world.state.expedition = withoutErrand;
    expect(planMenu(person.world.state, person.world.content, person.world.config.values)).toEqual(
      personMenu,
    );

    const none = siteWorld({ scenario: CREW.scenario8 });
    const noErrand = planMenu(
      none.world.state,
      none.world.content,
      none.world.config.values,
      SITE.port,
    );
    expect(noErrand.slice(0, 2).map((o) => o.id)).toEqual([
      "hold-lethal-armed",
      "assault-lethal-armed",
    ]);
    expect(new Set(noErrand.map((o) => o.plan.objective))).toEqual(new Set(["takeTarget"]));

    // A resolved fetchItem leaves no errand behind for the next start's menu.
    const item = landed("fetchItem");
    const over = item.world.state.expedition;
    if (over === undefined) throw new Error("no expedition");
    over.phase = "resolved";
    const after = planMenu(item.world.state, item.world.content, item.world.config.values);
    expect(after.slice(0, 2).map((o) => o.id)).toEqual([
      "hold-lethal-armed",
      "assault-lethal-armed",
    ]);
    expect(new Set(after.map((o) => o.plan.objective))).toEqual(new Set(["takeTarget"]));
  });
});
