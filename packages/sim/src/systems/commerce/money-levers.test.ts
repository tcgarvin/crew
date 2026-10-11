/**
 * §money-levers (D106): the narrator's `transact` and an offer's named pay (`JobDraft.payNamed`),
 * on the freight fixture (docked at Alpha; the "general" band from Alpha to Beta is [50, 150] for
 * two crates).
 */
import { describe, expect, it } from "vitest";
import { cmd } from "../../core/fixtures/test-world";
import { tickerLine } from "../../core/render";
import type { CommandPayloadMap, CommandSource, EnqueueResult } from "../../core/types/commands";
import { FIX, PORTS, advanceThroughHooks, freightTestWorld } from "../travel/fixtures";

type Transact = CommandPayloadMap["transact"];

function transact(test: ReturnType<typeof freightTestWorld>, payload: Transact): EnqueueResult {
  return test.kernel.enqueueCommand(
    test.world,
    cmd({ source: "narrator", kind: "transact", payload }),
  );
}

const reasonOf = (result: EnqueueResult) =>
  result.status === "rejected" ? result.rejection.reason : "accepted";

describe("transact (§money-levers)", () => {
  it("pays out of the ship's money with a ledger line and a ticker line naming who was paid", () => {
    const test = freightTestWorld();
    const before = test.world.state.money.balance;
    expect(
      transact(test, { amount: -40, memo: "the gate fine", counterparty: "Osei" }).status,
    ).toBe("accepted");
    const { events } = test.kernel.advance(test.world, 1);
    expect(test.world.state.money.balance).toBe(before - 40);
    const line = Object.values(test.world.state.money.transactions).find(
      (t) => t.reason === "narrator",
    );
    expect(line).toMatchObject({ amount: -40, memo: "the gate fine", counterparty: "Osei" });
    const event = events.find((e) => e.type === "transacted");
    expect(event?.significance).toBe("narrative");
    expect(event?.causeIds).toHaveLength(1);
    expect(event && tickerLine(event, test.world.state, test.world.content)).toBe(
      "Paid Osei 40 cr: the gate fine",
    );
  });

  it("credits a windfall up to narrator.maxWindfall and refuses one above it", () => {
    const test = freightTestWorld();
    const max = test.world.config.values.narrator.maxWindfall;
    const before = test.world.state.money.balance;
    expect(transact(test, { amount: max, memo: "a reward", counterparty: "" }).status).toBe(
      "accepted",
    );
    advanceThroughHooks(test.kernel, test.world, 1);
    expect(test.world.state.money.balance).toBe(before + max);
    expect(reasonOf(transact(test, { amount: max + 1, memo: "more", counterparty: "" }))).toContain(
      "windfall cap",
    );
  });

  it("never overdraws: a debit the balance cannot cover is refused", () => {
    const test = freightTestWorld();
    const balance = test.world.state.money.balance;
    const over = transact(test, { amount: -(balance + 1), memo: "a bribe", counterparty: "" });
    expect(over).toMatchObject({ status: "rejected", rejection: { code: "outOfBounds" } });
    expect(reasonOf(over)).toContain("cannot pay");
    expect(transact(test, { amount: -balance, memo: "everything", counterparty: "" }).status).toBe(
      "accepted",
    );
  });

  it("refuses zero, a fraction and a missing memo", () => {
    const test = freightTestWorld();
    expect(reasonOf(transact(test, { amount: 0, memo: "x", counterparty: "" }))).toContain(
      "non-zero",
    );
    expect(reasonOf(transact(test, { amount: 2.5, memo: "x", counterparty: "" }))).toContain(
      "whole number",
    );
    expect(reasonOf(transact(test, { amount: 5, memo: " ", counterparty: "" }))).toContain("memo");
  });
});

describe("an offer's named pay (§money-levers)", () => {
  const draft = (pay: number) => ({
    issuer: "Test Shipper",
    description: { key: "test.job", params: {} },
    fromPortId: PORTS.a,
    toPortId: PORTS.b,
    cargo: [{ itemDefId: FIX.crate, count: 2 }],
    pay,
    payNamed: true as const,
  });
  const offer = (pay: number, source: CommandSource = "narrator") => {
    const test = freightTestWorld();
    const result = test.kernel.enqueueCommand(
      test.world,
      cmd({ source, kind: "offerJob", payload: { job: draft(pay), surface: false } } as never),
    );
    return { test, result };
  };

  it("stands outside the price band, at exactly the sum named", () => {
    const { test, result } = offer(800);
    expect(result.status).toBe("accepted");
    advanceThroughHooks(test.kernel, test.world, 1);
    const job = Object.values(test.world.state.jobs).find((j) => j.origin === "narrator");
    expect(job?.pay).toBe(800);
  });

  it("is refused above narrator.maxOfferPay, at zero, and from the system's job source", () => {
    const max = freightTestWorld().world.config.values.narrator.maxOfferPay;
    expect(reasonOf(offer(max + 1).result)).toContain("over the cap");
    expect(reasonOf(offer(0).result)).toContain("positive");
    expect(offer(800, "system").result).toMatchObject({
      status: "rejected",
      rejection: { code: "unauthorized" },
    });
  });
});
