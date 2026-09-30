import { describe, expect, it } from "vitest";
import { exampleWorldState } from "./fixtures/example-world";
import { checkInvariants, jsonSafetyViolations } from "./invariants";
import type { ItemId, TaskId } from "./types/ids";

describe("checkInvariants", () => {
  it("passes the W0 example world", () => {
    expect(checkInvariants(exampleWorldState())).toEqual([]);
  });

  it("flags JSON-unsafe values", () => {
    expect(
      jsonSafetyViolations({
        a: undefined,
        b: Number.NaN,
        c: -0,
        d: new Map(),
        e: [Number.POSITIVE_INFINITY],
      }),
    ).toEqual([
      "state.a is undefined",
      "state.b is NaN",
      "state.c is -0",
      "state.d is a Map",
      "state.e[0] is Infinity",
    ]);
  });

  it("flags items with a missing holder, containment cycles and bad counts", () => {
    const state = exampleWorldState();
    const i1 = "i1" as ItemId;
    const i2 = "i2" as ItemId;
    const item1 = state.items[i1];
    const item2 = state.items[i2];
    if (item1 === undefined || item2?.stacking !== "stack") throw new Error("fixture changed");
    item1.location = { kind: "inContainer", containerId: i2 };
    item2.location = { kind: "inContainer", containerId: i1 };
    item2.count = -1;
    const violations = checkInvariants(state);
    expect(violations).toContain("items.i1 is in a containment cycle");
    expect(violations).toContain("items.i2.count is -1");
    item1.location = { kind: "carriedBy", actorId: "a9" as never };
    expect(checkInvariants(state)).toContain("items.i1 is held by missing actor a9");
  });

  it("flags reused IDs, bad money, dangling decisions and task cycles", () => {
    const state = exampleWorldState();
    state.nextId = { ...state.nextId, item: 2 };
    state.money.balance = 1.5;
    state.decisions.queue.push("x9" as never);
    const t1 = "t1" as TaskId;
    const task = state.work.tasks[t1];
    if (task === undefined) throw new Error("fixture changed");
    task.dependencyIds = [t1];
    const violations = checkInvariants(state);
    expect(violations).toContain("items.i2 is not below nextId.item (2)");
    expect(violations).toContain("money.balance is 1.5");
    expect(violations).toContain("decisions.queue names missing decision x9");
    expect(violations).toContain("work.tasks has a dependency cycle through t1");
  });
});
