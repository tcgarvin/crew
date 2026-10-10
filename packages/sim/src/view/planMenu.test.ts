import { describe, expect, it } from "vitest";
import type { ActorId } from "../core/types/ids";
import { SITE, siteWorld } from "../systems/expedition/fixtures/site";
import { CREW } from "../systems/work/fixtures/crew-deck";
import { PLAN_MENU_SIZE, planMenu } from "./planMenu";

describe("planMenu (§8.4)", () => {
  it("offers the default pair first, at most eight, with unique ids", () => {
    const { world } = siteWorld({ scenario: CREW.scenario8 });
    const menu = planMenu(world.state, world.content, world.config.values, SITE.port);
    expect(menu.length).toBeLessThanOrEqual(PLAN_MENU_SIZE);
    expect(menu.slice(0, 2).map((o) => o.id)).toEqual([
      "hold-lethal-armed",
      "assault-lethal-armed",
    ]);
    expect(new Set(menu.map((o) => o.id)).size).toBe(menu.length);
    expect(menu.map((o) => o.id)).toContain("assault-stun-armed");
    for (const option of menu) expect(option.why.length).toBeGreaterThan(0);
  });

  it("marks flank unavailable with three fit, and says why", () => {
    const { world } = siteWorld({ scenario: CREW.scenario8 });
    const actors = Object.values(world.state.actors).filter((a) => a.crew);
    for (const actor of actors.slice(3)) actor.availability = "incapacitated";
    const menu = planMenu(world.state, world.content, world.config.values, SITE.port);
    const flank = menu.find((o) => o.plan.posture === "flank");
    expect(flank?.available).toBe(false);
    expect(flank?.why).toMatch(/flank needs four fit people: only \d would go/);
    expect(menu.find((o) => o.id === "hold-lethal-armed")?.available).toBe(true);
  });

  it("takes creep and bait off once the cast have seen the party", () => {
    const { world } = siteWorld({ scenario: CREW.scenario8 });
    world.state.expedition = {
      siteId: SITE.port,
      phase: "fight",
      party: ["a1" as ActorId],
      leaderId: "a1" as ActorId,
      startedTick: 0,
      shots: 0,
    };
    const menu = planMenu(world.state, world.content, world.config.values);
    for (const option of menu.filter((o) => ["creep", "bait"].includes(o.plan.posture))) {
      expect(option.available).toBe(false);
      expect(option.why).toMatch(/already seen you/);
    }
  });
});
