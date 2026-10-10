import type { ConfigDef } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { loadWebContent } from "../worker/content";
import { type ClockSection, clockSections, sectionName, shipClock } from "./clock";

const { bundle, config, scenarioId } = loadWebContent();
const values: ConfigDef = config.values;
const watchTicks = (values.time.daySeconds / values.time.watchesPerDay) * values.time.tickRate;
const dayTicks = values.time.daySeconds * values.time.tickRate;

const SECTIONS: readonly ClockSection[] = [
  { key: "red", names: ["Noor Haddad", "Mara Osei"] },
  { key: "white", names: ["Jax Okonkwo", "Tomas Ruiz"] },
  { key: "blue", names: ["Dane Whitcross"] },
];

describe("the ship's clock (§the-ships-day, §the-bell)", () => {
  it("starts on day 1 in the first section's watch", () => {
    expect(shipClock(0, values, SECTIONS).text).toBe("Day 1 · Red watch");
  });

  it("changes watch at the bell and day after the last watch", () => {
    expect(shipClock(watchTicks - 1, values, SECTIONS).watch).toBe("Red watch");
    expect(shipClock(watchTicks, values, SECTIONS).watch).toBe("White watch");
    expect(shipClock(2 * watchTicks, values, SECTIONS).text).toBe("Day 1 · Blue watch");
    expect(shipClock(dayTicks, values, SECTIONS).text).toBe("Day 2 · Red watch");
    expect(shipClock(dayTicks + watchTicks, values, SECTIONS).text).toBe("Day 2 · White watch");
  });

  it("has a short form for the narrowest phones' top bar", () => {
    expect(shipClock(watchTicks, values, SECTIONS).watchShort).toBe("White");
    expect(shipClock(2 * watchTicks, values, SECTIONS.slice(0, 2)).watchShort).toBe("Watch 3");
  });

  it("numbers a watch no section stands", () => {
    expect(shipClock(2 * watchTicks, values, SECTIONS.slice(0, 2)).watch).toBe("Watch 3");
    expect(shipClock(0, values, []).whoIsOn).toBe("Watch 1: no section stands it");
  });

  it("says who is on and how long the game has run, for the tooltip", () => {
    expect(shipClock(watchTicks, values, SECTIONS).whoIsOn).toBe(
      "White watch: Jax Okonkwo, Tomas Ruiz",
    );
    expect(shipClock(65 * values.time.tickRate, values, SECTIONS).elapsed).toBe("1:05");
  });

  it("reads playback's interpolated, fractional view tick as the whole tick", () => {
    expect(shipClock(watchTicks - 0.5, values, SECTIONS).watch).toBe("Red watch");
  });
});

describe("clockSections", () => {
  it("names the authored bill's sections in order, with their members", () => {
    const sections = clockSections(bundle, scenarioId);
    expect(sections.map((s) => s.key)).toEqual(["red", "white", "blue"]);
    expect(sections[1]?.names).toEqual(["Jax Okonkwo", "Tomas Ruiz"]);
  });

  it("capitalises a section key", () => {
    expect(sectionName("white")).toBe("White");
  });
});
