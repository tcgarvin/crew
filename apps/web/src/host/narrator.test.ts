import type { HookId, NarratorCommand, NarratorHook, SimEvent } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { appendRecentEvents, hookAnswer } from "./narrator";
import { newerSave } from "./saves";

const HOOK = {
  id: "k1" as HookId,
  kind: "quietTooLong",
  context: { quietSinceTick: 0 },
  tick: 40,
} as NarratorHook;

describe("hookAnswer", () => {
  it("acknowledges the hook at hook tick + 1 even with no narrator reply", () => {
    const commands = hookAnswer(HOOK, 40, undefined);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      kind: "acknowledgeHook",
      source: "system",
      payload: { hookId: "k1" },
      targetTick: 41,
    });
  });

  it("forwards the narrator's commands first, retargeted, then acknowledges", () => {
    const narratorCommand = {
      id: "cmd:narrator:c1:0",
      source: "narrator",
      kind: "scheduleFault",
      payload: {},
      targetTick: 999,
    } as unknown as NarratorCommand;
    const commands = hookAnswer(HOOK, 40, { commands: [narratorCommand] });
    expect(commands.map((c) => c.kind)).toEqual(["scheduleFault", "acknowledgeHook"]);
    expect(commands.every((c) => c.targetTick === 41)).toBe(true);
  });
});

describe("appendRecentEvents", () => {
  it("keeps notable and narrative events only, capped oldest-first", () => {
    const buffer: SimEvent[] = [];
    const ev = (n: number, significance: string) => ({ tick: n, significance }) as SimEvent;
    appendRecentEvents(buffer, [ev(1, "trace"), ev(2, "notable"), ev(3, "narrative")], 10);
    expect(buffer.map((e) => e.tick)).toEqual([2, 3]);
    appendRecentEvents(buffer, [ev(4, "notable"), ev(5, "notable")], 3);
    expect(buffer.map((e) => e.tick)).toEqual([3, 4, 5]);
  });
});

describe("newerSave", () => {
  const save = (savedAtTick: number) => ({ savedAtTick }) as never;
  it("prefers the server save when it is at least as new as the local one", () => {
    expect(newerSave(save(10), save(20))).toEqual(save(20));
    expect(newerSave(save(20), save(10))).toEqual(save(20));
    expect(newerSave(undefined, save(5))).toEqual(save(5));
    expect(newerSave(save(5), undefined)).toEqual(save(5));
    expect(newerSave(undefined, undefined)).toBeUndefined();
  });
});
