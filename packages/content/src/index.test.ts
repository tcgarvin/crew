import { describe, expect, it } from "vitest";
import { placeholderSchema } from "./index";

describe("@crew/content placeholder schema", () => {
  it("validates an object with an id", () => {
    expect(placeholderSchema.parse({ id: "abc" })).toEqual({ id: "abc" });
  });
});
