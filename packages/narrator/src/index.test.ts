import { describe, expect, it } from "vitest";
import { NARRATOR_PLACEHOLDER } from "./index";

describe("@crew/narrator placeholder", () => {
  it("exposes the placeholder content schema", () => {
    expect(NARRATOR_PLACEHOLDER.schema.parse({ id: "abc" })).toEqual({ id: "abc" });
  });
});
