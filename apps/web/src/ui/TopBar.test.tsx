/**
 * §sighting-and-the-alert, §hull-scars-and-ship-loss: the hull bar beside the ship's clock, and the
 * alert's tint and bell line.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HullBar, TopBar, type TopBarProps, hullLevel, hullPercent } from "./TopBar";

const clock = {
  day: 2,
  watch: "White watch",
  watchShort: "White",
  text: "Day 2 · White watch",
  whoIsOn: "White watch: Jax Okonkwo",
  elapsed: "12:00",
};

function bar(overrides: Partial<TopBarProps>): string {
  const props: TopBarProps = {
    speed: 1,
    paused: false,
    onSetSpeed: () => {},
    onTogglePause: () => {},
    clock,
    hull: { integrity: 100, max: 100 },
    alert: false,
    money: 500,
    runAheadBufferedSeconds: 3,
    health: "ok",
    onNewGame: () => {},
    ...overrides,
  };
  return renderToStaticMarkup(<TopBar {...props} />);
}

describe("hull bar (§hull-scars-and-ship-loss)", () => {
  it("turns critical below a third of the hull", () => {
    expect(hullLevel(100, 100)).toBe("sound");
    expect(hullLevel(34, 100)).toBe("sound");
    expect(hullLevel(33, 100)).toBe("critical");
    expect(hullLevel(0, 100)).toBe("critical");
  });

  it("fills to the share of the hull left, within 0..100 %", () => {
    expect(hullPercent(71, 100)).toBe(71);
    expect(hullPercent(0, 100)).toBe(0);
    expect(hullPercent(50, 200)).toBe(25);
    expect(() => hullPercent(1, 0)).toThrow();
  });

  it("writes the points left, whole, on a meter", () => {
    const html = renderToStaticMarkup(<HullBar hull={{ integrity: 70.6, max: 100 }} />);
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="71"');
    expect(html).toContain(">71<");
    expect(html).toContain("width:70.6%");
    expect(html).toContain("hull-bar-sound");
  });

  it("sits in the top bar", () => {
    expect(bar({ hull: { integrity: 20, max: 100 } })).toContain("hull-bar-critical");
  });
});

describe("alert (§sighting-and-the-alert)", () => {
  it("tints the bar and reads ALERT in place of the watch", () => {
    const html = bar({ alert: true });
    expect(html).toContain("top-bar top-bar-alert");
    expect(html).toContain(">ALERT<");
    expect(html).not.toContain("White watch<");
    expect(html).toContain("Day 2");
  });

  it("shows the watch and no tint otherwise", () => {
    const html = bar({ alert: false });
    expect(html).not.toContain("top-bar-alert");
    expect(html).not.toContain("ALERT");
    expect(html).toContain("White watch");
  });
});
