import { describe, expect, it } from "vitest";
import { CORE_PLACEHOLDER } from "./index";

describe("@crew/sim placeholder", () => {
  it("exports a core placeholder", () => {
    expect(CORE_PLACEHOLDER).toBe("core");
  });
});
