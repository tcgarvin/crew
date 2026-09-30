import { describe, expect, it } from "vitest";
import { crew } from "./index";

describe("crew CLI placeholder", () => {
  it("reports when no command is given", () => {
    expect(crew([])).toContain("no command given");
  });

  it("reports unknown commands", () => {
    expect(crew(["fly"])).toContain('unknown command "fly"');
  });
});
