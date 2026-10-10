import { describe, expect, it } from "vitest";
import { FIXTURE_EXPEDITION } from "../../core/fixtures/ship-life";
import type { Combatant } from "../../core/types/actor";
import type { SiteCastEntryDef } from "../../core/types/content";
import { dispositionOf, initialState, intervalDelta, shiftResolve } from "./morale";

const config = { expedition: FIXTURE_EXPEDITION };
const morale = FIXTURE_EXPEDITION.morale;

const guard = (resolve: SiteCastEntryDef["resolve"], tie: SiteCastEntryDef["tie"]) =>
  dispositionOf(
    {
      name: "G",
      role: "guard",
      look: "a guard",
      part: "guard",
      arms: "blaster",
      resolve,
      tie,
      wants: "money",
      post: "door",
    },
    config,
  );

function combatant(resolve: number): Combatant {
  return {
    side: "them",
    disposition: guard("steady", "bound"),
    state: initialState(resolve, morale),
    resolve,
    lastDecidedTick: 0,
  };
}

describe("morale (§8.2)", () => {
  it("starts the shaky wavering and the steady steady (ruling 7)", () => {
    expect(initialState(guard("shaky", "paid").resolveBase, morale)).toBe("wavering");
    expect(guard("shaky", "paid").resolveBase).toBeCloseTo(0.36);
    expect(initialState(guard("steady", "paid").resolveBase, morale)).toBe("steady");
    expect(guard("hard", "devoted").resolveBase).toBe(1);
  });

  it("wavers, breaks, and recovers from wavering only above recoverAbove", () => {
    const c = combatant(0.7);
    expect(shiftResolve(c, -0.25, morale)).toBe(false);
    expect(c.state).toBe("wavering");
    shiftResolve(c, 0.1, morale);
    expect(c.state).toBe("wavering");
    shiftResolve(c, 0.2, morale);
    expect(c.state).toBe("steady");
    expect(shiftResolve(c, -0.6, morale)).toBe(true);
    expect(c.state).toBe("breaking");
    shiftResolve(c, 1, morale);
    expect(c.state).toBe("breaking");
  });

  it("breaks a paid guard before a devoted one under the same fire", () => {
    const paid = combatant(guard("steady", "paid").resolveBase);
    const devoted = combatant(guard("steady", "devoted").resolveBase);
    const fire = intervalDelta(
      { underFire: true, inCover: false, outnumbered: true, leaderNear: false },
      1,
      morale,
    );
    let paidBroke: number | undefined;
    let devotedBroke: number | undefined;
    for (let second = 1; second <= 60; second++) {
      if (shiftResolve(paid, fire, morale)) paidBroke = second;
      if (shiftResolve(devoted, fire, morale)) devotedBroke = second;
    }
    expect(paidBroke).toBeDefined();
    expect(devotedBroke).toBeDefined();
    expect(paidBroke ?? 0).toBeLessThan(devotedBroke ?? 0);
  });

  it("steadies someone in cover with the leader near", () => {
    expect(
      intervalDelta(
        { underFire: true, inCover: true, outnumbered: false, leaderNear: true },
        2,
        morale,
      ),
    ).toBeCloseTo(2 * (morale.inCoverPerSecond + morale.leaderNearPerSecond));
  });
});
