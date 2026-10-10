/**
 * Expeditions A1 (W2): the fight at the Boathouse on the real content and the full registry. Bounds
 * over a few seeds, never one fight's events: `hold` and `assault` end differently (the target
 * slips out along the jetty past a party that holds; an assault takes him, sooner), nobody dies
 * often, every fight resolves, and `creep` against a shaky cast takes the target unnoticed.
 */
import { describe, expect, it } from "vitest";
import { type FightRecord, runFight } from "./expedition-fight-fixture";

const SEEDS = [1, 2, 3];

const fights = (plan: string, cast: "default" | "shaky" = "default"): FightRecord[] =>
  SEEDS.map((seed) => runFight(plan, seed, { cast }));

const mean = (values: readonly number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const share = (records: readonly FightRecord[], outcome: string) =>
  records.filter((r) => r.outcome === outcome).length / records.length;

describe("the fight at the Boathouse (expeditions A1)", () => {
  it("plays hold and assault differently, resolves every fight, and kills nobody often", () => {
    const hold = fights("hold-lethal-armed");
    const assault = fights("assault-lethal-armed");
    for (const record of [...hold, ...assault]) {
      expect(["targetTaken", "targetFled"]).toContain(record.outcome);
      expect(record.toContact).toBeDefined();
    }
    expect(share(hold, "targetFled")).toBeGreaterThanOrEqual(2 / 3);
    expect(share(assault, "targetTaken")).toBeGreaterThanOrEqual(2 / 3);
    expect(mean(assault.map((r) => r.seconds))).toBeLessThan(mean(hold.map((r) => r.seconds)));
    expect(mean([...hold, ...assault].map((r) => r.deadUs))).toBeLessThanOrEqual(0.25);
    for (const record of hold) {
      const world = record.world;
      expect(world.state.alert?.cause).toBe("fight");
      expect(Object.values(world.state.actors).some((a) => a.combatant?.side === "us")).toBe(false);
    }
  }, 60_000);

  it("takes the target unnoticed by creeping in on a shaky cast", () => {
    const creep = fights("creep-lethal-armed", "shaky");
    expect(creep.filter((r) => r.quiet).length / creep.length).toBeGreaterThanOrEqual(0.5);
    expect(share(creep, "targetTaken")).toBeGreaterThanOrEqual(0.5);
  }, 60_000);
});
