import { describe, expect, it } from "vitest";
import {
  type IdHost,
  allocateId,
  asInstanceId,
  initialIdCounters,
  isInstanceIdOf,
  parseInstanceId,
  wasAllocated,
} from "./ids";

describe("ids", () => {
  it("allocates prefixed, increasing, never-reused IDs per kind", () => {
    const host: IdHost = { nextId: initialIdCounters() };
    expect(allocateId(host, "actor")).toBe("a1");
    expect(allocateId(host, "actor")).toBe("a2");
    expect(allocateId(host, "claim")).toBe("l1");
    expect(allocateId(host, "actor")).toBe("a3");
    expect(host.nextId.actor).toBe(4);
    expect(host.nextId.item).toBe(1);
  });

  it("keeps counting after a JSON round-trip", () => {
    const host: IdHost = { nextId: initialIdCounters() };
    allocateId(host, "item");
    const copy = JSON.parse(JSON.stringify(host)) as IdHost;
    expect(allocateId(copy, "item")).toBe("i2");
  });

  it("parses and brands IDs", () => {
    expect(parseInstanceId("m12")).toEqual({ kind: "machine", counter: 12 });
    expect(parseInstanceId("e3")).toEqual({ kind: "event", counter: 3 });
    expect(parseInstanceId("q1")).toBeNull();
    expect(parseInstanceId("a0")).toBeNull();
    expect(parseInstanceId("a1x")).toBeNull();
    expect(isInstanceIdOf("door", "d4")).toBe(true);
    expect(isInstanceIdOf("door", "a4")).toBe(false);
    expect(asInstanceId("hook", "k2")).toBe("k2");
    expect(() => asInstanceId("hook", "a2")).toThrow(/not a hook ID/);
  });

  it("knows which IDs a host has allocated", () => {
    const host: IdHost = { nextId: initialIdCounters() };
    const id = allocateId(host, "task");
    expect(wasAllocated(host, id)).toBe(true);
    expect(wasAllocated(host, asInstanceId("task", "t2"))).toBe(false);
  });

  it("rejects a corrupt counter", () => {
    const host: IdHost = { nextId: { ...initialIdCounters(), job: Number.NaN } };
    expect(() => allocateId(host, "job")).toThrow(/corrupt/);
  });
});
