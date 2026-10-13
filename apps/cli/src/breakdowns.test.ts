/**
 * Breakdowns beyond the engine room on the real content (§authored-faults): each new fault,
 * injected, does what its effect says within a second of sim time. Whether the crew find and fix
 * it is `breakdowns.deep.test.ts`.
 */
import {
  type CommandId,
  type Kernel,
  type LocalKey,
  type MachineId,
  type World,
  createKernel,
} from "@crew/sim";
import { describe, expect, it } from "vitest";
import { createPacingRegistry, loadPacingContent } from "./pacing";

/** A fresh real-content world with `faultKey` injected on the `defId` machine. */
function worldWithFault(
  defId: string,
  faultKey: string,
): { kernel: Kernel; world: World; machineId: MachineId } {
  const { bundle, config, scenarioId } = loadPacingContent();
  const kernel = createKernel(createPacingRegistry());
  const world = kernel.createWorld(scenarioId, 1, bundle, config);
  const machine = Object.values(world.state.machines).find((m) => m.defId === defId);
  if (machine === undefined) throw new Error(`no ${defId} aboard`);
  const result = kernel.enqueueCommand(world, {
    id: "cmd:breakdowns:1" as CommandId,
    source: "scenario",
    kind: "scenarioInjectFault",
    payload: { machineId: machine.id, faultKey: faultKey as LocalKey },
  });
  if (result.status !== "accepted") throw new Error(JSON.stringify(result));
  return { kernel, world, machineId: machine.id };
}

describe("the new faults' effects on the real content (§authored-faults)", () => {
  it.each([
    ["machine.life_support", "scrubber_clog", 0.7],
    ["machine.battery_bank", "cell_degradation", 0.5],
    ["machine.galley_stove", "burner_fault", 0],
    ["machine.nav_terminal", "chart_fault", 0],
  ])("%s's %s leaves it at output %d", (defId, faultKey, output) => {
    const { kernel, world, machineId } = worldWithFault(defId, faultKey);
    const before = world.state.machines[machineId]?.output;
    expect(before).toBe(1);
    kernel.advance(world, world.config.values.time.tickRate);
    const machine = world.state.machines[machineId];
    expect(machine?.faults.map((f) => f.faultKey)).toEqual([faultKey]);
    expect(machine?.output).toBeCloseTo(output, 6);
    if (output === 0) expect(machine?.actualMode).toBe("off");
  });
});
