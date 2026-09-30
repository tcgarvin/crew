import { describe, expect, it } from "vitest";
import { type RngHost, createRngApi, seedAllStreams, seedStream } from "./rng";

function host(seed: number): RngHost {
  return { seed, rng: seedAllStreams(seed) };
}

describe("rng", () => {
  it("yields a fixed sequence for a fixed seed", () => {
    const a = createRngApi(host(7));
    const b = createRngApi(host(7));
    const seqA = Array.from({ length: 5 }, () => a.float("setup"));
    const seqB = Array.from({ length: 5 }, () => b.float("setup"));
    expect(seqA).toEqual(seqB);
    for (const value of seqA) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    expect(new Set(seqA).size).toBe(5);
  });

  it("different seeds give different sequences", () => {
    expect(seedStream(1, "setup")).not.toEqual(seedStream(2, "setup"));
  });

  it("streams are independent: drawing from one does not move another", () => {
    const h = host(3);
    const rng = createRngApi(h);
    const failuresBefore = h.rng.failures;
    for (let i = 0; i < 10; i++) rng.float("setup");
    expect(h.rng.failures).toEqual(failuresBefore);
    expect(seedStream(3, "setup")).not.toEqual(seedStream(3, "failures"));
  });

  it("advances state in place and resumes identically after a JSON round-trip", () => {
    const h = host(11);
    const rng = createRngApi(h);
    const initial = h.rng.social;
    rng.float("social");
    expect(h.rng.social).not.toEqual(initial);

    const copy = JSON.parse(JSON.stringify(h)) as RngHost;
    const fromCopy = createRngApi(copy);
    expect(fromCopy.float("social")).toBe(rng.float("social"));
    expect(fromCopy.int("social", 0, 1000)).toBe(rng.int("social", 0, 1000));
  });

  it("int, pick, chance and weighted respect their ranges", () => {
    const rng = createRngApi(host(5));
    for (let i = 0; i < 200; i++) {
      const n = rng.int("setup", -2, 2);
      expect(Number.isInteger(n) && n >= -2 && n <= 2).toBe(true);
    }
    expect(["x", "y"]).toContain(rng.pick("setup", ["x", "y"]));
    expect(rng.chance("setup", 0)).toBe(false);
    expect(rng.chance("setup", 1)).toBe(true);
    const picks = new Set<string>();
    for (let i = 0; i < 50; i++) {
      picks.add(
        rng.weighted("setup", [
          { item: "never", weight: 0 },
          { item: "a", weight: 1 },
          { item: "b", weight: 3 },
        ]),
      );
    }
    expect(picks.has("never")).toBe(false);
    expect(() => rng.pick("setup", [])).toThrow(RangeError);
    expect(() => rng.weighted("setup", [{ item: 1, weight: 0 }])).toThrow(RangeError);
    expect(() => rng.int("setup", 3, 1)).toThrow(RangeError);
  });

  it("keyedFloat is stable per key/counter and does not advance the stream", () => {
    const h = host(9);
    const rng = createRngApi(h);
    const before = h.rng.failures;
    const first = rng.keyedFloat("failures", "m4", 0);
    expect(rng.keyedFloat("failures", "m4", 0)).toBe(first);
    expect(rng.keyedFloat("failures", "m4", 1)).not.toBe(first);
    expect(rng.keyedFloat("failures", "m5", 0)).not.toBe(first);
    expect(h.rng.failures).toEqual(before);
  });
});
