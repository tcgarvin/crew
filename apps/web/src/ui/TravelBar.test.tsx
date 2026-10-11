import type { TravelStage } from "@crew/sim";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TravelBar } from "./TravelBar";

describe("TravelBar", () => {
  it("is hidden while docked, at a port or set down at a site", () => {
    expect(renderToStaticMarkup(<TravelBar stage="docked" progress={0.5} />)).toBe("");
  });

  it("runs through every stage under way, setting down at a site and lifting off included", () => {
    const stages: readonly TravelStage[] = [
      "preparingDeparture",
      "undocking",
      "departing",
      "transit",
      "approaching",
      "docking",
    ];
    for (const stage of stages) {
      const html = renderToStaticMarkup(<TravelBar stage={stage} progress={0.25} />);
      expect(html).toContain('class="travel-bar-fill" style="width:25%"');
    }
  });

  it("clamps its progress", () => {
    expect(renderToStaticMarkup(<TravelBar stage="transit" progress={1.4} />)).toContain(
      "width:100%",
    );
    expect(renderToStaticMarkup(<TravelBar stage="transit" progress={-1} />)).toContain("width:0%");
  });
});
