/**
 * §money-levers (D106): the narrator's `transact`, a sum into or out of the ship's money with a
 * line on the ledger (`MoneyState.transactions`, reason `narrator`) and a `transacted` event. Valid
 * for a non-zero whole number of credits whose debit the balance covers and whose credit is at most
 * `config.narrator.maxWindfall`, with a `memo` and a `counterparty` of at most `TRANSACT_TEXT_MAX`
 * characters each (the memo required, the counterparty empty for nobody in particular).
 */
import {
  type CommandHandler,
  NO_TEMP_REFS,
  type ValidateCtx,
  causedBy,
  ok,
  reject,
} from "../../core/commands";
import { allocateId } from "../../core/ids";
import type { CommandOfKind, CommandRejection } from "../../core/types/commands";
import { TRANSACT_TEXT_MAX } from "../../core/types/decisions";

/** Why `transact` cannot go through, or undefined. */
function transactProblem(
  ctx: ValidateCtx,
  command: CommandOfKind<"transact">,
): CommandRejection | undefined {
  const { amount, memo, counterparty } = command.payload;
  const invalid = (reason: string): CommandRejection => ({ code: "invalidPayload", reason });
  if (!Number.isInteger(amount) || amount === 0) {
    return invalid("amount must be a non-zero whole number of credits");
  }
  if (typeof memo !== "string" || memo.trim() === "") return invalid("memo says what it is for");
  if (typeof counterparty !== "string") return invalid("counterparty must be a string");
  if (memo.length > TRANSACT_TEXT_MAX || counterparty.length > TRANSACT_TEXT_MAX) {
    return invalid(`memo and counterparty are at most ${TRANSACT_TEXT_MAX} characters`);
  }
  const balance = ctx.state.money.balance;
  if (amount < 0 && balance + amount < 0) {
    return {
      code: "outOfBounds",
      reason: `the ship has ${balance} credits and cannot pay ${-amount}`,
    };
  }
  const max = ctx.config.narrator.maxWindfall;
  if (amount > max) {
    return {
      code: "outOfBounds",
      reason: `a credit of ${amount} is over the windfall cap of ${max}`,
    };
  }
  return undefined;
}

export const transact: CommandHandler<"transact", null> = {
  validate(ctx, command) {
    const problem = transactProblem(ctx, command);
    return problem === undefined ? ok(null) : reject(problem.code, `transact: ${problem.reason}`);
  },
  apply(ctx, command) {
    const { amount, memo, counterparty } = command.payload;
    const transactionId = allocateId(ctx.state, "transaction");
    ctx.state.money.balance += amount;
    ctx.state.money.transactions[transactionId] = {
      id: transactionId,
      tick: ctx.tick,
      amount,
      reason: "narrator",
      memo: memo.trim(),
      counterparty: counterparty.trim(),
    };
    ctx.emit({
      ...causedBy(command),
      type: "transacted",
      subjectIds: [],
      payload: { transactionId, amount, memo: memo.trim(), counterparty: counterparty.trim() },
    });
    return NO_TEMP_REFS;
  },
};
