import { describe, expect, it } from "vitest";
import { actorDotColor } from "./draw";

describe("actorDotColor", () => {
  it("draws passengers in a different colour from crew", () => {
    expect(actorDotColor({ passenger: true })).not.toBe(actorDotColor({ passenger: false }));
  });
});
