/**
 * §forced-faults-and-hazards, §thought-and-reveal-levers (D106): the narrator's `injectFault` and
 * `reveal` on the W5 fixture (an engine with a `wornBearing` fault whose symptom is audible, and
 * Tess Okafor, the engineer).
 */
import { describe, expect, it } from "vitest";
import { cmd } from "../../core/fixtures/test-world";
import { checkInvariants } from "../../core/invariants";
import { tickerLine } from "../../core/render";
import type { CommandPayloadMap, EnqueueResult } from "../../core/types/commands";
import type { SimEvent } from "../../core/types/events";
import type { LocalKey, MachineId } from "../../core/types/ids";
import type { Machine } from "../../core/types/ship";
import { type W5TestWorld, w5TestWorld } from "./fixtures/test-world";
import { W5 } from "./fixtures/w5-content";

function engineOf(test: W5TestWorld): Machine {
  const machine = Object.values(test.world.state.machines).find((m) => m.defId === W5.engine);
  if (machine === undefined) throw new Error("no engine");
  return machine;
}

function send<K extends "injectFault" | "reveal">(
  test: W5TestWorld,
  kind: K,
  payload: CommandPayloadMap[K],
): { result: EnqueueResult; events: readonly SimEvent[] } {
  const result = test.kernel.enqueueCommand(
    test.world,
    cmd({ source: "narrator", kind, payload } as Parameters<typeof test.kernel.enqueueCommand>[1]),
  );
  const events = result.status === "accepted" ? test.kernel.advance(test.world, 1).events : [];
  return { result, events };
}

const reasonOf = (result: EnqueueResult) =>
  result.status === "rejected" ? result.rejection.reason : "accepted";

const bearing = (machine: Machine) => ({
  machineId: machine.id,
  faultKey: "wornBearing" as LocalKey,
});

function symptomProblem(test: W5TestWorld, machine: Machine) {
  return Object.values(test.world.state.work.problems).find(
    (p) => p.kind === "machineSymptom" && p.payload.machineId === machine.id,
  );
}

describe("injectFault (§forced-faults-and-hazards)", () => {
  it("breaks the machine now through the one fault path, opens its symptom problem and spends the fault budget", () => {
    const test = w5TestWorld();
    const engine = engineOf(test);
    const budget = test.world.state.narrator.budget.faultsRemaining;
    const { result, events } = send(test, "injectFault", bearing(engine));
    expect(result.status).toBe("accepted");
    expect(engineOf(test).faults.map((f) => f.faultKey)).toEqual(["wornBearing"]);
    const occurred = events.find((e) => e.type === "faultOccurred");
    expect(occurred?.causeIds).toHaveLength(1);
    // An audible symptom waits for someone to hear it.
    expect(symptomProblem(test, engine)?.visibility).toBe("discovered");
    expect(test.world.state.narrator.budget.faultsRemaining).toBe(budget - 1);
    expect(checkInvariants(test.world.state)).toEqual([]);
  });

  it("refuses a fault the machine already has or awaits, one not in its catalogue, and no machine", () => {
    const test = w5TestWorld();
    const engine = engineOf(test);
    send(test, "injectFault", bearing(engine));
    expect(reasonOf(send(test, "injectFault", bearing(engine)).result)).toContain(
      'already has or awaits "wornBearing"',
    );
    expect(
      reasonOf(
        send(test, "injectFault", { machineId: engine.id, faultKey: "notAFault" as LocalKey })
          .result,
      ),
    ).toContain('has no fault "notAFault"');
    expect(
      reasonOf(
        send(test, "injectFault", {
          machineId: "m999" as MachineId,
          faultKey: "wornBearing" as LocalKey,
        }).result,
      ),
    ).toContain('no machine "m999"');
  });

  it("is the narrator's and the scenario's, never the player's", () => {
    const test = w5TestWorld();
    const result = test.kernel.enqueueCommand(
      test.world,
      cmd({ source: "player", kind: "injectFault", payload: bearing(engineOf(test)) }),
    );
    expect(result.status === "rejected" && result.rejection.code).toBe("unauthorized");
  });
});

describe("reveal (§thought-and-reveal-levers)", () => {
  it("makes an undiscovered fault's symptom public and lets the engineer notice it, with the log's line", () => {
    const test = w5TestWorld();
    const engine = engineOf(test);
    send(test, "injectFault", bearing(engine));
    const { result, events } = send(test, "reveal", bearing(engine));
    expect(result.status).toBe("accepted");
    const problem = symptomProblem(test, engine);
    expect(problem?.visibility).toBe("public");
    const tess = Object.values(test.world.state.actors).find((a) => a.defId === W5.tech);
    if (tess === undefined || problem === undefined) throw new Error("no engineer or problem");
    expect(tess.knowledge[`${engine.id}/machineSymptom`]?.value).toEqual({
      symptomKey: "vibration",
    });
    expect(tess.knowledge[`${problem.id}/problem`]).toBeDefined();
    const observed = events.find((e) => e.type === "faultObserved");
    expect(observed?.subjectIds).toEqual([tess.id, engine.id]);
    const line =
      observed === undefined ? null : tickerLine(observed, test.world.state, test.world.content);
    expect(line).toMatch(/^Tess Okafor noticed vibration from the /);
    expect(checkInvariants(test.world.state)).toEqual([]);
  });

  it("refuses a fault the machine does not have now, and one already diagnosed", () => {
    const test = w5TestWorld();
    const engine = engineOf(test);
    expect(reasonOf(send(test, "reveal", bearing(engine)).result)).toContain(
      'does not have "wornBearing" now',
    );
    send(test, "injectFault", bearing(engine));
    const fault = engineOf(test).faults[0];
    if (fault === undefined) throw new Error("no fault");
    fault.diagnosed = true;
    expect(reasonOf(send(test, "reveal", bearing(engine)).result)).toContain("already diagnosed");
  });
});
