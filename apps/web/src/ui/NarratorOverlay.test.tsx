import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NarratorOverlay } from "./NarratorOverlay";

describe("NarratorOverlay", () => {
  it("shows the plain thinking text on the first attempt", () => {
    const html = renderToStaticMarkup(<NarratorOverlay />);
    expect(html).toContain("The narrator is thinking…");
    expect(html).not.toContain("retrying");
  });

  it("shows the attempt while retrying (D43)", () => {
    const html = renderToStaticMarkup(<NarratorOverlay attempt={3} />);
    expect(html).toContain("The narrator is thinking… (retrying, attempt 3)");
  });
});
