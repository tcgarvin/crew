/**
 * `scheduleFault` command handler (D6, docs/CONTRACTS.md `EquipmentCommandPayloads`). Already
 * authorized for `narrator` and `scenario` in `core/types/commands/authority.ts` (W2); this file
 * only supplies the validate/apply behaviour and registers it.
 */
import { configTicks } from "../../core/clock";
import { type CommandHandler, NO_TEMP_REFS, ok, reject } from "../../core/commands";
import type { KernelRegistry } from "../../core/registry";

const scheduleFault: CommandHandler<"scheduleFault", null> = {
  validate(ctx, command) {
    const { machineId, faultKey, windowTicks } = command.payload;
    const machine = ctx.state.machines[machineId];
    if (machine === undefined) return reject("unknownEntity", `unknown machine "${machineId}"`);
    const def = ctx.content.machines[machine.defId];
    if (def === undefined || !def.faults.some((f) => f.key === faultKey)) {
      return reject("invalidPayload", `machine "${machineId}" has no fault "${faultKey}"`);
    }
    const [earliest, latest] = windowTicks;
    if (
      !Number.isInteger(earliest) ||
      !Number.isInteger(latest) ||
      earliest < 0 ||
      latest < earliest
    ) {
      return reject(
        "invalidPayload",
        "windowTicks must be [earliest, latest] with 0 <= earliest <= latest",
      );
    }
    const maxWindow = configTicks(ctx.config, ctx.config.narrator.maxFaultWindowSeconds);
    if (latest - earliest > maxWindow) {
      return reject("outOfBounds", `window ${latest - earliest} ticks exceeds max ${maxWindow}`);
    }
    return ok(null);
  },
  apply(ctx, command) {
    const { machineId, faultKey, windowTicks } = command.payload;
    const machine = ctx.state.machines[machineId];
    if (machine === undefined) throw new Error(`validated machine ${machineId} vanished`);
    const [earliest, latest] = windowTicks;
    const fireAtTick = ctx.rng.int("failures", ctx.tick + earliest, ctx.tick + latest);
    machine.scheduledFaults = [
      ...machine.scheduledFaults,
      { faultKey, fireAtTick, causeCommandId: command.id },
    ];
    // §narrator-lever-budgets: spent here and refilled every `budgetRefillDays`; advice the digest
    // shows, never a refusal, so it may go below zero.
    ctx.state.narrator.budget.faultsRemaining -= 1;
    return NO_TEMP_REFS;
  },
};

export function registerEquipmentCommandHandlers(registry: KernelRegistry): void {
  registry.registerCommandHandler("scheduleFault", scheduleFault);
}
