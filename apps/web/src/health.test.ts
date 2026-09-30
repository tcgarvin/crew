import { describe, expect, it } from "vitest";
import { describeHealth } from "./health";

describe("describeHealth", () => {
  it("reports ok when the response is ok", () => {
    expect(describeHealth({ ok: true })).toBe("ok");
  });

  it("reports error when the response is not ok", () => {
    expect(describeHealth({ ok: false })).toBe("error");
  });
});
